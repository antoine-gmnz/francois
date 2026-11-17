//! `type: "user"` lines carrying `tool_result` blocks: reconciles a
//! finished tool call (or subagent dispatch result) back onto its transcript
//! block and, for a `Task` dispatch, the agent record.

use super::{BlockKind, StreamEnvironment, ToolRec};
use crate::session::application::RuntimeEvent;
use crate::session::{build_step_detail, now_ms, tool_meta};

use serde_json::Value;
use std::collections::HashMap;

pub fn handle_tool_results(
    env: &dyn StreamEnvironment,
    session_id: &str,
    v: &Value,
    tools: &mut HashMap<String, ToolRec>,
    open_block: &mut Option<(String, BlockKind)>,
) {
    let Some(content) = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    let settings = env.settings(session_id);
    for item in content {
        if item.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let tuid = item
            .get("tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let is_error = item
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let result_text = extract_result_text(item.get("content"));
        let Some(rec) = tools.get(tuid) else {
            continue;
        };
        // A Task/Workflow dispatch settles a subagent banner, which has no
        // tone slot to say "refused" — it keeps the plain `error` meta.
        let dispatch = rec.is_task || rec.is_workflow;
        let (meta, tone) = settle_meta(is_error, dispatch, &rec.tool, &rec.input, &result_text);
        let detail = build_step_detail(
            &rec.block_id,
            &rec.tool,
            &settings.cwd,
            &settings.runtime,
            rec.started_at,
            now_ms(),
            is_error,
            None,
            &rec.input,
            &result_text,
            None,
        );
        if rec.is_task {
            if let Some(agent_id) = rec.input.get("__agentId").and_then(Value::as_str) {
                env.publish(RuntimeEvent::SubagentResult {
                    agent_id: agent_id.into(),
                    text: result_text.clone(),
                    is_error,
                    at: now_ms(),
                });
            }
        }
        if rec.is_workflow {
            if let Some(run_id) = rec.input.get("__workflowId").and_then(Value::as_str) {
                env.publish(RuntimeEvent::WorkflowResult {
                    run_id: run_id.into(),
                    text: result_text.clone(),
                    is_error,
                });
            }
        }
        if matches!(open_block, Some((id, _)) if id == &rec.block_id) {
            *open_block = None;
        }
        env.publish(RuntimeEvent::ToolCompleted {
            block_id: rec.block_id.clone(),
            meta,
            detail: Some(detail),
            affects_workspace: matches!(rec.tool.as_str(), "Edit" | "Write"),
            tone,
        });
    }
}

/// `ToolResultTone` values (contract/common.ts) — hook-diagnostics.
pub const TONE_ERROR: &str = "error";
pub const TONE_HOOK_REFUSAL: &str = "hookRefusal";
/// The inline reason is a glance, not the record: the full text stays in the
/// StepDetail (`build_step_detail` gets the untouched result text).
pub const HOOK_REASON_MAX_CHARS: usize = 100;

/// A settled result's `(meta, tone)`. A clean result keeps `tool_meta` and no
/// tone; an `is_error` one is tagged explicitly so the row's colour never
/// rests on the meta happening to contain the word "error" — and a PreToolUse
/// refusal carries its reason as the meta instead of a bare "error".
fn settle_meta(
    is_error: bool,
    dispatch: bool,
    tool: &str,
    input: &Value,
    result_text: &str,
) -> (String, Option<String>) {
    if !is_error {
        return (tool_meta(tool, input, result_text), None);
    }
    match hook_refusal_reason(result_text).filter(|_| !dispatch) {
        Some(reason) => (reason, Some(TONE_HOOK_REFUSAL.into())),
        None => ("error".into(), Some(TONE_ERROR.into())),
    }
}

/// Claude Code reports a PreToolUse hook that blocked a call (a `deny`, or a
/// fail-closed hook that could not run) as an `is_error` tool_result whose
/// text is `PreToolUse:<Tool> hook error: <reason>`. Returns the reason's
/// first line, trimmed and capped at [`HOOK_REASON_MAX_CHARS`] characters
/// (`…` when cut) — `None` when the text is not in that shape. An empty
/// reason reads as `refused` so the meta is never blank.
pub fn hook_refusal_reason(text: &str) -> Option<String> {
    let rest = text.strip_prefix("PreToolUse:")?;
    let (tool, reason) = rest.split_once(" hook error: ")?;
    if tool.is_empty() || tool.contains(char::is_whitespace) {
        return None;
    }
    let first = reason.lines().next().unwrap_or("").trim();
    if first.is_empty() {
        return Some("refused".into());
    }
    // chars, never a byte slice: a cut mid-codepoint would panic on the
    // reader thread.
    if first.chars().count() <= HOOK_REASON_MAX_CHARS {
        return Some(first.to_string());
    }
    let mut cut: String = first.chars().take(HOOK_REASON_MAX_CHARS - 1).collect();
    cut.push('\u{2026}');
    Some(cut)
}

pub fn extract_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::*;
    use crate::session::{classify_block, SessionEvent, StepBody};
    use serde_json::json;

    #[test]
    fn command_output_without_started_inserts_block() {
        // the FR-11/FR-13 instant-notice cases arrive without a command.started
        let mut s = test_session();
        s.buf_command_output(
            "c9",
            "model",
            json!({ "kind": "notice", "text": "model \u{2192} Opus" }),
        );
        assert_eq!(s.block_buffer.len(), 1);
        assert!(!s.block_buffer[0].streaming);
        assert_eq!(s.block_buffer[0].tool, "model");
    }

    // ---------- extract_result_text (tool_result content) ----------

    #[test]
    fn extract_result_text_string_passthrough() {
        assert_eq!(extract_result_text(Some(&json!("hello"))), "hello");
    }

    #[test]
    fn extract_result_text_joins_array_parts() {
        let content = json!([{ "text": "a" }, { "text": "b" }]);
        assert_eq!(extract_result_text(Some(&content)), "a\nb");
    }

    // ---------- command-inspect FR-1/FR-2/FR-9/FR-10: capture on settle ----------

    #[test]
    fn a_settled_bash_call_captures_a_step_detail_and_flags_hasdetail() {
        use crate::session::testenv::TestEnv;
        use std::collections::HashMap;

        let mut session = test_session(); // cwd "/x", runtime "native" (testutil.rs)
        session.buf_tool("b1", "Bash".into(), "npm test".into(), false, None);
        let env = TestEnv {
            engine: crate::session::testutil::test_engine_with(session),
            ..Default::default()
        };
        let mut tools = HashMap::new();
        tools.insert(
            "toolu_1".to_string(),
            ToolRec {
                block_id: "b1".into(),
                tool: "Bash".into(),
                input: json!({ "command": "npm test" }),
                is_task: false,
                is_workflow: false,
                started_at: 1_000,
            },
        );
        let mut open_block = Some(("b1".to_string(), BlockKind::Tool));
        let v = json!({
            "type": "user",
            "message": { "content": [{
                "type": "tool_result", "tool_use_id": "toolu_1",
                "is_error": true, "content": "14 failed\n",
            }] },
        });

        handle_tool_results(&env, "s1", &v, &mut tools, &mut open_block);

        // FR-1: exactly one record, on session "s1".
        let details = env.step_details.lock().unwrap();
        assert_eq!(details.len(), 1);
        let (sid, detail) = &details[0];
        assert_eq!(sid, "s1");
        assert_eq!(detail.block_id, "b1");
        assert_eq!(detail.tool, "Bash");
        assert_eq!(detail.cwd, "/x");
        assert_eq!(detail.runtime, "native");
        assert_eq!(detail.started_at, 1_000);
        assert!(detail.is_error);
        assert!(detail.exit_code.is_none()); // claude-code never states one (FR-4)
        match &detail.body {
            StepBody::Command { command, output } => {
                assert_eq!(command.command, "npm test");
                assert_eq!(output.text, "14 failed\n");
                assert!(output.stderr_lines.is_none()); // FR-6
            }
            other => panic!("expected a command body, got {other:?}"),
        }
        drop(details);

        // FR-10: the event and the settled block both carry the flag.
        let events = env.session_events.lock().unwrap();
        assert!(matches!(
            events.last(),
            Some(SessionEvent::ToolDone {
                has_detail: Some(true),
                ..
            })
        ));
        drop(events);
        let block = env
            .engine
            .with_session("s1", |s| classify_block(&s.block_buffer[0]))
            .unwrap();
        assert_eq!(block["hasDetail"], true);
    }

    #[test]
    fn a_settled_non_bash_call_captures_a_generic_body() {
        use crate::session::testenv::TestEnv;
        use std::collections::HashMap;

        let mut session = test_session();
        session.buf_tool("b1", "Read".into(), "a.rs".into(), false, None);
        let env = TestEnv {
            engine: crate::session::testutil::test_engine_with(session),
            ..Default::default()
        };
        let mut tools = HashMap::new();
        tools.insert(
            "toolu_1".to_string(),
            ToolRec {
                block_id: "b1".into(),
                tool: "Read".into(),
                input: json!({ "file_path": "a.rs" }),
                is_task: false,
                is_workflow: false,
                started_at: 0,
            },
        );
        let mut open_block = None;
        let v = json!({
            "type": "user",
            "message": { "content": [{
                "type": "tool_result", "tool_use_id": "toolu_1", "content": "l1\nl2\n",
            }] },
        });

        handle_tool_results(&env, "s1", &v, &mut tools, &mut open_block);

        let details = env.step_details.lock().unwrap();
        match &details[0].1.body {
            StepBody::Generic { input_json, output } => {
                assert!(input_json.contains("\"file_path\""));
                assert_eq!(output.text, "l1\nl2\n");
            }
            other => panic!("expected a generic body, got {other:?}"),
        }
        assert!(!details[0].1.is_error);
    }

    // ---------- hook-diagnostics: PreToolUse refusals ----------

    #[test]
    fn hook_refusal_reason_takes_the_text_after_the_prefix() {
        assert_eq!(
            hook_refusal_reason("PreToolUse:Bash hook error: stub-gate: DENYME is forbidden")
                .as_deref(),
            Some("stub-gate: DENYME is forbidden")
        );
        // An MCP tool name is not the tool_use's display name — never compared.
        assert_eq!(
            hook_refusal_reason("PreToolUse:mcp__db__query hook error:  nope \nmore").as_deref(),
            Some("nope")
        );
        assert_eq!(
            hook_refusal_reason("PreToolUse:Bash hook error: ").as_deref(),
            Some("refused")
        );
    }

    #[test]
    fn hook_refusal_reason_ignores_other_errors() {
        for text in [
            "",
            "14 failed",
            "francois-bench: denied by user",
            "PostToolUse:Bash hook error: x",
            "PreToolUse:Bash failed: x",
            "PreToolUse: hook error: x",
            "see PreToolUse:Bash hook error: x",
        ] {
            assert_eq!(hook_refusal_reason(text), None, "{text:?}");
        }
    }

    #[test]
    fn a_refused_dispatch_keeps_the_plain_error_meta() {
        let text = "PreToolUse:Task hook error: no subagents here";
        let input = json!({});
        assert_eq!(
            settle_meta(true, true, "Task", &input, text),
            ("error".to_string(), Some(TONE_ERROR.to_string()))
        );
        assert_eq!(
            settle_meta(true, false, "Bash", &input, text).1.as_deref(),
            Some(TONE_HOOK_REFUSAL)
        );
    }

    #[test]
    fn hook_refusal_reason_caps_on_chars_not_bytes() {
        let long = format!("PreToolUse:Bash hook error: {}", "é".repeat(300));
        let reason = hook_refusal_reason(&long).unwrap();
        assert_eq!(reason.chars().count(), HOOK_REASON_MAX_CHARS);
        assert!(reason.ends_with('\u{2026}'));
        let exact = format!("PreToolUse:Bash hook error: {}", "a".repeat(100));
        assert_eq!(hook_refusal_reason(&exact).unwrap().len(), 100);
    }

    /// Replays a `claude` 2.1.326 capture (production argv, see
    /// `adapter/claude_code.rs`) through the whole parse path. The captures
    /// were trimmed to the lines that matter (assistant `tool_use`, the
    /// control_request, the tool_result, the result) — the three leading
    /// `stream_event` lines (content_block_start / input_json_delta / stop)
    /// were reconstructed verbatim from the captured `tool_use`, because the
    /// parser registers a tool call from the partial-message stream, not from
    /// the final assistant message.
    fn replay(fixture: &str) -> crate::session::testenv::TestEnv {
        use crate::session::testenv::TestEnv;
        use std::sync::{Arc, Mutex};
        let env = TestEnv {
            engine: crate::session::testutil::test_engine_with(test_session()),
            ..Default::default()
        };
        let stdin = Arc::new(Mutex::new(None));
        let questions = Arc::new(Mutex::new(HashMap::new()));
        let permissions = Arc::new(Mutex::new(HashMap::new()));
        crate::session::stream::parse_stream(
            &env,
            "s1",
            std::io::Cursor::new(fixture.as_bytes()),
            &stdin,
            &questions,
            &permissions,
            None,
        );
        env
    }

    fn tool_done(env: &crate::session::testenv::TestEnv) -> (String, Option<String>) {
        let events = env.session_events.lock().unwrap();
        let dones: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::ToolDone { meta, tone, .. } => Some((meta.clone(), tone.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(dones.len(), 1, "exactly one tool.done expected: {dones:?}");
        dones[0].clone()
    }

    #[test]
    fn a_hook_deny_capture_settles_with_its_reason_and_the_refusal_tone() {
        let env = replay(include_str!("fixtures/hook-deny.ndjson"));
        let (meta, tone) = tool_done(&env);
        assert_eq!(meta, "stub-gate: DENYME is forbidden");
        assert_eq!(tone.as_deref(), Some(TONE_HOOK_REFUSAL));
        // The step detail keeps the untouched text.
        let details = env.step_details.lock().unwrap();
        match &details[0].1.body {
            StepBody::Command { output, .. } => assert_eq!(
                output.text,
                "PreToolUse:Bash hook error: stub-gate: DENYME is forbidden"
            ),
            other => panic!("expected a command body, got {other:?}"),
        }
        drop(details);
        // …and the settled block carries both into the transcript/IPC shape.
        let block = env
            .engine
            .with_session("s1", |s| {
                classify_block(
                    s.block_buffer
                        .iter()
                        .find(|b| matches!(b.kind, crate::session::BlockKind::Tool))
                        .unwrap(),
                )
            })
            .unwrap();
        assert_eq!(block["meta"], "stub-gate: DENYME is forbidden");
        assert_eq!(block["tone"], "hookRefusal");
    }

    #[test]
    fn a_fail_closed_hook_without_its_interpreter_shows_the_first_line_only() {
        let env = replay(include_str!("fixtures/hook-nopython.ndjson"));
        let (meta, tone) = tool_done(&env);
        assert_eq!(
            meta,
            r#"[python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/gate.py"]: failed; blocking because onFailure is "block""#
        );
        assert!(!meta.contains("command not found"));
        assert_eq!(tone.as_deref(), Some(TONE_HOOK_REFUSAL));
    }

    #[test]
    fn a_user_denial_is_an_ordinary_error_with_an_explicit_tone() {
        // The ASKME capture: the bench answered the hook's `ask` with a deny,
        // so the result is NOT a hook refusal.
        let env = replay(include_str!("fixtures/hook-ask-default.ndjson"));
        let (meta, tone) = tool_done(&env);
        assert_eq!(meta, "error");
        assert_eq!(tone.as_deref(), Some(TONE_ERROR));
    }

    #[test]
    fn a_hook_ask_reaches_the_frontend_with_its_reason() {
        let env = replay(include_str!("fixtures/hook-ask-bypass.ndjson"));
        let events = env.session_events.lock().unwrap();
        let ask = events
            .iter()
            .find_map(|e| match e {
                SessionEvent::PermissionAsked { ask, .. } => Some(ask.clone()),
                _ => None,
            })
            .expect("a permission.asked event");
        let v = serde_json::to_value(&ask).unwrap();
        assert_eq!(v["decisionReason"], "stub-gate: ASKME needs confirmation");
        assert_eq!(v["decisionReasonType"], "hook");
        assert_eq!(v["decisionReasonHookEvent"], "PreToolUse");
    }

    #[test]
    fn a_clean_result_carries_no_tone_on_the_wire() {
        let ev = SessionEvent::ToolDone {
            session_id: "s".into(),
            block_id: "b".into(),
            meta: "3 lines".into(),
            has_detail: None,
            tone: None,
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert!(v.get("tone").is_none(), "{v}");
        let ev = SessionEvent::ToolDone {
            session_id: "s".into(),
            block_id: "b".into(),
            meta: "x".into(),
            has_detail: None,
            tone: Some(TONE_HOOK_REFUSAL.into()),
        };
        assert_eq!(serde_json::to_value(&ev).unwrap()["tone"], "hookRefusal");
    }

    #[test]
    fn extract_result_text_missing_defaults_empty() {
        assert_eq!(extract_result_text(None), "");
    }
}
