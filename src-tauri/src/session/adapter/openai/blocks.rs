//! Pure round-trip decision helpers (FR-6/FR-7/§7) and the transcript
//! block-emission helpers `runner.rs`'s loop drives them into. Split out of
//! `runner.rs` (PIPELINE.md §Code layout's ~1000-line ceiling) — same
//! one-concern-per-child pattern `gate.rs`/`tools.rs`/`wire.rs`/`thread.rs`/
//! `skills.rs` already follow. `pub(super)`: every item here is called from
//! `runner.rs`, a sibling module, not a descendant of this one.

use super::thread;
use super::wire;
use super::FrancoisTool;
use crate::session::*;

use serde_json::{json, Value};
use std::str::FromStr;
use tauri::{AppHandle, Manager};

// ---------- pure decision helpers (unit-tested below) ----------

/// FR-6: the round-trip cap — `attempted_rounds` is 1-based (the request
/// about to be sent), so hitting `MAX_ROUND_TRIPS + 1` is what ends the turn.
pub(super) fn round_trip_cap_hit(attempted_rounds: u32) -> bool {
    attempted_rounds > wire::MAX_ROUND_TRIPS
}

/// FR-7: refuse before the request when the PREVIOUS round's usage would
/// exceed the window. `None` (no prior usage yet) never refuses.
pub(super) fn context_exceeded(prompt_tokens: Option<u64>, limit: u64) -> bool {
    prompt_tokens.is_some_and(|t| t > limit)
}

/// §7: a tool name outside `FRANCOIS_TOOLS`, or malformed accumulated
/// arguments — either is an error string back to the model, never a card,
/// never an execution.
pub(super) fn tool_call_error(call: &wire::ToolCall) -> Option<String> {
    if FrancoisTool::from_str(&call.name).is_err() {
        return Some(format!("unknown tool \"{}\"", call.name));
    }
    match &call.arguments {
        Err(e) => Some(e.clone()),
        Ok(_) => None,
    }
}

/// FR-16: the wire shape of one accumulated call. A call whose arguments
/// failed to parse (FR-5) carries no recoverable raw JSON string (`wire.rs`
/// exposes only the parse `Result`, not the original text) — `"{}"` keeps the
/// persisted array syntactically valid for the next request rather than
/// smuggling an error message into a JSON-arguments field.
pub(super) fn thread_tool_call(call: &wire::ToolCall) -> thread::ThreadToolCall {
    let arguments = match &call.arguments {
        Ok(v) => serde_json::to_string(v).unwrap_or_else(|_| "{}".to_string()),
        Err(_) => "{}".to_string(),
    };
    thread::ThreadToolCall {
        id: call.id.clone(),
        kind: "function".to_string(),
        function: thread::ThreadToolCallFunction {
            name: call.name.clone(),
            arguments,
        },
    }
}

/// FR-3/FR-23: the request's `messages` array — the persisted wire messages,
/// with the (never-persisted, FR-25) skill system block prepended when one
/// was injected.
///
/// response-mode FR-8: the response directive is a second `role: "system"`
/// message, AFTER the skill block and BEFORE the thread's own messages. Like
/// the skill block it is never persisted to the thread file and is rebuilt per
/// request, so a mode change takes effect on the very next call — and
/// `Default`, being the absence of an instruction, pushes nothing.
pub(super) fn build_request_messages(
    skill_text: &str,
    response_mode: crate::session::ResponseMode,
    messages: &[thread::ThreadMessage],
) -> Vec<Value> {
    let mut out = Vec::with_capacity(messages.len() + 2);
    if !skill_text.is_empty() {
        out.push(json!({ "role": "system", "content": skill_text }));
    }
    if let Some(directive) = response_mode.directive() {
        out.push(json!({ "role": "system", "content": directive }));
    }
    for m in messages {
        out.push(serde_json::to_value(m).unwrap_or(Value::Null));
    }
    out
}

// ---------- transcript block helpers ----------

pub(super) fn emit_tool_block(
    app: &AppHandle,
    session_id: &str,
    block_id: &str,
    tool: &str,
    summary: &str,
) {
    let block = app
        .state::<Engine>()
        .with_session_mut(session_id, |s| {
            s.buf_tool(block_id, tool.to_string(), summary.to_string(), false, None);
            s.block_buffer.last().cloned()
        })
        .flatten();
    if let Some(b) = &block {
        append_transcript(app, session_id, b);
    }
    emit(
        app,
        SessionEvent::ToolStart {
            session_id: session_id.to_string(),
            block_id: block_id.to_string(),
            tool: tool.to_string(),
            summary: summary.to_string(),
            model: None,
        },
    );
}

/// `has_detail` (command-inspect FR-1/FR-10): whether the caller already
/// wrote a `StepDetail` sidecar record for this block — decided (and, if so,
/// written) by the caller BEFORE this settles the block, so the flag is right
/// on the first line ever persisted for it. `process_tool_call` is the only
/// caller with the raw input/result this needs; the pre-execution
/// error/cancelled paths pass `false` (no completion data exists to capture).
pub(super) fn finish_tool_block(
    app: &AppHandle,
    session_id: &str,
    block_id: &str,
    cwd: &str,
    tool: &str,
    meta: &str,
    has_detail: bool,
) {
    // transcript-scale CRITICAL fix: use the clone `buf_tool_done` returns
    // (captured before its internal trim runs) instead of re-`find`ing by id
    // — a re-find can miss a block that settling itself just evicted.
    let block = app
        .state::<Engine>()
        .with_session_mut(session_id, |s| {
            s.buf_tool_done(block_id, meta.to_string(), has_detail)
        })
        .flatten();
    if let Some(b) = &block {
        append_transcript(app, session_id, b);
    }
    // Same trigger tool_results.rs uses for the Claude path: a file-mutating
    // tool finished, so the diff-view summary needs recomputing.
    if matches!(tool, "Edit" | "Write") {
        crate::diff::on_tool_done(app, session_id, cwd);
    }
    emit(
        app,
        SessionEvent::ToolDone {
            session_id: session_id.to_string(),
            block_id: block_id.to_string(),
            meta: meta.to_string(),
            has_detail: has_detail.then_some(true),
        },
    );
}

pub(super) fn buf_assistant_delta(
    app: &AppHandle,
    session_id: &str,
    block_id: &str,
    chunk: &str,
    accumulated: &str,
) {
    app.state::<Engine>().with_session_mut(session_id, |s| {
        s.buf_assistant_streaming(block_id, chunk, accumulated);
    });
}

/// Finalize whatever text was open when a round ended (`finish_reason:
/// "stop"`, or text ahead of a tool call in the same response). Defensive
/// fallback when no delta ever opened a block but the terminal text is
/// non-empty regardless (not expected from the Chat Completions dialect,
/// which always streams `delta.content` fragments, but never silently drops
/// text from the transcript either way).
pub(super) fn finalize_open_text(
    app: &AppHandle,
    session_id: &str,
    block_id: &Option<String>,
    text: &str,
) {
    if let Some(block_id) = block_id {
        finalize_text_block(app, session_id, block_id, text.to_string());
    } else if !text.is_empty() {
        let block_id = uuid();
        finalize_text_block(app, session_id, &block_id, text.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- round-trip cap (FR-6) ----------

    #[test]
    fn the_cap_trips_one_past_max_round_trips() {
        assert!(!round_trip_cap_hit(wire::MAX_ROUND_TRIPS));
        assert!(round_trip_cap_hit(wire::MAX_ROUND_TRIPS + 1));
        assert!(!round_trip_cap_hit(1));
    }

    // ---------- context refusal (FR-7) ----------

    #[test]
    fn context_exceeded_refuses_only_when_the_prior_usage_is_over_the_limit() {
        assert!(!context_exceeded(None, 128_000)); // nothing seen yet — never refuses
        assert!(!context_exceeded(Some(128_000), 128_000)); // exactly at the limit is fine
        assert!(context_exceeded(Some(128_001), 128_000));
    }

    // ---------- §7: the unknown-tool / malformed-arguments path ----------

    #[test]
    fn an_unknown_tool_name_is_an_error_string_naming_it() {
        let call = wire::ToolCall {
            id: "c1".into(),
            name: "RunShellCommand".into(),
            arguments: Ok(json!({})),
        };
        assert_eq!(
            tool_call_error(&call).as_deref(),
            Some("unknown tool \"RunShellCommand\"")
        );
    }

    #[test]
    fn malformed_arguments_surface_their_own_parse_error() {
        let call = wire::ToolCall {
            id: "c1".into(),
            name: "Bash".into(),
            arguments: Err("malformed tool call arguments: EOF".into()),
        };
        assert_eq!(
            tool_call_error(&call).as_deref(),
            Some("malformed tool call arguments: EOF")
        );
    }

    #[test]
    fn a_known_tool_with_valid_arguments_has_no_call_error() {
        let call = wire::ToolCall {
            id: "c1".into(),
            name: "Read".into(),
            arguments: Ok(json!({ "file_path": "a.ts" })),
        };
        assert_eq!(tool_call_error(&call), None);
    }

    // ---------- thread_tool_call (FR-16) ----------

    #[test]
    fn thread_tool_call_reserializes_parsed_arguments() {
        let call = wire::ToolCall {
            id: "call_1".into(),
            name: "Bash".into(),
            arguments: Ok(json!({ "command": "echo hi" })),
        };
        let ttc = thread_tool_call(&call);
        assert_eq!(ttc.id, "call_1");
        assert_eq!(ttc.kind, "function");
        assert_eq!(ttc.function.name, "Bash");
        let parsed: Value = serde_json::from_str(&ttc.function.arguments).unwrap();
        assert_eq!(parsed, json!({ "command": "echo hi" }));
    }

    #[test]
    fn thread_tool_call_falls_back_to_an_empty_object_when_arguments_never_parsed() {
        let call = wire::ToolCall {
            id: "call_1".into(),
            name: "Bash".into(),
            arguments: Err("malformed tool call arguments: EOF".into()),
        };
        let ttc = thread_tool_call(&call);
        assert_eq!(ttc.function.arguments, "{}");
    }

    // ---------- build_request_messages (FR-3/FR-23/FR-25) ----------

    #[test]
    fn no_skill_block_sends_the_persisted_messages_verbatim() {
        let messages = vec![thread::ThreadMessage {
            role: "user".into(),
            content: Some("hi".into()),
            tool_calls: None,
            tool_call_id: None,
        }];
        let out = build_request_messages("", crate::session::ResponseMode::Default, &messages);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "user");
    }

    #[test]
    fn a_skill_block_is_prepended_as_a_system_message_and_never_mutates_the_thread() {
        let messages = vec![thread::ThreadMessage {
            role: "user".into(),
            content: Some("hi".into()),
            tool_calls: None,
            tool_call_id: None,
        }];
        let out = build_request_messages(
            "skill: do the thing\n",
            crate::session::ResponseMode::Default,
            &messages,
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["role"], "system");
        assert_eq!(out[0]["content"], "skill: do the thing\n");
        assert_eq!(out[1]["role"], "user");
        // The caller's `messages` slice — what gets persisted — is untouched.
        assert_eq!(messages.len(), 1);
    }

    // ---------- response-mode FR-8 (the francois loop) ----------

    #[test]
    fn the_default_response_mode_pushes_no_system_message() {
        // FR-8: 'default' is the absence of an instruction, so nothing is pushed.
        let messages = vec![thread::ThreadMessage {
            role: "user".into(),
            content: Some("hi".into()),
            tool_calls: None,
            tool_call_id: None,
        }];
        let out = build_request_messages("", crate::session::ResponseMode::Default, &messages);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "user");
    }

    #[test]
    fn the_response_directive_sits_after_the_skill_block_and_before_the_thread() {
        use crate::session::ResponseMode;
        let messages = vec![thread::ThreadMessage {
            role: "user".into(),
            content: Some("hi".into()),
            tool_calls: None,
            tool_call_id: None,
        }];
        let out =
            build_request_messages("skill: do the thing\n", ResponseMode::Learning, &messages);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["content"], "skill: do the thing\n");
        assert_eq!(out[1]["role"], "system");
        assert_eq!(
            out[1]["content"],
            ResponseMode::Learning.directive().unwrap()
        );
        assert_eq!(out[2]["role"], "user");
        // FR-8: rebuilt per request and NEVER persisted — the caller's slice,
        // which is what gets written to the thread file, is untouched.
        assert_eq!(messages.len(), 1);
    }
}
