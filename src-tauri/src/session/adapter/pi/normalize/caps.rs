//! session/adapter/pi/normalize/caps.rs — pi-transcript-events §6 ("Display
//! projection is derived, bounded as in transcript-scale"): the bounding
//! policy for everything `TranscriptReducer` keeps on the CHILD's behalf.
//!
//! MEDIUM (review round 7): the reducer's own state was only ever evicted
//! where an id SETTLED — a message that never gets its `message_end`, a tool
//! call that never gets its result, an endless run of distinct unknown event
//! kinds and an endless run of `content_delta`s all grew for the connection's
//! lifetime. A Pi child is a local process, but it is not this app's code and
//! its output is untrusted input like any other wire.
//!
//! Two tiers per map, because the two failure modes are different:
//!   * OPEN entries (a message still streaming, a tool call still running)
//!     hold TEXT, so their cap is small and evicting one must SETTLE it —
//!     dropping it would strand a `streaming: true` block that is never
//!     persisted and pins `trim_transcript` forever (the exact hazard
//!     `on_message_end`'s stranded-slot loop already documents).
//!   * FINALIZED/SETTLED entries hold only identity (block id, status), since
//!     settling clears their text — so they keep the much larger
//!     `REDUCER_STATE_CAP` window, which is what makes a replayed event for a
//!     recently-finished id still recognizable rather than a duplicate row.

use super::*;

/// How many assistant messages may be open (streaming, not yet finalized) at
/// once. Pi streams one assistant message at a time; this leaves room for an
/// interleaved run without ever letting an adversarial stream hold unbounded
/// text. Evicting the oldest settles it as `interrupted` (FR-9's wording for
/// text that stops arriving).
pub(super) const OPEN_MESSAGE_CAP: usize = 16;

/// The same, for tool calls that never reach a result. Parallel tool use runs
/// to a handful of calls per turn; the eviction settles as FR-9 does —
/// `cancelled` (never started) or `unknown` (was mid-execution), never
/// `succeeded`.
pub(super) const OPEN_TOOL_CAP: usize = 32;

/// FR-2 allows several content slots per assistant message; a wire that keeps
/// inventing `contentIndex` values does not. Past this, a delta for an UNSEEN
/// index is dropped with one notice per message rather than evicting a slot:
/// a slot's `blockId` is a live block identity (FR-6 "one core block identity
/// survives streaming, finalization and recovery"), so evicting one would
/// orphan a block the transcript is already showing.
pub(super) const SLOTS_PER_MESSAGE_CAP: usize = 64;

/// Byte cap on ONE content slot's accumulated text. Far above any real
/// assistant message (a model's whole output budget is a fraction of it), so
/// nothing legitimate is ever cut — it exists so a stream that never ends a
/// slot cannot hold unbounded text. Past it the slot carries
/// [`TRUNCATION_MARKER`] and a notice says so: §7 forbids dropping content
/// "without explanation", not bounding it.
pub(super) const SLOT_TEXT_BYTES: usize = 1024 * 1024;

pub(super) const TRUNCATION_MARKER: &str = "\u{2026} [truncated]";

/// Distinct "valid unknown event" kinds remembered for the once-per-kind
/// notice. Oldest-first: past the cap a long-forgotten kind may be notified a
/// second time, which is strictly better than remembering every string a
/// child cares to invent.
pub(super) const UNKNOWN_KINDS_CAP: usize = 64;

/// How many malformed-event notices one connection may put in the transcript
/// before they are suppressed (one final notice says so). A wire that is
/// malformed on every line is one fault, not ten thousand blocks.
pub(super) const PROTOCOL_NOTICE_CAP: usize = 10;

impl TranscriptReducer {
    /// Record a message id as OPEN and force-finalize the oldest open message
    /// once more than [`OPEN_MESSAGE_CAP`] are open at once. Called exactly
    /// once per id, where the entry is first inserted.
    pub(super) fn note_message_opened(&mut self, message_id: &str) -> Vec<RuntimeEventPayload> {
        self.open_messages.push_back(message_id.to_string());
        let mut events = Vec::new();
        while self.open_messages.len() > OPEN_MESSAGE_CAP {
            let Some(oldest) = self.open_messages.pop_front() else {
                break;
            };
            events.extend(self.interrupt_message(&oldest));
        }
        events
    }

    /// Settle every still-open slot of one message as `interrupted` and mark
    /// the message finalized — FR-9's per-message half, shared by the open
    /// cap above and by `finalize_interrupted`'s crash/stop sweep.
    pub(super) fn interrupt_message(&mut self, message_id: &str) -> Vec<RuntimeEventPayload> {
        let mut events = Vec::new();
        let Some(message) = self.messages.get_mut(message_id) else {
            return events;
        };
        if message.finalized {
            return events;
        }
        for slot in message.slots.values_mut() {
            if slot.ended {
                continue;
            }
            slot.ended = true;
            events.push(RuntimeEventPayload::AssistantComplete {
                block_id: slot.block_id.clone(),
                text: slot.text.clone(),
                outcome: "interrupted".into(),
            });
        }
        message.finalized = true;
        self.note_message_finalized(message_id);
        events
    }

    /// Record a message as finalized: it leaves the open tier (no more text is
    /// coming, so its slot text is released — only the slot IDENTITIES matter
    /// from here, for FR-6's stable block ids on a replayed `message_end`) and
    /// joins the finalized tier, whose oldest entry is evicted past the bound.
    pub(super) fn note_message_finalized(&mut self, message_id: &str) {
        self.open_messages.retain(|id| id != message_id);
        if let Some(message) = self.messages.get_mut(message_id) {
            for slot in message.slots.values_mut() {
                slot.text.clear();
                slot.text.shrink_to_fit();
            }
        }
        self.finalized_messages.push_back(message_id.to_string());
        if self.finalized_messages.len() > REDUCER_STATE_CAP {
            if let Some(oldest) = self.finalized_messages.pop_front() {
                self.messages.remove(&oldest);
            }
        }
    }

    /// `note_message_opened`'s twin for tool calls.
    pub(super) fn note_tool_opened(
        &mut self,
        tool_call_id: &str,
        now_ms: u64,
    ) -> Vec<RuntimeEventPayload> {
        self.open_tools.push_back(tool_call_id.to_string());
        let mut events = Vec::new();
        while self.open_tools.len() > OPEN_TOOL_CAP {
            let Some(oldest) = self.open_tools.pop_front() else {
                break;
            };
            events.extend(self.interrupt_tool(&oldest, now_ms));
        }
        events
    }

    /// FR-9's per-call half: settle one unsettled call as `cancelled` (never
    /// started executing) or `unknown` (was mid-execution), never `succeeded`.
    pub(super) fn interrupt_tool(
        &mut self,
        tool_call_id: &str,
        now_ms: u64,
    ) -> Option<RuntimeEventPayload> {
        let tool = self.tools.get_mut(tool_call_id)?;
        if tool.settled {
            return None;
        }
        tool.status = if tool.status == ToolStatus::Running {
            ToolStatus::Unknown
        } else {
            ToolStatus::Cancelled
        };
        tool.completed_at = Some(now_ms);
        tool.settled = true;
        let event = RuntimeEventPayload::ToolUpdate {
            block_id: tool.block_id.clone(),
            tool: tool.to_call(tool_call_id),
        };
        self.note_tool_settled(tool_call_id);
        Some(event)
    }

    /// `note_message_finalized`'s twin: a settled call's previews are released
    /// (every handler returns early on `settled`, so nothing reads them again)
    /// and its identity joins the settled tier.
    pub(super) fn note_tool_settled(&mut self, tool_call_id: &str) {
        self.open_tools.retain(|id| id != tool_call_id);
        if let Some(tool) = self.tools.get_mut(tool_call_id) {
            tool.input_text = String::new();
            tool.output_text = String::new();
        }
        self.settled_tools.push_back(tool_call_id.to_string());
        if self.settled_tools.len() > REDUCER_STATE_CAP {
            if let Some(oldest) = self.settled_tools.pop_front() {
                self.tools.remove(&oldest);
            }
        }
    }

    /// True the FIRST time this unknown event kind is seen, bounded by
    /// [`UNKNOWN_KINDS_CAP`] with oldest-first eviction.
    pub(super) fn note_unknown_kind(&mut self, kind: &str) -> bool {
        if self.unknown_notified.iter().any(|k| k == kind) {
            return false;
        }
        self.unknown_notified.push_back(kind.to_string());
        if self.unknown_notified.len() > UNKNOWN_KINDS_CAP {
            self.unknown_notified.pop_front();
        }
        true
    }
}

/// Append `chunk` to a slot's accumulated text under [`SLOT_TEXT_BYTES`],
/// returning what was ACTUALLY appended — that, not the raw chunk, is what
/// rides out as the delta, so the frontend's block and this slot never
/// disagree about the text. Empty once the slot is full. The `bool` is true
/// on the call that first truncates it (the one that notifies).
pub(super) fn append_slot_text(slot: &mut ContentSlot, chunk: &str) -> (String, bool) {
    if slot.text_truncated {
        return (String::new(), false);
    }
    let room = SLOT_TEXT_BYTES.saturating_sub(slot.text.len());
    if chunk.len() <= room {
        slot.text.push_str(chunk);
        return (chunk.to_string(), false);
    }
    let mut end = room;
    while end > 0 && !chunk.is_char_boundary(end) {
        end -= 1;
    }
    let mut appended = chunk[..end].to_string();
    appended.push_str(TRUNCATION_MARKER);
    slot.text.push_str(&appended);
    slot.text_truncated = true;
    (appended, true)
}

/// The same bound for an AUTHORITATIVE `message_end` text, which replaces
/// rather than appends. Returns the stored text and whether it was cut.
pub(super) fn set_slot_text(slot: &mut ContentSlot, text: &str) -> (String, bool) {
    slot.text.clear();
    slot.text_truncated = false;
    let (stored, truncated) = append_slot_text(slot, text);
    (stored, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open_message_count(r: &TranscriptReducer) -> usize {
        r.messages.values().filter(|m| !m.finalized).count()
    }

    fn interrupted_completions(events: &[RuntimeEventPayload]) -> usize {
        events
            .iter()
            .filter(|e| {
                matches!(e, RuntimeEventPayload::AssistantComplete { outcome, .. }
                    if outcome == "interrupted")
            })
            .count()
    }

    /// The hostile shape the settle-only eviction missed entirely: message ids
    /// that NEVER finalize. State must stay bounded, and every message the
    /// bound evicts must be settled rather than dropped mid-stream — a dropped
    /// one leaves a `streaming: true` block that is never persisted and pins
    /// `trim_transcript`.
    #[test]
    fn never_finalized_messages_stay_bounded_and_are_settled_on_eviction() {
        let mut r = TranscriptReducer::new();
        let mut interrupted = 0;
        for i in 0..(OPEN_MESSAGE_CAP * 20) {
            interrupted += interrupted_completions(&r.on_event(
                &json!({"type":"content_delta","messageId":format!("m{i}"),"contentIndex":0,
                    "delta":{"type":"text","text":"never ends"}}),
                0,
            ));
        }
        assert!(
            open_message_count(&r) <= OPEN_MESSAGE_CAP,
            "open messages grew past the bound: {}",
            open_message_count(&r)
        );
        // The two tiers are disjoint windows, so the map is bounded by their
        // sum: the finalized window plus whatever is still open.
        assert!(r.messages.len() <= REDUCER_STATE_CAP + OPEN_MESSAGE_CAP);
        assert_eq!(
            interrupted,
            OPEN_MESSAGE_CAP * 20 - OPEN_MESSAGE_CAP,
            "every evicted open message must settle exactly once"
        );
    }

    /// The same for tool calls that never get a result.
    #[test]
    fn never_settled_tool_calls_stay_bounded_and_are_cancelled_on_eviction() {
        let mut r = TranscriptReducer::new();
        let mut cancelled = 0;
        for i in 0..(OPEN_TOOL_CAP * 20) {
            let events = r.on_event(
                &json!({"type":"toolcall_start","toolCallId":format!("t{i}"),"name":"Bash"}),
                0,
            );
            cancelled += events
                .iter()
                .filter(|e| {
                    matches!(e, RuntimeEventPayload::ToolUpdate { tool, .. }
                        if tool.status == "cancelled")
                })
                .count();
        }
        let open = r.tools.values().filter(|t| !t.settled).count();
        assert!(
            open <= OPEN_TOOL_CAP,
            "open tool calls grew past the bound: {open}"
        );
        assert!(r.tools.len() <= REDUCER_STATE_CAP + OPEN_TOOL_CAP);
        assert_eq!(cancelled, OPEN_TOOL_CAP * 20 - OPEN_TOOL_CAP);
    }

    /// A settled call keeps its identity (so a replay is still recognized) but
    /// not its previews — 64 KiB of input + 64 KiB of output per settled id
    /// would otherwise be retained for the whole `REDUCER_STATE_CAP` window.
    #[test]
    fn a_settled_call_releases_its_previews_but_keeps_its_block_identity() {
        let mut r = TranscriptReducer::new();
        r.on_event(
            &json!({"type":"toolcall_start","toolCallId":"t1","name":"Bash"}),
            0,
        );
        r.on_event(
            &json!({"type":"toolcall_end","toolCallId":"t1","input":"{\"command\":\"ls\"}"}),
            0,
        );
        let settled = r.on_event(
            &json!({"type":"tool_execution_end","toolCallId":"t1","isError":false,"output":"ok"}),
            10,
        );
        // The event that goes out still carries the whole snapshot…
        match settled.first().expect("a tool.update") {
            RuntimeEventPayload::ToolUpdate { tool, .. } => {
                assert_eq!(tool.output_text, "ok");
                assert!(tool.input_text.contains("command"));
            }
            other => panic!("expected a tool.update, got {other:?}"),
        }
        // …and the reducer keeps none of it.
        let tool = &r.tools["t1"];
        assert!(tool.input_text.is_empty());
        assert!(tool.output_text.is_empty());
        assert!(!tool.block_id.is_empty());
    }

    #[test]
    fn an_endless_run_of_distinct_unknown_event_kinds_stays_bounded() {
        let mut r = TranscriptReducer::new();
        for i in 0..(UNKNOWN_KINDS_CAP * 20) {
            r.on_event(&json!({ "type": format!("future_event_{i}") }), 0);
        }
        assert!(
            r.unknown_notified.len() <= UNKNOWN_KINDS_CAP,
            "remembered unknown kinds grew past the bound: {}",
            r.unknown_notified.len()
        );
    }

    /// §7 forbids dropping content "without explanation" — not bounding it. A
    /// slot that never ends is cut at [`SLOT_TEXT_BYTES`], carries the marker
    /// in its own text (so the reducer and the rendered block agree), and says
    /// so once.
    #[test]
    fn a_slot_that_never_ends_is_cut_at_the_byte_cap_with_a_marker_and_one_notice() {
        let mut r = TranscriptReducer::new();
        let chunk = "x".repeat(64 * 1024);
        let mut notices = 0;
        for _ in 0..40 {
            notices += r
                .on_event(
                    &json!({"type":"content_delta","messageId":"m1","contentIndex":0,
                        "delta":{"type":"text","text": chunk}}),
                    0,
                )
                .iter()
                .filter(|e| matches!(e, RuntimeEventPayload::Notice { .. }))
                .count();
        }
        let text = &r.messages["m1"].slots[&0].text;
        assert!(
            text.len() <= SLOT_TEXT_BYTES + TRUNCATION_MARKER.len(),
            "slot text grew past the cap: {}",
            text.len()
        );
        assert!(text.ends_with(TRUNCATION_MARKER));
        assert_eq!(notices, 1, "the cut is announced exactly once");
    }

    #[test]
    fn content_slots_per_message_are_bounded_and_announced_once() {
        let mut r = TranscriptReducer::new();
        let mut notices = 0;
        for i in 0..(SLOTS_PER_MESSAGE_CAP * 4) {
            notices += r
                .on_event(
                    &json!({"type":"content_delta","messageId":"m1","contentIndex":i,
                        "delta":{"type":"text","text":"x"}}),
                    0,
                )
                .iter()
                .filter(|e| matches!(e, RuntimeEventPayload::Notice { .. }))
                .count();
        }
        assert_eq!(r.messages["m1"].slots.len(), SLOTS_PER_MESSAGE_CAP);
        assert_eq!(notices, 1);
    }

    /// The cap must never cut a slot the stream is using normally, and the
    /// text it does keep stays byte-exact.
    #[test]
    fn ordinary_assistant_text_is_never_touched_by_the_cap() {
        let mut r = TranscriptReducer::new();
        for chunk in ["Hello, ", "world", "\u{1f600}"] {
            r.on_event(
                &json!({"type":"content_delta","messageId":"m1","contentIndex":0,
                    "delta":{"type":"text","text": chunk}}),
                0,
            );
        }
        assert_eq!(r.messages["m1"].slots[&0].text, "Hello, world\u{1f600}");
        assert!(!r.messages["m1"].slots[&0].text_truncated);
    }
}
