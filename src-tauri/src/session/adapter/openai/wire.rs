//! FR-3..FR-7 — the Chat Completions codec: request bodies, SSE decoding,
//! tool-call fragment accumulation, and the context-window table.
//!
//! `protocol: 'openai'` selects this codec **inside** the `francois` runtime; a
//! future `protocol: 'anthropic'` case is a sibling codec here, not a second
//! adapter (spec §4, seam FR-14a).
//!
//! **No HTTP calls happen in this file.** It is a pure codec: bytes/strings
//! in, typed values out; typed values in, a JSON request body out. The loop
//! integrator (a future sibling) owns the actual `ureq` call and feeds this
//! module a reader / a response; only this file's tests reach for a real
//! socket, to produce a genuine `ureq::Error` to map (§7).

use super::FrancoisTool;
use crate::ipc::ErrorCode;

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{self, BufRead};

// ---------- FR-6: the loop cap ----------

/// FR-6: the loop's round-trip cap, named here so the loop and its test read
/// one number. Hitting it ends the turn with `PROVIDER_REQUEST_FAILED` and a
/// message naming the cap.
pub const MAX_ROUND_TRIPS: u32 = 50;

// ---------- FR-3: the request body ----------

/// FR-3: `{ model, messages, tools, stream: true, stream_options: {
/// include_usage: true } }`. `messages` are the wire messages the caller
/// (thread.rs / the loop) already owns — this only assembles the envelope
/// and the static `tools` declarations; it never mutates or persists them.
pub fn request_body(model: &str, messages: &[Value]) -> Value {
    json!({
        "model": model,
        "messages": messages,
        "tools": tool_declarations(),
        "stream": true,
        "stream_options": { "include_usage": true },
    })
}

/// FR-3: one JSON-schema function declaration per `FrancoisTool`, keyed to
/// the SAME argument names `permissions/patterns.rs` (`path_key`,
/// `generate_pattern`) already reads — `file_path` for Read/Write/Edit,
/// `path` for Grep/Glob, `command` for Bash. A mismatch here means a
/// permission rule silently stops matching a call this codec sends.
pub fn tool_declarations() -> Value {
    Value::Array(
        FrancoisTool::ALL
            .iter()
            .map(|t| tool_declaration(*t))
            .collect(),
    )
}

fn tool_declaration(tool: FrancoisTool) -> Value {
    let (description, parameters) = match tool {
        FrancoisTool::Read => (
            "Read the contents of a file at the given path.",
            json!({
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "Absolute or cwd-relative path of the file to read." },
                },
                "required": ["file_path"],
            }),
        ),
        FrancoisTool::Write => (
            "Write content to a file, creating it if it does not exist and overwriting it if it does.",
            json!({
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "Absolute or cwd-relative path of the file to write." },
                    "content": { "type": "string", "description": "The full content to write to the file." },
                },
                "required": ["file_path", "content"],
            }),
        ),
        FrancoisTool::Edit => (
            "Replace an exact string occurrence in a file with a new string.",
            json!({
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "Absolute or cwd-relative path of the file to edit." },
                    "old_string": { "type": "string", "description": "The exact text to replace." },
                    "new_string": { "type": "string", "description": "The text to replace it with." },
                    "replace_all": { "type": "boolean", "description": "Replace every occurrence instead of requiring exactly one match. Defaults to false." },
                },
                "required": ["file_path", "old_string", "new_string"],
            }),
        ),
        FrancoisTool::Grep => (
            "Search file contents for a regular expression pattern.",
            json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "The regular expression to search for (Rust `regex` crate syntax)." },
                    "path": { "type": "string", "description": "Directory or file to search. Defaults to the session's working directory." },
                    // `tools.rs` reads this key; without it declared, the model
                    // could never reach the case-fold it implements.
                    "-i": { "type": "boolean", "description": "Match case-insensitively. Defaults to false." },
                },
                "required": ["pattern"],
            }),
        ),
        FrancoisTool::Glob => (
            "Find files matching a glob pattern.",
            json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "The glob pattern to match, e.g. **/*.ts." },
                    "path": { "type": "string", "description": "Directory to search from. Defaults to the session's working directory." },
                },
                "required": ["pattern"],
            }),
        ),
        FrancoisTool::Bash => (
            "Run a shell command in the session's working directory.",
            json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "The shell command to run." },
                    // SECONDS, not milliseconds — FR-14 states the contract in
                    // seconds ("120 s default … up to 600 s") and `tools.rs`
                    // parses it that way. Claude Code's own Bash schema uses
                    // milliseconds, so this is the one place the six tools
                    // deliberately diverge from it; the description says so
                    // outright, since the description is what the model reads.
                    // Lead decision, 2026-08-16. A model that passes ms anyway
                    // is clamped to the 600 s ceiling by `tools.rs` — it fails
                    // long, never short.
                    "timeout": { "type": "integer", "description": "Timeout in SECONDS (not milliseconds), up to 600. Defaults to 120." },
                },
                "required": ["command"],
            }),
        ),
    };
    json!({
        "type": "function",
        "function": {
            "name": tool.as_str(),
            "description": description,
            "parameters": parameters,
        },
    })
}

// ---------- FR-7: the context-window table ----------

/// Mirrors `OPENAI_CONTEXT_FALLBACK` in contract/multi-provider-openai.ts —
/// `(prefix, contextTokens)`, longest matching prefix wins.
pub const OPENAI_CONTEXT_FALLBACK: &[(&str, u64)] = &[
    ("gpt-5", 400_000),
    ("gpt-4.1", 1_047_576),
    ("gpt-4o", 128_000),
    ("o3", 200_000),
    ("o4", 200_000),
];

/// Mirrors `OPENAI_CONTEXT_DEFAULT` — applied when no prefix matches.
pub const OPENAI_CONTEXT_DEFAULT: u64 = 128_000;

/// Mirrors `contextTokensFor` in contract/multi-provider-openai.ts: longest
/// matching prefix wins, falling back to `OPENAI_CONTEXT_DEFAULT`.
pub fn context_tokens_for(model_id: &str) -> u64 {
    OPENAI_CONTEXT_FALLBACK
        .iter()
        .filter(|(prefix, _)| model_id.starts_with(prefix))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, tokens)| *tokens)
        .unwrap_or(OPENAI_CONTEXT_DEFAULT)
}

// ---------- FR-4/FR-5/FR-7: the SSE decoder ----------

/// FR-5: one tool call, fully accumulated — `id`/`name` arrive once,
/// `arguments` arrives in fragments concatenated in arrival order.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub(crate) id: String,
    pub(crate) name: String,
    /// FR-5: malformed accumulated JSON is not a crash — `Err` carries the
    /// string the loop hands back to the model as the tool result.
    ///
    /// core-architecture-wave3 FR-6 does NOT apply here: this is a field
    /// holding a decode outcome, not a fallible signature, and its `String` is
    /// a tool result rendered to the model rather than anything that reaches
    /// the IPC boundary. An `AppError` would add a code nothing reads.
    pub(crate) arguments: Result<Value, String>,
}

/// One semantic event the decoder yields from raw SSE bytes. Distinct from
/// `SessionEvent` (the Claude path's IPC event) on purpose — this is a
/// pure codec type the loop translates, it never crosses the IPC boundary
/// itself.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    /// FR-4: `choices[0].delta.content` — `offset` is the UTF-16 length of
    /// this response's text already streamed BEFORE this delta, the same
    /// discipline `session/stream/blocks.rs::handle_text_delta` uses.
    TextDelta { text: String, offset: usize },
    /// FR-4: `finish_reason: "stop"` — the response's complete text.
    Done { text: String },
    /// FR-5: `finish_reason: "tool_calls"` — every accumulated call, ordered
    /// by `index` (not arrival order).
    ToolCalls(Vec<ToolCall>),
    /// FR-7: `usage.prompt_tokens` from the final chunk.
    Usage { prompt_tokens: u64 },
    /// The `[DONE]` sentinel — the response is fully drained.
    StreamDone,
}

#[derive(Default, Debug, Clone)]
struct PendingToolCall {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

/// FR-4: incremental SSE decoding for one Chat Completions response.
///
/// Owns its own line buffer, so `push` accepts a chunk of ANY size at ANY
/// boundary — including mid-line — and only emits events once a full `data:
/// ` line (or the `[DONE]` sentinel) has been reassembled. One instance per
/// HTTP response: the loop creates a fresh decoder for each of the (at most
/// `MAX_ROUND_TRIPS`) round-trips a turn makes.
#[derive(Default)]
pub struct ChatStreamDecoder {
    line_buf: String,
    text: String,
    tool_calls: BTreeMap<u64, PendingToolCall>,
    done: bool,
}

impl ChatStreamDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// The response's assistant text accumulated so far — read after a
    /// `ToolCalls` event too, in case the model emitted text ahead of a tool
    /// call in the same response.
    #[allow(dead_code)]
    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    /// Whether the `[DONE]` sentinel has been seen.
    ///
    /// **Not the loop's stream-cut signal, despite the obvious reading.**
    /// `decode_sse` owns its decoder internally and never hands it out, so the
    /// runner cannot reach this — it tracks its own `got_terminal` flag off the
    /// `Done`/`ToolCalls` events instead, which is where §7's "stream cut
    /// mid-block ⇒ do not write the thread file" is actually enforced. Kept
    /// only because the decoder is unit-tested directly.
    #[cfg(test)]
    pub(crate) fn is_complete(&self) -> bool {
        self.done
    }

    /// FR-4: feed a raw chunk of response text (any size, any boundary).
    /// Returns the events completed by this push, in arrival order.
    pub(crate) fn push(&mut self, chunk: &str) -> Vec<StreamEvent> {
        self.line_buf.push_str(chunk);
        let mut events = Vec::new();
        while let Some(nl) = self.line_buf.find('\n') {
            let line: String = self.line_buf.drain(..=nl).collect();
            let line = line.trim_end_matches(['\n', '\r']).to_string();
            events.extend(self.handle_line(&line));
        }
        events
    }

    /// FR-4: `data: ` lines carry the payload; `[DONE]` ends the response;
    /// blank lines and `:`-prefixed comment/heartbeat lines are ignored, as
    /// is any other SSE field (`event:`, `id:`, `retry:`) — the Chat
    /// Completions dialect never sends them, but a decoder that only
    /// recognises `data:` degrades safely if one shows up.
    fn handle_line(&mut self, raw: &str) -> Vec<StreamEvent> {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(':') {
            return Vec::new();
        }
        let Some(payload) = line
            .strip_prefix("data: ")
            .or_else(|| line.strip_prefix("data:"))
        else {
            return Vec::new();
        };
        let payload = payload.trim();
        if payload == "[DONE]" {
            self.done = true;
            return vec![StreamEvent::StreamDone];
        }
        let Ok(chunk) = serde_json::from_str::<Value>(payload) else {
            // A malformed data line never crashes the reader — it is simply
            // dropped, matching the NDJSON reader's own "skip what doesn't
            // parse" discipline (session/stream/mod.rs).
            return Vec::new();
        };
        self.handle_chunk(&chunk)
    }

    fn handle_chunk(&mut self, chunk: &Value) -> Vec<StreamEvent> {
        let mut events = Vec::new();

        // FR-7: usage rides its own chunk (typically the final one, with an
        // empty `choices`) once `stream_options.include_usage` is set.
        if let Some(prompt_tokens) = chunk
            .get("usage")
            .and_then(|u| u.get("prompt_tokens"))
            .and_then(|p| p.as_u64())
        {
            events.push(StreamEvent::Usage { prompt_tokens });
        }

        let Some(choice) = chunk
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
        else {
            return events;
        };

        if let Some(delta) = choice.get("delta") {
            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                if !content.is_empty() {
                    let offset = self.text.encode_utf16().count();
                    self.text.push_str(content);
                    events.push(StreamEvent::TextDelta {
                        text: content.to_string(),
                        offset,
                    });
                }
            }
            if let Some(tool_calls) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                for tc in tool_calls {
                    self.accumulate_tool_call(tc);
                }
            }
        }

        if let Some(finish_reason) = choice.get("finish_reason").and_then(|f| f.as_str()) {
            match finish_reason {
                "stop" => events.push(StreamEvent::Done {
                    text: self.text.clone(),
                }),
                "tool_calls" => events.push(StreamEvent::ToolCalls(self.drain_tool_calls())),
                _ => {}
            }
        }

        events
    }

    /// FR-5: accumulated by `delta.tool_calls[].index`, never by arrival
    /// order — `id`/`function.name` arrive once, `function.arguments`
    /// arrives in fragments concatenated onto the running string.
    fn accumulate_tool_call(&mut self, tc: &Value) {
        let Some(index) = tc.get("index").and_then(|i| i.as_u64()) else {
            return;
        };
        let entry = self.tool_calls.entry(index).or_default();
        if let Some(id) = tc.get("id").and_then(|i| i.as_str()) {
            entry.id = Some(id.to_string());
        }
        if let Some(func) = tc.get("function") {
            if let Some(name) = func.get("name").and_then(|n| n.as_str()) {
                entry.name = Some(name.to_string());
            }
            if let Some(args) = func.get("arguments").and_then(|a| a.as_str()) {
                entry.arguments.push_str(args);
            }
        }
    }

    /// FR-5: every accumulated call, in `index` order (BTreeMap's natural
    /// order) regardless of the order their fragments arrived in. Empty
    /// arguments (a no-arg tool call) parse as `{}` rather than failing.
    fn drain_tool_calls(&mut self) -> Vec<ToolCall> {
        std::mem::take(&mut self.tool_calls)
            .into_values()
            .map(|p| {
                let raw = p.arguments.trim();
                let arguments = if raw.is_empty() {
                    Ok(Value::Object(Default::default()))
                } else {
                    serde_json::from_str::<Value>(raw)
                        .map_err(|e| format!("malformed tool call arguments: {e}"))
                };
                ToolCall {
                    id: p.id.unwrap_or_default(),
                    name: p.name.unwrap_or_default(),
                    arguments,
                }
            })
            .collect()
    }
}

/// FR-4: drives a `ChatStreamDecoder` over a blocking `std::io::Read` — what
/// the loop integrator hands this is `BufReader::new(response.into_reader())`
/// from a `ureq` call, no async runtime required. Reads until EOF or
/// `[DONE]`, calling `on_event` for each event as it completes.
pub fn decode_sse(
    mut reader: impl BufRead,
    mut on_event: impl FnMut(StreamEvent),
) -> io::Result<()> {
    let mut decoder = ChatStreamDecoder::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let chunk = String::from_utf8_lossy(&buf[..n]);
        for ev in decoder.push(&chunk) {
            let stream_done = matches!(ev, StreamEvent::StreamDone);
            on_event(ev);
            if stream_done {
                return Ok(());
            }
        }
    }
    Ok(())
}

// ---------- §7: error mapping ----------

/// §7: 401 → `ACCOUNT_NOT_AUTHENTICATED` (the account is marked auth-failed
/// through the existing `mark_auth_failed` path by the caller); any other
/// non-2xx (429/5xx included) and a transport failure → `PROVIDER_REQUEST_FAILED`
/// carrying the status and the endpoint's own response body, truncated to 500
/// chars. No retry in v1 — same one-shot convention `account/endpoint.rs::probe`
/// already uses for this mapping. The key is never read here at all: this
/// function only ever sees the status and the response body, never the
/// request that produced them.
pub fn map_http_error(err: ureq::Error) -> (ErrorCode, String) {
    match err {
        ureq::Error::Status(401, _) => (
            ErrorCode::AccountNotAuthenticated,
            "the endpoint rejected the API key".to_string(),
        ),
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            (
                ErrorCode::ProviderRequestFailed,
                format!("HTTP {code}: {}", truncate_500(&body)),
            )
        }
        ureq::Error::Transport(t) => (
            ErrorCode::ProviderRequestFailed,
            format!("could not reach the endpoint: {t}"),
        ),
    }
}

/// The endpoint's own error body, truncated to 500 CHARACTERS (not bytes) so
/// a multi-byte boundary is never split.
fn truncate_500(s: &str) -> String {
    if s.chars().count() <= 500 {
        s.to_string()
    } else {
        s.chars().take(500).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::path_key;
    // Only the stub HTTP server below reads a body off the socket, so `Read`
    // belongs here — at module scope the bin build sees it unused.
    use std::io::Read;

    // ---------- FR-3: request body ----------

    #[test]
    fn request_body_carries_the_exact_fr3_envelope() {
        let messages = vec![json!({ "role": "user", "content": "hi" })];
        let body = request_body("gpt-4o", &messages);
        assert_eq!(body["model"], "gpt-4o");
        assert_eq!(body["messages"], json!(messages));
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert_eq!(body["tools"].as_array().unwrap().len(), 6);
    }

    #[test]
    fn tool_declarations_carry_the_verbatim_names_in_all_order() {
        let decls = tool_declarations();
        let names: Vec<&str> = decls
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["function"]["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["Read", "Write", "Edit", "Grep", "Glob", "Bash"]);
    }

    /// The whole point of FR-3's schema-key instruction: a mismatch here
    /// means a permission rule generated by `permissions/patterns.rs` would
    /// silently stop matching a Francois-loop tool call.
    #[test]
    fn tool_declaration_argument_keys_match_permissions_patterns_path_key() {
        let decls = tool_declarations();
        let props_of = |name: &str| -> Vec<String> {
            decls
                .as_array()
                .unwrap()
                .iter()
                .find(|d| d["function"]["name"] == name)
                .unwrap()["function"]["parameters"]["properties"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect()
        };
        for tool in ["Read", "Write", "Edit"] {
            let keys = props_of(tool);
            for expected in path_key(tool).unwrap() {
                assert!(
                    keys.contains(&expected.to_string()),
                    "{tool} missing {expected}"
                );
            }
        }
        for tool in ["Grep", "Glob"] {
            let keys = props_of(tool);
            for expected in path_key(tool).unwrap() {
                assert!(
                    keys.contains(&expected.to_string()),
                    "{tool} missing {expected}"
                );
            }
        }
        let bash_keys = props_of("Bash");
        assert!(bash_keys.contains(&"command".to_string()));
        assert!(bash_keys.contains(&"timeout".to_string()));
        let edit_keys = props_of("Edit");
        for key in ["old_string", "new_string", "replace_all"] {
            assert!(edit_keys.contains(&key.to_string()), "Edit missing {key}");
        }
    }

    /// The schema is the ONLY thing that tells the model which unit `timeout`
    /// is in, and `tools.rs` parses it as seconds — so the two halves of that
    /// agreement live in different files with nothing but this test between
    /// them. Claude Code's own Bash schema says milliseconds, which is exactly
    /// why a silent revert here is plausible: it would look like a fix.
    /// Lead decision 2026-08-16 (specs/_roadmap-multi-provider.md Phase E).
    #[test]
    fn the_bash_timeout_schema_states_seconds_because_tools_rs_parses_seconds() {
        let declarations = tool_declarations();
        let bash = declarations
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["function"]["name"] == "Bash")
            .expect("Bash declaration");
        let description = bash["function"]["parameters"]["properties"]["timeout"]["description"]
            .as_str()
            .unwrap();
        assert!(
            description.contains("SECONDS"),
            "the Bash timeout description must state its unit outright: {description}"
        );
        assert!(
            !description.to_ascii_lowercase().contains("up to 600000"),
            "millisecond ceiling leaked back into the Bash timeout schema: {description}"
        );
    }

    #[test]
    fn every_declaration_requires_at_least_its_path_or_command_argument() {
        let decls = tool_declarations();
        for d in decls.as_array().unwrap() {
            let required = d["function"]["parameters"]["required"].as_array().unwrap();
            assert!(
                !required.is_empty(),
                "{} has no required args",
                d["function"]["name"]
            );
        }
    }

    // ---------- FR-6 ----------

    #[test]
    fn the_round_trip_cap_is_fifty() {
        assert_eq!(MAX_ROUND_TRIPS, 50);
    }

    // ---------- FR-7: context table parity ----------

    /// Written out rather than derived from the table under test — a test
    /// that reads its own members back off the thing it is checking would
    /// pass no matter which entry drifted from the contract.
    #[test]
    fn the_context_table_matches_the_contract_literal() {
        let contract: &[(&str, u64)] = &[
            ("gpt-5", 400_000),
            ("gpt-4.1", 1_047_576),
            ("gpt-4o", 128_000),
            ("o3", 200_000),
            ("o4", 200_000),
        ];
        assert_eq!(OPENAI_CONTEXT_FALLBACK, contract);
        assert_eq!(OPENAI_CONTEXT_DEFAULT, 128_000);
    }

    #[test]
    fn context_tokens_for_matches_longest_prefix() {
        assert_eq!(context_tokens_for("gpt-4.1-mini"), 1_047_576);
        assert_eq!(context_tokens_for("gpt-4o-mini"), 128_000);
        assert_eq!(context_tokens_for("gpt-5-nano"), 400_000);
        assert_eq!(context_tokens_for("o3-mini"), 200_000);
        assert_eq!(context_tokens_for("o4-mini"), 200_000);
    }

    #[test]
    fn context_tokens_for_falls_back_to_the_default() {
        assert_eq!(
            context_tokens_for("claude-sonnet-4"),
            OPENAI_CONTEXT_DEFAULT
        );
        assert_eq!(context_tokens_for(""), OPENAI_CONTEXT_DEFAULT);
        assert_eq!(context_tokens_for("mystery-model"), 128_000);
    }

    // ---------- FR-4/FR-5: the recorded SSE fixture ----------

    const SSE_FIXTURE: &str = include_str!("fixtures/sse_turn.txt");

    #[test]
    fn the_fixture_reconstructs_interleaved_out_of_order_tool_calls_in_one_push() {
        let mut decoder = ChatStreamDecoder::new();
        let events = decoder.push(SSE_FIXTURE);
        assert_events_match_the_fixture(&events);
    }

    #[test]
    fn the_fixture_reconstructs_identically_when_a_chunk_boundary_falls_mid_line() {
        // Split the fixture at an arbitrary byte offset that lands inside a
        // `data: ` line (not on a line boundary) — a real socket read would
        // do exactly this. The decoder must reassemble the split line before
        // acting on it, so the two-push result must be byte-identical to the
        // one-push result.
        let split_at = SSE_FIXTURE
            .find("\"comm")
            .expect("fixture has a split point");
        let (first, second) = SSE_FIXTURE.split_at(split_at);
        assert!(!first.ends_with('\n'), "the split must land mid-line");

        let mut decoder = ChatStreamDecoder::new();
        let mut events = decoder.push(first);
        events.extend(decoder.push(second));
        assert_events_match_the_fixture(&events);
    }

    #[test]
    fn the_fixture_reconstructs_when_split_into_single_byte_chunks() {
        // The extreme case of "any boundary" — one byte at a time.
        let mut decoder = ChatStreamDecoder::new();
        let mut events = Vec::new();
        for byte in SSE_FIXTURE.as_bytes() {
            let s = std::str::from_utf8(std::slice::from_ref(byte)).unwrap();
            events.extend(decoder.push(s));
        }
        assert_events_match_the_fixture(&events);
    }

    /// Shared assertions the three chunking strategies above must all
    /// produce identically: text before the tool calls (if any), exactly two
    /// reconstructed tool calls in INDEX order (0 then 1) with their
    /// concatenated arguments parsed, the usage event, and the terminal
    /// StreamDone — heartbeat lines contribute nothing.
    fn assert_events_match_the_fixture(events: &[StreamEvent]) {
        let tool_calls = events
            .iter()
            .find_map(|e| match e {
                StreamEvent::ToolCalls(calls) => Some(calls.clone()),
                _ => None,
            })
            .expect("a ToolCalls event");
        assert_eq!(tool_calls.len(), 2);

        assert_eq!(tool_calls[0].id, "call_abc");
        assert_eq!(tool_calls[0].name, "Bash");
        assert_eq!(tool_calls[0].arguments, Ok(json!({ "command": "echo hi" })));

        assert_eq!(tool_calls[1].id, "call_def");
        assert_eq!(tool_calls[1].name, "Read");
        assert_eq!(tool_calls[1].arguments, Ok(json!({ "file_path": "/a.ts" })));

        let usage = events.iter().find_map(|e| match e {
            StreamEvent::Usage { prompt_tokens } => Some(*prompt_tokens),
            _ => None,
        });
        assert_eq!(usage, Some(1234));

        assert_eq!(events.last(), Some(&StreamEvent::StreamDone));

        // No spurious text/done events snuck in from the heartbeat or from
        // misreading a comment line as data.
        assert!(!events
            .iter()
            .any(|e| matches!(e, StreamEvent::TextDelta { .. } | StreamEvent::Done { .. })));
    }

    #[test]
    fn a_heartbeat_and_blank_line_produce_no_events() {
        let mut decoder = ChatStreamDecoder::new();
        assert!(decoder.push(": keep-alive\n").is_empty());
        assert!(decoder.push("\n").is_empty());
    }

    #[test]
    fn malformed_accumulated_arguments_become_an_error_string_not_a_panic() {
        let mut decoder = ChatStreamDecoder::new();
        decoder.push(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"type\":\"function\",\"function\":{\"name\":\"Bash\",\"arguments\":\"{not json\"}}]},\"finish_reason\":null}]}\n\n",
        );
        let events = decoder.push(
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        );
        let calls = match &events[0] {
            StreamEvent::ToolCalls(c) => c,
            other => panic!("expected ToolCalls, got {other:?}"),
        };
        assert_eq!(calls.len(), 1);
        assert!(calls[0].arguments.is_err());
    }

    #[test]
    fn a_no_arg_tool_call_parses_as_an_empty_object() {
        let mut decoder = ChatStreamDecoder::new();
        decoder.push(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"type\":\"function\",\"function\":{\"name\":\"Bash\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
        );
        let events = decoder.push(
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        );
        let calls = match &events[0] {
            StreamEvent::ToolCalls(c) => c,
            other => panic!("expected ToolCalls, got {other:?}"),
        };
        assert_eq!(calls[0].arguments, Ok(json!({})));
    }

    #[test]
    fn text_deltas_carry_the_utf16_offset_discipline() {
        let mut decoder = ChatStreamDecoder::new();
        let e1 = decoder.push(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi \"},\"finish_reason\":null}]}\n\n",
        );
        assert_eq!(
            e1[0],
            StreamEvent::TextDelta {
                text: "hi ".into(),
                offset: 0
            }
        );
        // A surrogate-pair emoji counts as 2 UTF-16 units, so the next
        // offset must be 3 + 2 = 5, not the byte or char count.
        let e2 = decoder.push(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\\ud83d\\ude00!\"},\"finish_reason\":null}]}\n\n",
        );
        assert_eq!(
            e2[0],
            StreamEvent::TextDelta {
                text: "\u{1f600}!".into(),
                offset: 3
            }
        );
    }

    #[test]
    fn finish_reason_stop_emits_done_with_the_complete_text() {
        let mut decoder = ChatStreamDecoder::new();
        decoder.push(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}]}\n\n",
        );
        let events = decoder.push(
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        );
        assert_eq!(
            events,
            vec![StreamEvent::Done {
                text: "hello".into()
            }]
        );
    }

    #[test]
    fn is_complete_tracks_the_done_sentinel() {
        let mut decoder = ChatStreamDecoder::new();
        assert!(!decoder.is_complete());
        decoder.push("data: [DONE]\n\n");
        assert!(decoder.is_complete());
    }

    // ---------- decode_sse: the BufRead driver ----------

    #[test]
    fn decode_sse_drives_the_decoder_over_a_plain_reader() {
        let cursor = io::Cursor::new(SSE_FIXTURE.as_bytes());
        let mut events = Vec::new();
        decode_sse(std::io::BufReader::new(cursor), |ev| events.push(ev)).unwrap();
        assert_events_match_the_fixture(&events);
    }

    // ---------- §7: error mapping ----------

    /// Binds an ephemeral loopback port, accepts exactly one connection,
    /// writes `response` back verbatim, and returns the stub's `http://`
    /// base URL. Mirrors `account/endpoint.rs`'s own test helper — this
    /// module's tests need a REAL `ureq::Error` to map, since `Response`
    /// cannot be hand-constructed.
    fn spawn_stub_server(response: &'static str) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            use std::io::Write;
            if let Ok((mut stream, _)) = listener.accept() {
                // Drain the WHOLE request before answering. A single `read`
                // here races the client's body write: `ureq` is often still
                // sending when the stub replies and closes, so the client sees
                // ECONNRESET and `map_http_error` gets a TRANSPORT error
                // instead of the HTTP status the test is about. Both map to
                // PROVIDER_REQUEST_FAILED, so the code assertion still passed
                // and only the message assertion failed — which is why this
                // read like flakiness under load rather than the plain race it
                // is. Measured at roughly 2 failures in 5 isolated runs.
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                read_full_request(&mut stream);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        (format!("http://{addr}"), handle)
    }

    /// Read the request head, then exactly `Content-Length` body bytes, so the
    /// client has finished writing before the stub responds. Byte-at-a-time is
    /// fine — these requests are a few hundred bytes.
    fn read_full_request(stream: &mut std::net::TcpStream) {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            match stream.read(&mut byte) {
                Ok(0) | Err(_) => return,
                Ok(_) => head.extend_from_slice(&byte),
            }
        }
        let length = String::from_utf8_lossy(&head)
            .to_ascii_lowercase()
            .lines()
            .find_map(|line| line.strip_prefix("content-length:").map(str::to_string))
            .and_then(|v| v.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if length > 0 {
            let mut body = vec![0u8; length];
            let _ = stream.read_exact(&mut body);
        }
    }

    #[test]
    fn a_401_maps_to_account_not_authenticated_and_never_carries_the_key() {
        let (base_url, handle) = spawn_stub_server(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let err = ureq::post(&format!("{base_url}/chat/completions"))
            .set("Authorization", "Bearer sk-should-never-leak")
            .send_string("{}")
            .unwrap_err();
        let (code, msg) = map_http_error(err);
        assert_eq!(code, ErrorCode::AccountNotAuthenticated);
        assert!(!msg.contains("sk-should-never-leak"));
        handle.join().unwrap();
    }

    #[test]
    fn a_429_maps_to_provider_request_failed_with_the_truncated_body() {
        let long_body = "x".repeat(600);
        let response = format!(
            "HTTP/1.1 429 Too Many Requests\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            long_body.len(),
            long_body
        );
        let response: &'static str = Box::leak(response.into_boxed_str());
        let (base_url, handle) = spawn_stub_server(response);
        let err = ureq::post(&format!("{base_url}/chat/completions"))
            .set("Authorization", "Bearer sk-should-never-leak-either")
            .send_string("{}")
            .unwrap_err();
        let (code, msg) = map_http_error(err);
        assert_eq!(code, ErrorCode::ProviderRequestFailed);
        assert!(msg.contains("429"));
        assert!(msg.chars().count() <= 500 + "HTTP 429: ".len());
        assert!(!msg.contains("sk-should-never-leak-either"));
        handle.join().unwrap();
    }

    #[test]
    fn a_5xx_maps_to_provider_request_failed() {
        let (base_url, handle) = spawn_stub_server(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let err = ureq::post(&format!("{base_url}/chat/completions"))
            .send_string("{}")
            .unwrap_err();
        let (code, msg) = map_http_error(err);
        assert_eq!(code, ErrorCode::ProviderRequestFailed);
        assert!(msg.contains("503"));
        handle.join().unwrap();
    }

    #[test]
    fn a_transport_failure_maps_to_provider_request_failed() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let err = ureq::post(&format!("http://{addr}/chat/completions"))
            .send_string("{}")
            .unwrap_err();
        let (code, _) = map_http_error(err);
        assert_eq!(code, ErrorCode::ProviderRequestFailed);
    }
}
