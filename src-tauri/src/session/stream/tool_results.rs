//! `type: "user"` lines carrying `tool_result` blocks: reconciles a
//! finished tool call (or subagent dispatch result) back onto its transcript
//! block and, for a `Task` dispatch, the agent record.

use super::{BlockKind, ToolRec};
use crate::session::*;

use serde_json::Value;
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

pub(crate) fn handle_tool_results(
    app: &AppHandle,
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

        // The dispatch's own tool_result. async-agents FR-4/FR-5: a SYNCHRONOUS
        // dispatch completes here; a BACKGROUND dispatch's result is only a spawn
        // acknowledgement and must not stop the agent's clock (session-engine FR-39
        // is superseded — it treated every ack as completion).
        if rec.is_task {
            if let Some(aid) = rec.input.get("__agentId").and_then(|val| val.as_str()) {
                let ems = {
                    let engine = app.state::<Engine>();
                    let mut map = engine.sessions.lock().unwrap();
                    match map.get_mut(session_id) {
                        Some(s) => apply_dispatch_result(s, aid, &result_text, is_error, now_ms()),
                        None => Vec::new(),
                    }
                };
                emit_agent_emissions(app, session_id, ems);
            }
        }

        // workflow-panel FR-6: the `Workflow` tool returns as soon as the run is
        // queued, so a successful result is a spawn ACK carrying the `wf_…` id —
        // only an error result ends the run here.
        if rec.is_workflow {
            if let Some(run_uuid) = rec.input.get("__workflowId").and_then(|val| val.as_str()) {
                on_workflow_dispatch_result(app, session_id, run_uuid, &result_text, is_error);
            }
        }

        let done_block = {
            let engine = app.state::<Engine>();
            let mut map = engine.sessions.lock().unwrap();
            match map.get_mut(session_id) {
                Some(s) => {
                    s.buf_tool_done(&block_id, meta.clone());
                    s.block_buffer
                        .iter()
                        .find(|block| block.block_id == block_id)
                        .cloned()
                }
                None => None,
            }
        };
        if let Some(buf_block) = &done_block {
            append_transcript(app, session_id, buf_block); // durable-sessions FR-2
        }
        if matches!(open_block, Some((bid, _)) if *bid == block_id) {
            *open_block = None;
        }
        // FR-16: a file-mutating tool finished → recompute the diff summary now.
        if rec.tool == "Edit" || rec.tool == "Write" {
            if let Some(cwd) = app.state::<Engine>().cwd_of(session_id) {
                crate::diff::on_tool_done(app, session_id, &cwd);
            }
        }
        emit(
            app,
            SessionEvent::ToolDone {
                session_id: session_id.into(),
                block_id,
                meta,
            },
        );
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

    #[test]
    fn extract_result_text_missing_defaults_empty() {
        assert_eq!(extract_result_text(None), "");
    }
}
