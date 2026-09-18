//! `type: "user"` lines carrying `tool_result` blocks: reconciles a
//! finished tool call (or subagent dispatch result) back onto its transcript
//! block and, for a `Task` dispatch, the agent record.

use super::{BlockKind, ToolRec};
use crate::session::*;

use serde_json::Value;
use std::collections::HashMap;

pub(crate) fn handle_tool_results(
    env: &dyn SessionEnv,
    session_id: &str,
    v: &Value,
    tools: &mut HashMap<String, ToolRec>,
    open_block: &mut Option<(String, BlockKind)>,
) {
    let content = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array());
    let Some(content) = content else { return };
    for item in content {
        if item.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
            continue;
        }
        let tuid = item
            .get("tool_use_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let is_error = item
            .get("is_error")
            .and_then(|val| val.as_bool())
            .unwrap_or(false);
        let result_text = extract_result_text(item.get("content"));
        let Some(rec) = tools.get(&tuid) else {
            continue;
        };
        let block_id = rec.block_id.clone();
        let meta = if is_error {
            "error".to_string()
        } else {
            tool_meta(&rec.tool, &rec.input, &result_text)
        };

        // command-inspect FR-1/FR-2/FR-9: capture BEFORE the block settles, so
        // `hasDetail` is right on the very first line ever persisted for this
        // block (FR-10). claude-code states neither exitCode nor separated
        // stderr (FR-4/FR-6), so both are `None` here.
        let has_detail = match env
            .engine()
            .with_session(session_id, |s| (s.cwd.clone(), s.runtime.clone()))
        {
            Some((cwd, runtime)) => {
                let detail = build_step_detail(
                    &rec.block_id,
                    &rec.tool,
                    &cwd,
                    &runtime,
                    rec.started_at,
                    now_ms(),
                    is_error,
                    None,
                    &rec.input,
                    &result_text,
                    None,
                );
                env.append_step_detail(session_id, &detail);
                true
            }
            None => false,
        };

        // The dispatch's own tool_result. async-agents FR-4/FR-5: a SYNCHRONOUS
        // dispatch completes here; a BACKGROUND dispatch's result is only a spawn
        // acknowledgement and must not stop the agent's clock (session-engine FR-39
        // is superseded — it treated every ack as completion).
        if rec.is_task {
            if let Some(aid) = rec.input.get("__agentId").and_then(|val| val.as_str()) {
                let ems = {
                    let mut map = env.engine().sessions.lock().unwrap();
                    match map.get_mut(session_id) {
                        Some(s) => apply_dispatch_result(s, aid, &result_text, is_error, now_ms()),
                        None => Vec::new(),
                    }
                };
                emit_agent_emissions(env, session_id, ems);
            }
        }

        // workflow-panel FR-6: the `Workflow` tool returns as soon as the run is
        // queued, so a successful result is a spawn ACK carrying the `wf_…` id —
        // only an error result ends the run here.
        if rec.is_workflow {
            if let Some(run_uuid) = rec.input.get("__workflowId").and_then(|val| val.as_str()) {
                on_workflow_dispatch_result(env, session_id, run_uuid, &result_text, is_error);
            }
        }

        let done_block = {
            let mut map = env.engine().sessions.lock().unwrap();
            match map.get_mut(session_id) {
                // transcript-scale CRITICAL fix: use the clone `buf_tool_done`
                // returns (captured before its internal trim runs) instead of
                // re-`find`ing by id — a re-find can miss a block that settling
                // itself just evicted.
                Some(s) => s.buf_tool_done(&block_id, meta.clone(), has_detail),
                None => None,
            }
        };
        if let Some(buf_block) = &done_block {
            env.append_transcript(session_id, buf_block); // durable-sessions FR-2
        }
        if matches!(open_block, Some((bid, _)) if *bid == block_id) {
            *open_block = None;
        }
        // FR-16: a file-mutating tool finished → recompute the diff summary now.
        if rec.tool == "Edit" || rec.tool == "Write" {
            if let Some(cwd) = env.engine().cwd_of(session_id) {
                env.note_file_diff(session_id, &cwd);
            }
        }
        env.emit_session(SessionEvent::ToolDone {
            session_id: session_id.into(),
            block_id,
            meta,
            has_detail: has_detail.then_some(true),
        });
    }
}

pub(crate) fn extract_result_text(content: Option<&Value>) -> String {
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

    #[test]
    fn extract_result_text_missing_defaults_empty() {
        assert_eq!(extract_result_text(None), "");
    }
}
