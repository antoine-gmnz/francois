//! session/adapter/pi/normalize/mod.rs — pi-transcript-events FR-1..FR-9: the pure
//! reducer that turns Pi RPC transcript/tool events into the five
//! `TranscriptRuntimePayload` kinds (contract/common.ts, mirrored as
//! `RuntimeEventPayload`'s transcript variants in `session::events`) — first-
//! class assistant text, a complete generic tool-call lifecycle, and neutral
//! notices for anything that isn't renderable prose. No I/O, no session lock:
//! `TranscriptReducer::on_event` takes one already-decoded wire line (as a
//! `serde_json::Value`) and the caller's own clock reading, and returns the
//! (possibly empty) batch of `RuntimeEventPayload`s it produces — same shape
//! as `protocol::ProtocolEngine::on_line`/`LineOutcome`, split into its own
//! module because it answers a different question (transcript content, not
//! connection/run state) and is unit-tested the same way, with no process in
//! sight.
//!
//! **Provisional**, same honest caveat `wire.rs` and `protocol.rs` carry: no
//! real Pi RPC capture of these richer event kinds exists yet (specs/
//! research/pi-integration-audit.md). The FR table (spec §5) names the event
//! KINDS this module maps (`message_start`, `content_delta`, `text_end`,
//! `message_end`, `toolcall_start/delta/end`, `tool_execution_start/update/
//! end`, `compaction_start/end`, `retry`, `queue_update`) but not their wire
//! shapes, so the field names below (`messageId`, `contentIndex`, `delta`,
//! `toolCallId`, `inputDelta`, …) are this module's own best-effort mirror,
//! consistent with `wire.rs`'s existing `id`/`command`/`success` and `type`
//! conventions. Reconciled against a real capture once one exists.
//!
//! **Wired** (review round 1 fix): `dispatcher.rs`'s reader thread now feeds
//! every event-shaped line (`wire::looks_like_response` false) to
//! `TranscriptReducer::on_event` alongside `wire.rs`'s own narrow
//! `agent_settled`/`agent_end`/`turn_end`/unknown classification — the two
//! run side by side over the SAME line, one deciding run-state, this one
//! deciding transcript content. Its output rides the existing
//! `runtime.event` envelope (`EventPublisher::transcript`) and folds into the
//! session's own `block_buffer` in `runtime.rs::runtime_event` — see that
//! file's `transcript_persist_id`. `finalize_interrupted` runs once, from
//! `dispatcher.rs::finalize_transcript`, at every point the connection
//! reaches a terminal `LineOutcome` (EOF, a frame error, a write failure, a
//! timeout) or a protocol failure.
//!
//! Assumed shapes (all `type`-tagged like every other Pi frame):
//! ```text
//! {"type":"message_start","role":"user","messageId":"m1","text":"hi",
//!   "attachments"?:[{"id","name"?,"mimeType"?,"state"?}], "clientMessageId"?,
//!   "accepted"?:bool}                                    // FR-6: false ⇒ not yet in the transcript
//! {"type":"message_start","role":"assistant","messageId":"m2"}
//! {"type":"content_delta","messageId":"m2","contentIndex":0,
//!   "delta":{"type":"text"|"thinking"|"signature","text"?}}
//! {"type":"text_end","messageId":"m2","contentIndex":0}
//! {"type":"message_end","messageId":"m2","role"?:"assistant",
//!   "content"?:[{"type":"text"|"thinking"|"signature"|"tool_use","text"?}],
//!   "outcome"?:"complete"|"interrupted"|"error",
//!   "toolResult"?:{"toolCallId","isError","output"?}}
//! {"type":"toolcall_start","toolCallId":"t1","name":"Read"}
//! {"type":"toolcall_delta","toolCallId":"t1","inputDelta":"{\"path\":"}
//! {"type":"toolcall_end","toolCallId":"t1","input":"{\"path\":\"a.rs\"}"}
//! {"type":"tool_execution_start","toolCallId":"t1"}
//! {"type":"tool_execution_update","toolCallId":"t1","progress":"…"}
//! {"type":"tool_execution_end","toolCallId":"t1","isError":false,"output":"…"}
//! {"type":"compaction_start"} / {"type":"compaction_end"}
//! {"type":"retry","reason":"rate limited"}
//! {"type":"queue_update", …}                              // task 08: ignored here
//! ```
//! `agent_start`/`agent_end`/`agent_settled`/`turn_end` are recognized as
//! known-but-transcript-irrelevant (protocol.rs's job); everything else is a
//! "valid unknown event" (FR table) surfaced once per kind as a notice.

use crate::session::events::{RuntimeAttachmentRef, RuntimeEventPayload, RuntimeToolCall};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, VecDeque};

mod caps;
mod scrub;
mod tools;

use caps::{
    append_slot_text, set_slot_text, PROTOCOL_NOTICE_CAP, SLOTS_PER_MESSAGE_CAP, SLOT_TEXT_BYTES,
};
use scrub::{append_scrubbed_delta, bound_preview};

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn notice(tone: &str, text: &str) -> RuntimeEventPayload {
    RuntimeEventPayload::Notice {
        block_id: crate::ids::uuid(),
        tone: tone.into(),
        text: text.into(),
    }
}

/// pi-transcript-events (review remediation): `name`/`mimeType` bound + shared
/// diagnostic sanitizer — same rationale as `bound_preview` for tool text,
/// but these two fields are metadata, not content, so they get the smaller
/// `sanitize_diagnostic` bound rather than `PREVIEW_BYTES`.
const ATTACHMENT_FIELD_CHARS: usize = 500;

fn parse_attachments(v: Option<&Value>) -> Vec<RuntimeAttachmentRef> {
    let Some(arr) = v.and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?.to_string();
            let name = super::process::sanitize_diagnostic(
                item.get("name").and_then(Value::as_str).unwrap_or(""),
                ATTACHMENT_FIELD_CHARS,
            );
            let mime_type = super::process::sanitize_diagnostic(
                item.get("mimeType").and_then(Value::as_str).unwrap_or(""),
                ATTACHMENT_FIELD_CHARS,
            );
            // FR-7 edge case: an absent/unrecognized state defaults to
            // available — "missing" is only ever reported explicitly.
            let state = match item.get("state").and_then(Value::as_str) {
                Some("missing") => "missing",
                _ => "available",
            };
            Some(RuntimeAttachmentRef {
                id,
                name,
                mime_type,
                state: state.into(),
            })
        })
        .collect()
}

// ---------------------------------------------------------------- assistant text

#[derive(Clone, Copy, PartialEq, Eq)]
enum MessageRole {
    User,
    Assistant,
}

/// FR-2: one content-index slot inside an assistant message, with its own
/// stable blockId — text_end finalizes it, message_end reconciles every slot
/// in original content order (array position).
struct ContentSlot {
    block_id: String,
    text: String,
    /// FR-2: the UTF-16 length already streamed for this slot — the existing
    /// delta contract's offset unit (mirrors `session/stream/blocks.rs`'s
    /// `text_utf16` map), tracked incrementally so a chunk is never re-encoded.
    utf16_len: usize,
    ended: bool,
    /// FR-5: a thinking/signature slot notifies its neutral notice at most
    /// once, however many deltas it carries.
    notified_unsupported: bool,
    /// caps.rs: this slot hit [`SLOT_TEXT_BYTES`] and carries the truncation
    /// marker — it accepts no further text, and said so once.
    text_truncated: bool,
}

impl ContentSlot {
    fn new() -> Self {
        Self {
            block_id: crate::ids::uuid(),
            text: String::new(),
            utf16_len: 0,
            ended: false,
            notified_unsupported: false,
            text_truncated: false,
        }
    }
}

struct MessageState {
    /// contentIndex → slot, in original order (FR-2).
    slots: BTreeMap<u32, ContentSlot>,
    /// message_end has already been applied — FR-9's crash/stop sweep skips
    /// a message that settled normally, and a second message_end for the
    /// same id is treated as an idempotent upsert (edge cases §7) rather than
    /// re-finalized from scratch.
    finalized: bool,
    /// caps.rs: this message hit [`SLOTS_PER_MESSAGE_CAP`] and said so once.
    slots_capped: bool,
}

impl MessageState {
    fn new() -> Self {
        Self {
            slots: BTreeMap::new(),
            finalized: false,
            slots_capped: false,
        }
    }
}

// ---------------------------------------------------------------- tool calls

#[derive(Clone, Copy, PartialEq, Eq)]
enum ToolStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
}

impl ToolStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Unknown => "unknown",
        }
    }
}

/// FR-3/FR-4: one generic tool call's normalized lifecycle. `settled` is the
/// "exactly once" latch — `tool_execution_end` and a reconciling
/// `message_end.toolResult` both try to settle the same call, and only the
/// first wins (edge cases §7: "do not append a second tool row").
struct ToolState {
    block_id: String,
    name: String,
    status: ToolStatus,
    input_text: String,
    output_text: String,
    input_truncated: bool,
    output_truncated: bool,
    started_at: Option<u64>,
    completed_at: Option<u64>,
    settled: bool,
}

impl ToolState {
    fn to_call(&self, id: &str) -> RuntimeToolCall {
        RuntimeToolCall {
            id: id.to_string(),
            name: self.name.clone(),
            status: self.status.as_str().into(),
            input_text: self.input_text.clone(),
            output_text: self.output_text.clone(),
            input_truncated: self.input_truncated,
            output_truncated: self.output_truncated,
            started_at: self.started_at,
            completed_at: self.completed_at,
        }
    }
}

// ---------------------------------------------------------------- the reducer

/// FR-6: "core reducer owns ordered blocks, active content slots and
/// tool-call → block lookup" (spec §6). One instance per session/generation —
/// a reconnect (a new `ProtocolEngine`, same rationale as its
/// `unknown_notified` set) starts a fresh reducer, never carries state across.
#[derive(Default)]
pub(crate) struct TranscriptReducer {
    messages: HashMap<String, MessageState>,
    tools: HashMap<String, ToolState>,
    /// pi-transcript-events (review remediation): finalized message ids, in
    /// the order they finalized — `messages`/`tools` otherwise grow for the
    /// connection's lifetime (§6 "bounded ... as in transcript-scale"). A
    /// finalized entry keeps only its slot IDENTITIES (its text is released
    /// on finalization), which is what lets this window be wide.
    finalized_messages: VecDeque<String>,
    /// Same bookkeeping as `finalized_messages`, for `tools`.
    settled_tools: VecDeque<String>,
    /// MEDIUM (review round 7): the OPEN tier — ids that are still streaming
    /// and therefore still holding text. Eviction here SETTLES (never drops)
    /// the oldest, because a dropped open block would be stranded
    /// `streaming: true` forever. See caps.rs for the whole policy.
    open_messages: VecDeque<String>,
    /// Same, for tool calls with no result yet.
    open_tools: VecDeque<String>,
    /// FR-3 edge case: "valid unknown event" is notified once per kind, same
    /// rationale as `protocol::ProtocolEngine::unknown_notified` — bounded
    /// oldest-first (`UNKNOWN_KINDS_CAP`), since the kind strings come off
    /// the wire. A deque, not a set: at 64 entries a scan is cheaper than a
    /// second copy of every string.
    unknown_notified: VecDeque<String>,
    /// How many malformed-event notices this connection has already put in
    /// the transcript (`protocol_notice`).
    protocol_notices: usize,
}

/// pi-transcript-events (review remediation): same bound `block_buffer` uses
/// (`crate::session::TRANSCRIPT_BUFFER_CAP`) — reused rather than a second
/// magic number, since both exist for the same "don't grow forever" reason.
const REDUCER_STATE_CAP: usize = crate::session::TRANSCRIPT_BUFFER_CAP;

impl TranscriptReducer {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// FR-8/edge cases §7: a known event shape missing a mandatory field, or
    /// a frame that is not even a `{"type": "…"}` object — never a panic and
    /// never a silently-dropped block.
    ///
    /// MEDIUM (review round 7): this used to ride out as a `RuntimeFailure`,
    /// which `runtime.rs` applies to the SESSION (`status::ERROR` + an error
    /// message). One malformed field therefore made the whole session read as
    /// failed while its connection kept happily streaming — an unusable
    /// session on the strength of one bad event. The session-level failures
    /// are the ones that actually END the connection (`wire::FrameError`'s
    /// oversize/invalid-UTF-8 record — §7's "fails the connection explicitly"
    /// — a dead child, a dispatch failure), and those are `protocol.rs`'s to
    /// raise. What belongs HERE is what belongs in the transcript: an
    /// error-toned notice naming the protocol error, leaving the session
    /// usable — the treatment §3 already gives a failed tool ("visibly fails
    /// while the agent may continue").
    ///
    /// Bounded like every other child-driven diagnostic: past
    /// `PROTOCOL_NOTICE_CAP` a wire that is malformed on every line is one
    /// fault, not ten thousand transcript blocks, and one last notice says so.
    fn protocol_notice(&mut self, reason: &str) -> Vec<RuntimeEventPayload> {
        self.protocol_notices += 1;
        match self.protocol_notices.cmp(&PROTOCOL_NOTICE_CAP) {
            std::cmp::Ordering::Greater => Vec::new(),
            std::cmp::Ordering::Equal => vec![notice(
                "error",
                "Further Pi protocol errors are not shown for this connection.",
            )],
            std::cmp::Ordering::Less => {
                let sanitized = super::process::sanitize_diagnostic(reason, 200);
                let message = if sanitized.trim().is_empty() {
                    "malformed Pi transcript event".to_string()
                } else {
                    sanitized
                };
                vec![notice("error", &format!("Pi protocol error: {message}"))]
            }
        }
    }

    /// Insert-if-absent, noting the id in the OPEN tier the first time —
    /// which is what may evict (and settle) the oldest open message. The
    /// eviction's own events ride back on `events`, since the caller is
    /// mid-batch and this must never take a second borrow of `self.messages`.
    fn ensure_message(&mut self, message_id: &str, events: &mut Vec<RuntimeEventPayload>) {
        if self.messages.contains_key(message_id) {
            return;
        }
        self.messages
            .insert(message_id.to_string(), MessageState::new());
        events.extend(self.note_message_opened(message_id));
    }

    /// FR-1: react to one already-framed, already-decoded Pi transcript
    /// event. `now_ms` is the caller's own clock reading (kept out of this
    /// pure module, same reasoning `RuntimeEventSequence::next` in events.rs
    /// takes its own `at` as a parameter rather than reading a clock itself).
    pub(crate) fn on_event(&mut self, raw: &Value, now_ms: u64) -> Vec<RuntimeEventPayload> {
        let Some(kind) = raw
            .get("type")
            .and_then(Value::as_str)
            .filter(|k| !k.is_empty())
        else {
            return self.protocol_notice("Pi transcript event is missing its type");
        };
        match kind {
            "message_start" => self.on_message_start(raw),
            "content_delta" => self.on_content_delta(raw),
            "text_end" => self.on_text_end(raw),
            "message_end" => self.on_message_end(raw, now_ms),
            "toolcall_start" => self.on_toolcall_start(raw, now_ms),
            "toolcall_delta" => self.on_toolcall_delta(raw),
            "toolcall_end" => self.on_toolcall_end(raw),
            "tool_execution_start" => self.on_tool_execution_start(raw, now_ms),
            "tool_execution_update" => self.on_tool_execution_update(raw),
            "tool_execution_end" => self.on_tool_execution_end(raw, now_ms),
            "compaction_start" => vec![notice("info", "Compacting the conversation\u{2026}")],
            "compaction_end" => vec![notice("info", "Compaction complete.")],
            "retry" => self.on_retry(raw),
            // task 08 owns queue_update's pending-intent state (not transcript
            // text, per the FR table); agent_start/agent_end/agent_settled/
            // turn_end are run-state boundaries protocol.rs already owns.
            "queue_update" | "agent_start" | "agent_end" | "agent_settled" | "turn_end" => {
                Vec::new()
            }
            other => self.on_unknown(other),
        }
    }

    /// FR-9: crash/stop — finalize every still-open assistant slot as
    /// `interrupted` (never re-completed as `complete`) and settle every
    /// non-settled tool call as `cancelled` (never started executing) or
    /// `unknown` (was mid-execution), never `succeeded`. Idempotent: calling
    /// this twice emits nothing the second time.
    ///
    /// Drains the OPEN tiers, which hold exactly the unfinalized/unsettled
    /// ids (caps.rs keeps them in sync) — so the sweep is in arrival order
    /// rather than `HashMap` order, and shares its per-id settling with the
    /// bound's own eviction.
    pub(crate) fn finalize_interrupted(&mut self, now_ms: u64) -> Vec<RuntimeEventPayload> {
        let mut events = Vec::new();
        for id in std::mem::take(&mut self.open_messages) {
            events.extend(self.interrupt_message(&id));
        }
        for id in std::mem::take(&mut self.open_tools) {
            events.extend(self.interrupt_tool(&id, now_ms));
        }
        events
    }

    // ---------------------------------------------------------- assistant text

    fn on_message_start(&mut self, raw: &Value) -> Vec<RuntimeEventPayload> {
        let Some(message_id) = str_field(raw, "messageId") else {
            return self.protocol_notice("message_start is missing messageId");
        };
        let role = match raw.get("role").and_then(Value::as_str) {
            Some("assistant") => MessageRole::Assistant,
            Some("user") => MessageRole::User,
            _ => return self.protocol_notice("message_start has an invalid role"),
        };
        if role == MessageRole::Assistant {
            let message_id = message_id.to_string();
            let mut events = Vec::new();
            self.ensure_message(&message_id, &mut events);
            return events;
        }
        // FR-1: "message_start user | message.user only when accepted into
        // actual conversation" — a still-queued prompt (FR-6) emits nothing.
        if raw.get("accepted").and_then(Value::as_bool) == Some(false) {
            return Vec::new();
        }
        let Some(text) = str_field(raw, "text") else {
            return self.protocol_notice("message_start (user) is missing text");
        };
        vec![RuntimeEventPayload::MessageUser {
            block_id: crate::ids::uuid(),
            text: text.to_string(),
            attachments: parse_attachments(raw.get("attachments")),
            client_message_id: str_field(raw, "clientMessageId").map(String::from),
        }]
    }

    fn on_content_delta(&mut self, raw: &Value) -> Vec<RuntimeEventPayload> {
        let Some(message_id) = str_field(raw, "messageId") else {
            return self.protocol_notice("content_delta is missing messageId");
        };
        let Some(content_index) = raw.get("contentIndex").and_then(Value::as_u64) else {
            return self.protocol_notice("content_delta is missing contentIndex");
        };
        // LOW (review round 2): an out-of-range wire value must fail
        // explicitly rather than silently truncate into a colliding slot.
        let Ok(content_index) = u32::try_from(content_index) else {
            return self.protocol_notice("content_delta contentIndex is out of range");
        };
        let Some(delta) = raw.get("delta") else {
            return self.protocol_notice("content_delta is missing delta");
        };
        let Some(delta_kind) = delta.get("type").and_then(Value::as_str) else {
            return self.protocol_notice("content_delta's delta is missing type");
        };
        let text = match delta_kind {
            "text" => match delta.get("text").and_then(Value::as_str) {
                Some(text) => text,
                None => return self.protocol_notice("content_delta text is missing its text"),
            },
            "thinking" | "signature" => "",
            // An unrecognized delta shape inside an otherwise-known event —
            // bounded, no speculative capability grown for it.
            _ => return Vec::new(),
        };
        if delta_kind == "text" && text.is_empty() {
            return Vec::new();
        }

        let message_id = message_id.to_string();
        let mut events = Vec::new();
        self.ensure_message(&message_id, &mut events);
        let message = self
            .messages
            .get_mut(&message_id)
            .expect("ensure_message inserted it and only evicts OLDER ids");

        // HIGH (review round 2): a late delta must never reopen a finalized
        // assistant block with no new assistant.complete — same "settle/
        // finalize once" guard the tool reducer already enforces on `settled`.
        if message.finalized {
            return events;
        }
        // caps.rs: a stream that keeps inventing content indices is bounded
        // here. Refused, not evicted — a slot's blockId is a live block
        // identity (FR-6), so evicting one would orphan a rendered block.
        if !message.slots.contains_key(&content_index)
            && message.slots.len() >= SLOTS_PER_MESSAGE_CAP
        {
            if !message.slots_capped {
                message.slots_capped = true;
                events.push(notice(
                    "warning",
                    &format!("This message has more than {SLOTS_PER_MESSAGE_CAP} content blocks; the rest are not shown."),
                ));
            }
            return events;
        }
        let slot = message
            .slots
            .entry(content_index)
            .or_insert_with(ContentSlot::new);

        match delta_kind {
            "text" => {
                if slot.ended {
                    return events;
                }
                // FR-2: UTF-16 offset — the length already streamed BEFORE
                // this chunk, tracked incrementally (never re-encoding the
                // whole accumulated text).
                let offset = slot.utf16_len;
                // caps.rs: what was ACTUALLY appended (the chunk, or its head
                // plus the truncation marker) is what rides out, so the
                // rendered block and this slot never disagree.
                let (appended, just_truncated) = append_slot_text(slot, text);
                if appended.is_empty() {
                    return events;
                }
                slot.utf16_len += appended.encode_utf16().count();
                let block_id = slot.block_id.clone();
                events.push(RuntimeEventPayload::AssistantDelta {
                    block_id,
                    content_index,
                    text: appended,
                    offset,
                });
                if just_truncated {
                    events.push(notice(
                        "warning",
                        &format!(
                            "This message exceeded {} KiB and was truncated.",
                            SLOT_TEXT_BYTES / 1024
                        ),
                    ));
                }
                events
            }
            // FR-5: thinking/signature content is never rendered as assistant
            // prose — a neutral notice instead, once per slot.
            _ => {
                if slot.notified_unsupported {
                    return events;
                }
                slot.notified_unsupported = true;
                events.push(notice(
                    "info",
                    &format!("{delta_kind} content is not shown"),
                ));
                events
            }
        }
    }

    fn on_text_end(&mut self, raw: &Value) -> Vec<RuntimeEventPayload> {
        let (Some(message_id), Some(content_index)) = (
            str_field(raw, "messageId"),
            raw.get("contentIndex").and_then(Value::as_u64),
        ) else {
            return self.protocol_notice("text_end is missing messageId/contentIndex");
        };
        // MEDIUM (review round 3): mirror `on_content_delta`'s guard — an
        // out-of-range wire value must fail explicitly rather than silently
        // wrap into a colliding slot.
        let Ok(content_index) = u32::try_from(content_index) else {
            return self.protocol_notice("text_end contentIndex is out of range");
        };
        let Some(message) = self.messages.get_mut(message_id) else {
            return Vec::new();
        };
        let Some(slot) = message.slots.get_mut(&content_index) else {
            return Vec::new();
        };
        if slot.ended {
            return Vec::new();
        }
        slot.ended = true;
        vec![RuntimeEventPayload::AssistantComplete {
            block_id: slot.block_id.clone(),
            text: slot.text.clone(),
            outcome: "complete".into(),
        }]
    }

    fn on_message_end(&mut self, raw: &Value, now_ms: u64) -> Vec<RuntimeEventPayload> {
        let Some(message_id) = str_field(raw, "messageId") else {
            return self.protocol_notice("message_end is missing messageId");
        };
        let role = match raw.get("role").and_then(Value::as_str) {
            None => MessageRole::Assistant,
            Some("assistant") => MessageRole::Assistant,
            Some("user") => MessageRole::User,
            Some(_) => return self.protocol_notice("message_end has an invalid role"),
        };
        let outcome = match raw.get("outcome").and_then(Value::as_str) {
            None => "complete",
            Some(o @ ("complete" | "interrupted" | "error")) => o,
            Some(_) => return self.protocol_notice("message_end has an invalid outcome"),
        };

        let message_id = message_id.to_string();
        let mut events = Vec::new();
        let mut malformed_content = false;

        if role == MessageRole::Assistant {
            // FR-2: "a final message replaces accumulated content
            // authoritatively" — reconciled in original content order, i.e.
            // the authoritative array's own position (edge cases §7: "Duplicate
            // final output: upsert" — a second message_end re-applies the same
            // authoritative content rather than being ignored).
            let content = raw
                .get("content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            self.ensure_message(&message_id, &mut events);
            let message = self
                .messages
                .get_mut(&message_id)
                .expect("ensure_message inserted it and only evicts OLDER ids");
            let was_finalized = message.finalized;
            // caps.rs: the authoritative array comes off ONE wire record (up
            // to `wire::MAX_RECORD_BYTES`), so it is bounded like any other
            // slot source — the tail past the cap is announced by the notice
            // the cap itself pushes below.
            let capped = content.len().min(SLOTS_PER_MESSAGE_CAP);
            if content.len() > capped && !message.slots_capped {
                message.slots_capped = true;
                events.push(notice(
                    "warning",
                    &format!("This message has more than {SLOTS_PER_MESSAGE_CAP} content blocks; the rest are not shown."),
                ));
            }
            for (i, item) in content.iter().take(capped).enumerate() {
                let content_index = i as u32;
                match item.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let Some(text) = item.get("text").and_then(Value::as_str) else {
                            malformed_content = true;
                            continue;
                        };
                        let slot = message
                            .slots
                            .entry(content_index)
                            .or_insert_with(ContentSlot::new);
                        // caps.rs: bounded like a streamed slot, and the
                        // STORED text is what rides out, so the block and the
                        // reducer never disagree about what was kept.
                        let (stored, truncated) = set_slot_text(slot, text);
                        slot.utf16_len = stored.encode_utf16().count();
                        slot.ended = true;
                        events.push(RuntimeEventPayload::AssistantComplete {
                            block_id: slot.block_id.clone(),
                            text: stored,
                            outcome: outcome.to_string(),
                        });
                        if truncated {
                            events.push(notice(
                                "warning",
                                &format!(
                                    "This message exceeded {} KiB and was truncated.",
                                    SLOT_TEXT_BYTES / 1024
                                ),
                            ));
                        }
                    }
                    Some(kind @ ("thinking" | "signature")) => {
                        let slot = message
                            .slots
                            .entry(content_index)
                            .or_insert_with(ContentSlot::new);
                        if !slot.notified_unsupported {
                            slot.notified_unsupported = true;
                            // LOW (review round 1): name the actual content
                            // kind, as `on_content_delta`'s own notice does,
                            // instead of always saying "Thinking".
                            events.push(notice("info", &format!("{kind} content is not shown")));
                        }
                    }
                    // 'tool_use' and anything else: the tool lifecycle events
                    // own that block; message_end names it only for ordering.
                    _ => {}
                }
            }
            // `content` is OPTIONAL, and authoritative only over what it
            // actually covers: absent entirely (the natural encoding for an
            // interrupted turn), shorter than the set of streamed slots, or
            // naming a `tool_use` at an index where text streamed. Any slot it
            // leaves out would otherwise be stranded by the `finalized = true`
            // below — no assistant.complete ever, so the block stays
            // `streaming: true` forever: never persisted (the text is lost on
            // reopen) and pinning `trim_transcript`, which is what lets the
            // buffer grow past its cap.
            //
            // A slot OPENED an assistant text block exactly when a text delta
            // appended to it: `on_content_delta` returns before creating a
            // slot for an empty text, and its thinking/signature branch never
            // touches `text` (that slot emitted the one "not shown" notice and
            // must not be completed as prose — FR-5). The WIRE outcome rides
            // verbatim: relabelling it would make every normal message read as
            // interrupted if Pi simply never echoes `content`.
            for slot in message.slots.values_mut() {
                if slot.ended || slot.text.is_empty() {
                    continue;
                }
                slot.ended = true;
                events.push(RuntimeEventPayload::AssistantComplete {
                    block_id: slot.block_id.clone(),
                    text: slot.text.clone(),
                    outcome: outcome.to_string(),
                });
            }
            message.finalized = true;
            // pi-transcript-events (review remediation): note the FIRST
            // finalization only — a duplicate final message_end (edge cases
            // §7's idempotent upsert) must not push a second eviction-order
            // entry for the same id.
            if !was_finalized {
                self.note_message_finalized(&message_id);
            }
        }

        if malformed_content {
            events.extend(self.protocol_notice("message_end content item is missing text"));
        }

        // FR-1/edge cases §7: "reconcile same call; do not append a second
        // tool row" — settles the matching call iff it has not already
        // settled via tool_execution_end.
        if let Some(tool_result) = raw.get("toolResult") {
            events.extend(self.reconcile_tool_result(tool_result, now_ms));
        }

        events
    }

    // ---------------------------------------------------------- misc

    fn on_retry(&mut self, raw: &Value) -> Vec<RuntimeEventPayload> {
        let Some(reason) = str_field(raw, "reason") else {
            return self.protocol_notice("retry is missing reason");
        };
        // HIGH (review round 1): bounded/sanitized like `on_unknown`'s own
        // diagnostic — `reason` rides straight from the Pi child and must
        // never reach a notice unbounded or with control characters intact.
        let reason = super::process::sanitize_diagnostic(reason, 200);
        vec![notice("warning", &format!("Retrying: {reason}"))]
    }

    /// FR-3/edge cases §7: "valid unknown event | bounded diagnostic; no
    /// speculative capabilities" — surfaced once per kind, never a failure.
    fn on_unknown(&mut self, kind: &str) -> Vec<RuntimeEventPayload> {
        if !self.note_unknown_kind(kind) {
            return Vec::new();
        }
        vec![notice(
            "warning",
            &format!(
                "unknown event kind ignored: {}",
                super::process::sanitize_diagnostic(kind, 64)
            ),
        )]
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod testutil {
    use super::*;

    pub(super) fn tool_update<'a>(
        events: &'a [RuntimeEventPayload],
        id: &str,
    ) -> &'a RuntimeToolCall {
        events
            .iter()
            .rev()
            .find_map(|e| match e {
                RuntimeEventPayload::ToolUpdate { tool, .. } if tool.id == id => Some(tool),
                _ => None,
            })
            .expect("expected a tool.update for this id")
    }
}
