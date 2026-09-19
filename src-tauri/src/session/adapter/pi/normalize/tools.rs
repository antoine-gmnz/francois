//! session/adapter/pi/normalize/tools.rs — pi-transcript-events FR-3/FR-4:
//! the generic tool-call lifecycle half of `TranscriptReducer` — argument
//! generation (`toolcall_*`), execution (`tool_execution_*`), and the
//! exactly-once settle shared with `message_end.toolResult`. The data model
//! (`ToolState`, `ToolStatus`) stays in `mod.rs` with the rest of the reducer.

use super::{bound_preview, protocol_error, str_field, ToolState, ToolStatus, TranscriptReducer};
use crate::session::events::RuntimeEventPayload;
use serde_json::Value;

fn settle_tool(tool: &mut ToolState, is_error: bool, output: &str, now_ms: u64) {
    let (bounded, truncated) = bound_preview(output);
    tool.output_text = bounded;
    tool.output_truncated = truncated;
    tool.status = if is_error {
        ToolStatus::Failed
    } else {
        ToolStatus::Succeeded
    };
    tool.completed_at = Some(now_ms);
    tool.settled = true;
}

impl TranscriptReducer {
    pub(super) fn reconcile_tool_result(
        &mut self,
        raw: &Value,
        now_ms: u64,
    ) -> Option<RuntimeEventPayload> {
        let Some(tool_call_id) = str_field(raw, "toolCallId") else {
            return Some(protocol_error(
                "message_end toolResult is missing toolCallId",
            ));
        };
        let Some(is_error) = raw.get("isError").and_then(Value::as_bool) else {
            return Some(protocol_error("message_end toolResult is missing isError"));
        };
        let output = raw.get("output").and_then(Value::as_str).unwrap_or("");
        let tool = self.tools.get_mut(tool_call_id)?;
        if tool.settled {
            return None; // FR-3: settle exactly once
        }
        settle_tool(tool, is_error, output, now_ms);
        let event = RuntimeEventPayload::ToolUpdate {
            block_id: tool.block_id.clone(),
            tool: tool.to_call(tool_call_id),
        };
        // pi-transcript-events (review remediation): bounded eviction, same
        // rationale as `note_message_finalized` — `tools` otherwise grows
        // for the connection's lifetime.
        self.note_tool_settled(tool_call_id);
        Some(event)
    }

    // ---------------------------------------------------------- tool calls

    pub(super) fn on_toolcall_start(&mut self, raw: &Value) -> Vec<RuntimeEventPayload> {
        let (Some(tool_call_id), Some(name)) =
            (str_field(raw, "toolCallId"), str_field(raw, "name"))
        else {
            return vec![protocol_error("toolcall_start is missing toolCallId/name")];
        };
        // FR-3/FR-8 (review round 2): `entry(...).or_insert_with(...)`, same
        // as `on_message_start` — a REPLAYED start for an already-tracked
        // toolCallId must reuse the existing block/state, never mint a
        // second `ToolState` (a fresh insert would orphan the first block
        // and duplicate the tool row).
        let tool = self
            .tools
            .entry(tool_call_id.to_string())
            .or_insert_with(|| {
                // FR-3 acceptance: "A tool is not shown running during argument
                // generation" — pending, not running, until tool_execution_start.
                ToolState {
                    block_id: crate::ids::uuid(),
                    name: name.to_string(),
                    status: ToolStatus::Pending,
                    input_text: String::new(),
                    output_text: String::new(),
                    input_truncated: false,
                    output_truncated: false,
                    started_at: None,
                    completed_at: None,
                    settled: false,
                }
            });
        let block_id = tool.block_id.clone();
        let call = tool.to_call(tool_call_id);
        vec![RuntimeEventPayload::ToolUpdate {
            block_id,
            tool: call,
        }]
    }

    pub(super) fn on_toolcall_delta(&mut self, raw: &Value) -> Vec<RuntimeEventPayload> {
        let (Some(tool_call_id), Some(delta)) =
            (str_field(raw, "toolCallId"), str_field(raw, "inputDelta"))
        else {
            return vec![protocol_error(
                "toolcall_delta is missing toolCallId/inputDelta",
            )];
        };
        let Some(tool) = self.tools.get_mut(tool_call_id) else {
            return Vec::new(); // no matching call tracked — nothing to accumulate onto
        };
        if tool.settled {
            return Vec::new();
        }
        if !tool.input_truncated {
            tool.input_text.push_str(delta);
            let (bounded, truncated) = bound_preview(&tool.input_text);
            tool.input_text = bounded;
            tool.input_truncated = truncated;
        }
        vec![RuntimeEventPayload::ToolUpdate {
            block_id: tool.block_id.clone(),
            tool: tool.to_call(tool_call_id),
        }]
    }

    pub(super) fn on_toolcall_end(&mut self, raw: &Value) -> Vec<RuntimeEventPayload> {
        let (Some(tool_call_id), Some(input)) =
            (str_field(raw, "toolCallId"), str_field(raw, "input"))
        else {
            return vec![protocol_error("toolcall_end is missing toolCallId/input")];
        };
        let Some(tool) = self.tools.get_mut(tool_call_id) else {
            return Vec::new();
        };
        if tool.settled {
            return Vec::new();
        }
        // FR-3: "tool-call argument generation is not execution" — the
        // AUTHORITATIVE input, replacing whatever toolcall_delta accumulated.
        let (bounded, truncated) = bound_preview(input);
        tool.input_text = bounded;
        tool.input_truncated = truncated;
        vec![RuntimeEventPayload::ToolUpdate {
            block_id: tool.block_id.clone(),
            tool: tool.to_call(tool_call_id),
        }]
    }

    pub(super) fn on_tool_execution_start(
        &mut self,
        raw: &Value,
        now_ms: u64,
    ) -> Vec<RuntimeEventPayload> {
        let Some(tool_call_id) = str_field(raw, "toolCallId") else {
            return vec![protocol_error("tool_execution_start is missing toolCallId")];
        };
        let Some(tool) = self.tools.get_mut(tool_call_id) else {
            return Vec::new(); // defensive: execution reported for an untracked call
        };
        if tool.settled {
            return Vec::new();
        }
        tool.status = ToolStatus::Running;
        tool.started_at = Some(tool.started_at.unwrap_or(now_ms));
        vec![RuntimeEventPayload::ToolUpdate {
            block_id: tool.block_id.clone(),
            tool: tool.to_call(tool_call_id),
        }]
    }

    pub(super) fn on_tool_execution_update(&mut self, raw: &Value) -> Vec<RuntimeEventPayload> {
        let (Some(tool_call_id), Some(progress)) =
            (str_field(raw, "toolCallId"), str_field(raw, "progress"))
        else {
            return vec![protocol_error(
                "tool_execution_update is missing toolCallId/progress",
            )];
        };
        let Some(tool) = self.tools.get_mut(tool_call_id) else {
            return Vec::new();
        };
        if tool.settled {
            return Vec::new();
        }
        // FR-3: "treat Pi tool progress as a snapshot unless the certified
        // field is explicitly a delta" — replaces, never concatenates.
        let (bounded, truncated) = bound_preview(progress);
        tool.output_text = bounded;
        tool.output_truncated = truncated;
        vec![RuntimeEventPayload::ToolUpdate {
            block_id: tool.block_id.clone(),
            tool: tool.to_call(tool_call_id),
        }]
    }

    pub(super) fn on_tool_execution_end(
        &mut self,
        raw: &Value,
        now_ms: u64,
    ) -> Vec<RuntimeEventPayload> {
        let (Some(tool_call_id), Some(is_error)) = (
            str_field(raw, "toolCallId"),
            raw.get("isError").and_then(Value::as_bool),
        ) else {
            return vec![protocol_error(
                "tool_execution_end is missing toolCallId/isError",
            )];
        };
        let output = raw.get("output").and_then(Value::as_str).unwrap_or("");
        let Some(tool) = self.tools.get_mut(tool_call_id) else {
            return Vec::new();
        };
        if tool.settled {
            return Vec::new(); // FR-3: settle exactly once
        }
        settle_tool(tool, is_error, output, now_ms);
        let event = RuntimeEventPayload::ToolUpdate {
            block_id: tool.block_id.clone(),
            tool: tool.to_call(tool_call_id),
        };
        // pi-transcript-events (review remediation): same bounded eviction
        // as `reconcile_tool_result`.
        self.note_tool_settled(tool_call_id);
        vec![event]
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::tool_update;
    use super::super::{TranscriptReducer, PREVIEW_BYTES};
    use crate::session::events::RuntimeEventPayload;
    use serde_json::json;

    // ---------------------------------------------------------- FR-3/FR-4: tool lifecycle

    #[test]
    fn a_tool_call_is_pending_not_running_during_argument_generation() {
        let mut r = TranscriptReducer::new();
        let started = r.on_event(
            &json!({"type":"toolcall_start","toolCallId":"t1","name":"Read"}),
            0,
        );
        assert_eq!(tool_update(&started, "t1").status, "pending");

        let delta = r.on_event(
            &json!({"type":"toolcall_delta","toolCallId":"t1","inputDelta":"{\"path\":"}),
            0,
        );
        assert_eq!(tool_update(&delta, "t1").status, "pending");

        let ended = r.on_event(
            &json!({"type":"toolcall_end","toolCallId":"t1","input":"{\"path\":\"a.rs\"}"}),
            0,
        );
        let call = tool_update(&ended, "t1");
        assert_eq!(call.status, "pending"); // argument generation ≠ execution (FR-3)
        assert_eq!(call.input_text, "{\"path\":\"a.rs\"}");

        let running = r.on_event(
            &json!({"type":"tool_execution_start","toolCallId":"t1"}),
            100,
        );
        let call = tool_update(&running, "t1");
        assert_eq!(call.status, "running");
        assert_eq!(call.started_at, Some(100));
    }

    #[test]
    fn tool_progress_is_a_snapshot_replacing_not_concatenating() {
        let mut r = TranscriptReducer::new();
        r.on_event(
            &json!({"type":"toolcall_start","toolCallId":"t1","name":"Bash"}),
            0,
        );
        r.on_event(&json!({"type":"tool_execution_start","toolCallId":"t1"}), 0);
        r.on_event(
            &json!({"type":"tool_execution_update","toolCallId":"t1","progress":"line 1"}),
            0,
        );
        let second = r.on_event(
            &json!({"type":"tool_execution_update","toolCallId":"t1","progress":"line 1\nline 2"}),
            0,
        );
        assert_eq!(tool_update(&second, "t1").output_text, "line 1\nline 2");
    }

    #[test]
    fn a_tool_result_settles_the_matching_call_exactly_once() {
        let mut r = TranscriptReducer::new();
        r.on_event(
            &json!({"type":"toolcall_start","toolCallId":"t1","name":"Bash"}),
            0,
        );
        r.on_event(&json!({"type":"tool_execution_start","toolCallId":"t1"}), 0);
        let ended = r.on_event(
            &json!({"type":"tool_execution_end","toolCallId":"t1","isError":false,"output":"ok"}),
            50,
        );
        let call = tool_update(&ended, "t1");
        assert_eq!(call.status, "succeeded");
        assert_eq!(call.completed_at, Some(50));

        // Edge cases §7: message_end's toolResult for the SAME call must not
        // append a second row — already settled, so this is a no-op.
        let reconciled = r.on_event(
            &json!({"type":"message_end","messageId":"m1",
                "toolResult":{"toolCallId":"t1","isError":true,"output":"different"}}),
            60,
        );
        assert!(reconciled.is_empty());
    }

    #[test]
    fn message_end_tool_result_settles_a_call_never_seen_by_tool_execution_end() {
        let mut r = TranscriptReducer::new();
        r.on_event(
            &json!({"type":"toolcall_start","toolCallId":"t1","name":"Bash"}),
            0,
        );
        let reconciled = r.on_event(
            &json!({"type":"message_end","messageId":"m1",
                "toolResult":{"toolCallId":"t1","isError":false,"output":"done"}}),
            10,
        );
        assert_eq!(reconciled.len(), 1);
        assert_eq!(tool_update(&reconciled, "t1").status, "succeeded");
    }

    #[test]
    fn a_tool_result_for_an_untracked_call_id_is_silently_ignored() {
        let mut r = TranscriptReducer::new();
        let out = r.on_event(
            &json!({"type":"message_end","messageId":"m1",
                "toolResult":{"toolCallId":"ghost","isError":false,"output":"x"}}),
            0,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn a_replayed_toolcall_start_never_orphans_the_first_block_or_duplicates_the_row() {
        // HIGH (review round 2): a replayed toolcall_start for an
        // ALREADY-TRACKED toolCallId must reuse the same block, never mint a
        // second ToolState — that would orphan the first row and duplicate
        // the tool in the transcript (FR-3/FR-8).
        let mut r = TranscriptReducer::new();
        let first = r.on_event(
            &json!({"type":"toolcall_start","toolCallId":"t1","name":"Read"}),
            0,
        );

        // Progress the call past pending before the replay arrives.
        r.on_event(&json!({"type":"tool_execution_start","toolCallId":"t1"}), 0);

        let replay = r.on_event(
            &json!({"type":"toolcall_start","toolCallId":"t1","name":"Read"}),
            0,
        );
        let replayed = tool_update(&replay, "t1");
        assert_eq!(
            replayed.status, "running",
            "the replay must not reset an already-running call back to pending"
        );

        // The block id the reducer's OWN state carries never changed either.
        let block_id = match &replay[0] {
            RuntimeEventPayload::ToolUpdate { block_id, .. } => block_id.clone(),
            _ => panic!("expected a tool.update"),
        };
        assert_eq!(
            block_id,
            match &first[0] {
                RuntimeEventPayload::ToolUpdate { block_id, .. } => block_id.clone(),
                _ => panic!("expected a tool.update"),
            },
            "same toolCallId ⇒ same stable blockId across a replay"
        );
    }

    #[test]
    fn tool_names_are_preserved_verbatim_even_when_they_look_like_a_subagent() {
        // FR-1: glyph classification never renames the tool or invokes
        // Claude-specific subagent parsing just because a name matches 'Task'.
        let mut r = TranscriptReducer::new();
        let started = r.on_event(
            &json!({"type":"toolcall_start","toolCallId":"t1","name":"Task"}),
            0,
        );
        assert_eq!(tool_update(&started, "t1").name, "Task");
    }

    // ---------------------------------------------------------- FR-4: bounded previews

    // ---------------------------------------------------------- FR-3: failed outcomes

    #[test]
    fn a_failed_tool_execution_end_settles_status_failed_with_output() {
        // MEDIUM (review round 2): a fresh call's terminal isError:true must
        // settle as "failed", carrying the error output — never "succeeded".
        let mut r = TranscriptReducer::new();
        r.on_event(
            &json!({"type":"toolcall_start","toolCallId":"t1","name":"Bash"}),
            0,
        );
        r.on_event(&json!({"type":"tool_execution_start","toolCallId":"t1"}), 0);
        let ended = r.on_event(
            &json!({"type":"tool_execution_end","toolCallId":"t1","isError":true,"output":"command not found"}),
            50,
        );
        let call = tool_update(&ended, "t1");
        assert_eq!(call.status, "failed");
        assert_eq!(call.output_text, "command not found");
        assert_eq!(call.completed_at, Some(50));
    }

    #[test]
    fn a_message_end_outcome_error_is_reported_verbatim_on_assistant_complete() {
        // MEDIUM (review round 2): message_end's outcome:"error" was never
        // exercised — a failed assistant turn must surface as
        // AssistantComplete { outcome: "error", .. }, not silently coerced
        // to "complete".
        let mut r = TranscriptReducer::new();
        let ended = r.on_event(
            &json!({"type":"message_end","messageId":"m1","role":"assistant",
                "content":[{"type":"text","text":"partial reply"}], "outcome":"error"}),
            0,
        );
        assert_eq!(ended.len(), 1);
        match &ended[0] {
            RuntimeEventPayload::AssistantComplete { text, outcome, .. } => {
                assert_eq!(text, "partial reply");
                assert_eq!(outcome, "error");
            }
            other => panic!("expected assistant.complete, got {other:?}"),
        }
    }

    // ---------------------------------------------------------- §6: secret redaction

    #[test]
    fn a_known_secret_key_pattern_in_tool_output_is_redacted() {
        let mut r = TranscriptReducer::new();
        r.on_event(
            &json!({"type":"toolcall_start","toolCallId":"t1","name":"Bash"}),
            0,
        );
        r.on_event(&json!({"type":"tool_execution_start","toolCallId":"t1"}), 0);
        let ended = r.on_event(
            &json!({"type":"tool_execution_end","toolCallId":"t1","isError":false,
                "output":"token is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}),
            0,
        );
        let call = tool_update(&ended, "t1");
        assert!(
            !call
                .output_text
                .contains("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            "raw secret key must not reach the persisted/IPC preview: {}",
            call.output_text
        );
        assert!(call.output_text.contains("[redacted]"));
    }

    #[test]
    fn a_dotenv_style_assignment_in_tool_input_is_redacted() {
        let mut r = TranscriptReducer::new();
        r.on_event(
            &json!({"type":"toolcall_start","toolCallId":"t1","name":"Write"}),
            0,
        );
        let ended = r.on_event(
            &json!({"type":"toolcall_end","toolCallId":"t1",
                "input":"API_KEY=abcdefghijklmnop1234\nHOST=localhost"}),
            0,
        );
        let call = tool_update(&ended, "t1");
        assert!(!call.input_text.contains("abcdefghijklmnop1234"));
        assert!(call.input_text.contains("[redacted]"));
        assert!(call.input_text.contains("HOST=localhost"));
    }

    #[test]
    fn github_token_aws_key_and_bearer_header_patterns_are_all_redacted() {
        let mut r = TranscriptReducer::new();
        r.on_event(
            &json!({"type":"toolcall_start","toolCallId":"t1","name":"Bash"}),
            0,
        );
        r.on_event(&json!({"type":"tool_execution_start","toolCallId":"t1"}), 0);
        let output = "gh token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n\
            aws: AKIAABCDEFGHIJKLMNOP\n\
            Authorization: Bearer abcDEF123.456-token_value";
        let ended = r.on_event(
            &json!({"type":"tool_execution_end","toolCallId":"t1","isError":false,"output":output}),
            0,
        );
        let call = tool_update(&ended, "t1");
        assert!(!call
            .output_text
            .contains("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
        assert!(!call.output_text.contains("AKIAABCDEFGHIJKLMNOP"));
        assert!(!call.output_text.contains("abcDEF123.456-token_value"));
    }

    #[test]
    fn tool_input_and_output_previews_are_bounded_with_a_truncated_flag() {
        let mut r = TranscriptReducer::new();
        r.on_event(
            &json!({"type":"toolcall_start","toolCallId":"t1","name":"Write"}),
            0,
        );
        let huge_input = "x".repeat(PREVIEW_BYTES + 10);
        let ended = r.on_event(
            &json!({"type":"toolcall_end","toolCallId":"t1","input": huge_input}),
            0,
        );
        let call = tool_update(&ended, "t1");
        assert!(call.input_truncated);
        assert_eq!(call.input_text.len(), PREVIEW_BYTES);

        r.on_event(&json!({"type":"tool_execution_start","toolCallId":"t1"}), 0);
        let huge_output = "y".repeat(PREVIEW_BYTES + 10);
        let done = r.on_event(
            &json!({"type":"tool_execution_end","toolCallId":"t1","isError":false,"output": huge_output}),
            0,
        );
        let call = tool_update(&done, "t1");
        assert!(call.output_truncated);
        assert_eq!(call.output_text.len(), PREVIEW_BYTES);
    }
}
