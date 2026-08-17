//! Parsing the `grok -p --output-format streaming-json` event stream
//! (multi-provider-grok FR-12/FR-13/FR-14/FR-15/FR-16/FR-17/FR-18). Pure: a
//! `&str` line in, a `GrokEvent` out. Translation into transcript blocks lives
//! in `runner.rs`; this file only says what Grok said.
//!
//! **This is NOT `contract/multi-provider-grok.ts`'s `GrokLine` shape**, and
//! that is a build-step FR-11 finding, not an oversight — see `grok/mod.rs`'s
//! module doc for how it was verified. The contract assumed a JSON-RPC 2.0 /
//! ACP envelope (`{"jsonrpc":"2.0","method":"session/update","params":{
//! "update":{"sessionUpdate":"agent_message_chunk",…}}}`). The real
//! `--output-format streaming-json` is a FLAT `type`-tagged NDJSON line —
//! confirmed two ways:
//!
//! 1. **Live, in this environment.** `grok` 1.0.5 was installed but no xAI
//!    account/API key was available to complete an authenticated turn.
//!    Running `grok -p "list the files here" --output-format streaming-json`
//!    unauthenticated still emits a real stdout line before exiting:
//!    `{"type":"error","message":"Not signed in. …"}` — see the
//!    `a_real_unauthenticated_invocation_emits_this_exact_line` test below,
//!    which pins that EXACT string.
//! 2. **The CLI's own bundled reference**, shipped inside the installed
//!    binary's `GROK_HOME` at `docs/user-guide/14-headless-mode.md` (xAI's
//!    committed documentation for this exact build, not a third-party guess),
//!    documents the full `streaming-json` vocabulary with worked examples:
//!    `text`, `thought`, `tool_call`, `tool_call_update`, `usage`, `plan`,
//!    `available_commands`, `end`, `error` — "Consume it by switching on
//!    `type`." `fixtures/exec_turn.jsonl` is assembled verbatim from that
//!    document's own example lines (a self-consistent single-round turn), not
//!    invented — the closest thing to a capture obtainable without a live
//!    account.
//!
//! **Leniency (FR-12) is unchanged in spirit**: a non-JSON line, a JSON value
//! with no `type`, or a `type` this version does not switch on, is `Unknown` —
//! never fatal. The doc itself says as much: "Grok may also emit
//! `max_turns_reached` and `auto_compact_*` events; treat the list as
//! non-exhaustive and switch on `type`."

use serde::Deserialize;
use serde_json::Value;

/// FR-16: usage field names off the REAL wire (see module doc) — snake_case,
/// not the contract's guessed camelCase (`inputTokens`/`cachedInputTokens`).
/// This is the least-certain part of the provisional contract per its own
/// comment, and it was wrong: the real fields are `input_tokens`,
/// `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
/// `reasoning_tokens`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub(super) struct Usage {
    #[serde(default)]
    pub(super) input_tokens: u64,
    #[serde(default)]
    pub(super) output_tokens: u64,
    #[serde(default)]
    pub(super) cache_read_input_tokens: u64,
    #[serde(default)]
    pub(super) cache_creation_input_tokens: u64,
    #[serde(default)]
    pub(super) reasoning_tokens: u64,
}

impl Usage {
    /// FR-16: what the context meter shows. Both cache buckets occupy the
    /// window even though they are billed differently, so they count;
    /// `reasoning_tokens` is a SUBSET of `output_tokens` (the same `codex`
    /// lesson FR-16 names) and must not be added twice. Matches the docs'
    /// own `total_tokens = input_tokens + cache_read_input_tokens +
    /// cache_creation_input_tokens + output_tokens`.
    pub(super) fn context_used(&self) -> u64 {
        self.input_tokens
            + self.cache_read_input_tokens
            + self.cache_creation_input_tokens
            + self.output_tokens
    }

    pub(super) fn is_zero(&self) -> bool {
        self.input_tokens == 0
            && self.output_tokens == 0
            && self.cache_read_input_tokens == 0
            && self.cache_creation_input_tokens == 0
    }
}

/// One `tool_call`/`tool_call_update` line, addressed by `toolCallId` across
/// both — which is what lets a card go live and complete in place (FR-15).
#[derive(Debug, Clone, PartialEq)]
pub(super) enum GrokEvent {
    /// FR-14: a chunk of assistant text — a DELTA, append never replace.
    Text { text: String },
    /// FR-18: parsed so it is not mistaken for Unknown, then dropped by the
    /// runner — `BlockKind` has no thinking member (§2 non-goal).
    Thought,
    ToolCall {
        call_id: String,
        title: Option<String>,
        kind: Option<String>,
        tool_name: Option<String>,
    },
    ToolCallUpdate {
        call_id: String,
        status: Option<String>,
    },
    /// A per-response usage boundary. Recognized (never `Unknown`) but
    /// produces no context-meter update — FR-16 reads the meter off `End`'s
    /// aggregate only, the same "one authoritative figure, not a running
    /// sum" reasoning `codex`'s `turn.completed`-only update follows.
    ResponseUsage,
    /// FR-18: parsed and dropped, same reasoning as `Thought`.
    Plan,
    /// The tool/slash-command inventory line — no transcript block
    /// corresponds to it.
    AvailableCommands,
    /// FR-17: the terminal event of a turn.
    End {
        stop_reason: Option<String>,
        usage: Usage,
    },
    /// FR-17: an error line — a failed spawn/auth/turn. Ends the turn errored.
    Error { message: String },
    /// FR-12: a line that was not JSON, carried no `type`, or named a `type`
    /// this version does not handle. Never fatal.
    Unknown,
}

const UNKNOWN_ERROR: &str = "grok reported an error with no message";

/// FR-12: parse one stdout line. Never fails — see the module doc.
pub(super) fn parse_line(line: &str) -> GrokEvent {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return GrokEvent::Unknown;
    }
    let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
        return GrokEvent::Unknown;
    };
    let Some(kind) = v.get("type").and_then(|t| t.as_str()) else {
        return GrokEvent::Unknown;
    };
    match kind {
        "text" => GrokEvent::Text {
            text: str_field(&v, "data"),
        },
        "thought" => GrokEvent::Thought,
        "tool_call" => match v.get("toolCallId").and_then(|t| t.as_str()) {
            Some(id) if !id.is_empty() => GrokEvent::ToolCall {
                call_id: id.to_string(),
                title: opt_str(&v, "title"),
                kind: opt_str(&v, "kind"),
                tool_name: opt_str(&v, "toolName"),
            },
            // No id ⇒ nothing FR-15's `tool_call_update` could ever address.
            _ => GrokEvent::Unknown,
        },
        "tool_call_update" => match v.get("toolCallId").and_then(|t| t.as_str()) {
            Some(id) if !id.is_empty() => GrokEvent::ToolCallUpdate {
                call_id: id.to_string(),
                status: opt_str(&v, "status"),
            },
            _ => GrokEvent::Unknown,
        },
        "usage" => GrokEvent::ResponseUsage,
        "plan" => GrokEvent::Plan,
        "available_commands" => GrokEvent::AvailableCommands,
        "end" => GrokEvent::End {
            stop_reason: opt_str(&v, "stopReason"),
            usage: v
                .get("usage")
                .and_then(|u| serde_json::from_value::<Usage>(u.clone()).ok())
                .unwrap_or_default(),
        },
        "error" => GrokEvent::Error {
            message: v
                .get("message")
                .and_then(|m| m.as_str())
                .filter(|m| !m.trim().is_empty())
                .unwrap_or(UNKNOWN_ERROR)
                .to_string(),
        },
        _ => GrokEvent::Unknown,
    }
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|s| s.as_str())
        .unwrap_or_default()
        .to_string()
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|s| s.as_str()).map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- verified LIVE against grok 1.0.5, unauthenticated, in this
    // environment (module doc point 1) ----------

    #[test]
    fn a_real_unauthenticated_invocation_emits_this_exact_line() {
        // Captured verbatim: `grok -p "list the files here" --output-format
        // streaming-json` with no XAI_API_KEY and no `grok login` yet run.
        let line = r#"{"type":"error","message":"Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser."}"#;
        match parse_line(line) {
            GrokEvent::Error { message } => {
                assert!(message.starts_with("Not signed in."));
                assert!(message.contains("grok login --device-code"));
            }
            other => panic!("expected an error event, got {other:?}"),
        }
    }

    // ---------- FR-12: leniency ----------

    #[test]
    fn a_non_json_line_is_ignored_rather_than_fatal() {
        assert_eq!(parse_line(""), GrokEvent::Unknown);
        assert_eq!(parse_line("   "), GrokEvent::Unknown);
        assert_eq!(parse_line("{ truncated"), GrokEvent::Unknown);
        assert_eq!(parse_line("checking for updates..."), GrokEvent::Unknown);
    }

    #[test]
    fn valid_json_without_a_type_is_ignored() {
        assert_eq!(parse_line(r#"{"data":"x"}"#), GrokEvent::Unknown);
        assert_eq!(parse_line("[1,2,3]"), GrokEvent::Unknown);
    }

    #[test]
    fn an_unknown_event_type_is_ignored() {
        // The doc's own words: "Grok may also emit max_turns_reached and
        // auto_compact_* events; treat the list as non-exhaustive".
        assert_eq!(
            parse_line(r#"{"type":"max_turns_reached","limit":50}"#),
            GrokEvent::Unknown
        );
        assert_eq!(
            parse_line(r#"{"type":"auto_compact_started"}"#),
            GrokEvent::Unknown
        );
    }

    #[test]
    fn a_tool_call_or_update_with_no_id_is_ignored() {
        assert_eq!(
            parse_line(r#"{"type":"tool_call","title":"Read","kind":"read"}"#),
            GrokEvent::Unknown
        );
        assert_eq!(
            parse_line(r#"{"type":"tool_call_update","status":"completed"}"#),
            GrokEvent::Unknown
        );
    }

    // ---------- FR-14: text is a delta ----------

    #[test]
    fn text_carries_its_chunk() {
        assert_eq!(
            parse_line(r#"{"type":"text","data":"Here's a summary"}"#),
            GrokEvent::Text {
                text: "Here's a summary".into()
            }
        );
    }

    // ---------- FR-15: tool calls ----------

    #[test]
    fn a_tool_call_carries_its_id_title_kind_and_tool_name() {
        let ev = parse_line(
            r#"{"type":"tool_call","toolCallId":"call_1","title":"Read","kind":"read","status":"in_progress","toolName":"read_file","rawInput":{"path":"src/main.rs"},"content":[],"locations":[]}"#,
        );
        assert_eq!(
            ev,
            GrokEvent::ToolCall {
                call_id: "call_1".into(),
                title: Some("Read".into()),
                kind: Some("read".into()),
                tool_name: Some("read_file".into()),
            }
        );
    }

    #[test]
    fn a_tool_call_update_carries_its_id_and_status() {
        let ev = parse_line(
            r#"{"type":"tool_call_update","toolCallId":"call_1","status":"completed","content":[],"rawOutput":{"lines":42},"locations":[]}"#,
        );
        assert_eq!(
            ev,
            GrokEvent::ToolCallUpdate {
                call_id: "call_1".into(),
                status: Some("completed".into()),
            }
        );
    }

    // ---------- FR-18: dropped explicitly ----------

    #[test]
    fn thought_and_plan_parse_as_themselves_so_dropping_them_is_deliberate() {
        assert_eq!(
            parse_line(r#"{"type":"thought","data":"Analyzing the directory structure..."}"#),
            GrokEvent::Thought
        );
        assert_eq!(
            parse_line(r#"{"type":"plan","entries":[{"step":"read files"}]}"#),
            GrokEvent::Plan
        );
    }

    #[test]
    fn a_response_usage_line_is_recognised_but_carries_no_terminal_usage() {
        assert_eq!(
            parse_line(
                r#"{"type":"usage","messageId":"resp_1","stopReason":"end_turn","usage":{"input_tokens":812,"output_tokens":45},"signature":"sig_1"}"#
            ),
            GrokEvent::ResponseUsage
        );
    }

    #[test]
    fn available_commands_is_recognised_and_produces_no_block() {
        assert_eq!(
            parse_line(r#"{"type":"available_commands","tools":[],"commands":[]}"#),
            GrokEvent::AvailableCommands
        );
    }

    // ---------- FR-16/FR-17: end ----------

    #[test]
    fn end_carries_the_stop_reason_and_the_real_usage_field_names() {
        let ev = parse_line(
            r#"{"type":"end","stopReason":"end_turn","sessionId":"abc123","requestId":"xyz789","usage":{"input_tokens":812,"output_tokens":45,"cache_read_input_tokens":100,"cache_creation_input_tokens":0,"reasoning_tokens":10},"num_turns":1,"modelUsage":{}}"#,
        );
        match ev {
            GrokEvent::End { stop_reason, usage } => {
                assert_eq!(stop_reason.as_deref(), Some("end_turn"));
                assert_eq!(usage.input_tokens, 812);
                assert_eq!(usage.output_tokens, 45);
                assert_eq!(usage.cache_read_input_tokens, 100);
                // Cache occupies the window; reasoning is a SUBSET of output and
                // must not be added twice.
                assert_eq!(usage.context_used(), 812 + 100 + 45);
            }
            other => panic!("expected end, got {other:?}"),
        }
    }

    #[test]
    fn end_without_usage_reports_zero_rather_than_failing() {
        match parse_line(r#"{"type":"end","stopReason":"cancelled"}"#) {
            GrokEvent::End { stop_reason, usage } => {
                assert_eq!(stop_reason.as_deref(), Some("cancelled"));
                assert!(usage.is_zero());
            }
            other => panic!("expected end, got {other:?}"),
        }
    }

    #[test]
    fn error_lines_carry_a_message_and_never_a_blank_one() {
        assert_eq!(
            parse_line(r#"{"type":"error","message":"rate limited"}"#),
            GrokEvent::Error {
                message: "rate limited".into()
            }
        );
        assert_eq!(
            parse_line(r#"{"type":"error"}"#),
            GrokEvent::Error {
                message: UNKNOWN_ERROR.into()
            }
        );
        assert_eq!(
            parse_line(r#"{"type":"error","message":"   "}"#),
            GrokEvent::Error {
                message: UNKNOWN_ERROR.into()
            }
        );
    }

    // ---------- the whole captured (doc-derived) turn ----------

    /// FR-13 end to end: the doc-derived single-round turn (module doc point
    /// 2), replayed line by line. Every line is a real, recognised vocabulary
    /// member — nothing in this fixture is malformed on purpose (leniency is
    /// covered above, against literals, matching `codex`'s own split between
    /// "the clean fixture" and "the leniency tests").
    #[test]
    fn a_captured_turn_replays_into_the_expected_event_sequence() {
        let captured = include_str!("fixtures/exec_turn.jsonl");
        let events: Vec<GrokEvent> = captured.lines().map(parse_line).collect();

        assert!(matches!(events[0], GrokEvent::Text { .. }));
        assert!(matches!(events.last(), Some(GrokEvent::End { .. })));

        let unknown = events
            .iter()
            .filter(|e| matches!(e, GrokEvent::Unknown))
            .count();
        assert_eq!(
            unknown, 0,
            "unhandled lines in the captured turn: {events:?}"
        );

        let opened: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                GrokEvent::ToolCall { call_id, .. } => Some(call_id.as_str()),
                _ => None,
            })
            .collect();
        let completed: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                GrokEvent::ToolCallUpdate { call_id, .. } => Some(call_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(opened, vec!["call_1"]);
        assert_eq!(completed, vec!["call_1"]);
    }
}
