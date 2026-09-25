//! A Codex turn's transcript reads like a Claude Code one: real failure
//! messages, plans as `TodoWrite` rows, edits with `+N −M` and their diff, MCP
//! calls with their arguments and result. Driven through the real native
//! adapter against `fixtures/fake-server.cjs`.
use super::integration_tests::{context, runtime, Sink};
use crate::session::application::*;
use crate::session::{StepBody, StepDetail};
use std::sync::Arc;

fn run(scenario: &str) -> Arc<Sink> {
    let (runtime, _) = runtime(scenario);
    let sink = Arc::new(Sink::default());
    let _turn = runtime.begin_turn(context(1, None), sink.clone()).unwrap();
    sink.terminal();
    sink
}
fn failure(sink: &Sink) -> String {
    match sink.wait(|e| matches!(e, RuntimeEvent::TurnFailed(_))) {
        RuntimeEvent::TurnFailed(error) => error.message,
        _ => unreachable!(),
    }
}
fn tool(sink: &Sink, name: &str) -> (String, String, Option<StepDetail>, bool) {
    let (block, summary) =
        match sink.wait(|e| matches!(e, RuntimeEvent::ToolStarted { tool, .. } if tool == name)) {
            RuntimeEvent::ToolStarted {
                block_id, summary, ..
            } => (block_id, summary),
            _ => unreachable!(),
        };
    match sink
        .wait(|e| matches!(e, RuntimeEvent::ToolCompleted { block_id, .. } if *block_id == block))
    {
        RuntimeEvent::ToolCompleted {
            meta,
            detail,
            affects_workspace,
            ..
        } => (summary, meta, detail, affects_workspace),
        _ => unreachable!(),
    }
}
fn generic(detail: &StepDetail) -> (serde_json::Value, String) {
    match &detail.body {
        StepBody::Generic { input_json, output } => (
            serde_json::from_str(input_json).unwrap(),
            output.text.clone(),
        ),
        other => panic!("expected a generic body, got {other:?}"),
    }
}

#[test]
fn a_failed_turn_surfaces_codex_own_message_and_details() {
    let message = failure(&run("failed"));
    assert!(
        message.contains("Rate limit reached for gpt-fixture"),
        "{message}"
    );
    assert!(message.contains("Try again in 20s."), "{message}");
    assert!(
        !message.contains("Reconnecting"),
        "a retried error is not the failure"
    );
}

/// `error` (willRetry:false) then `turn/completed` failed is ONE failure,
/// carrying whichever of the two said more.
#[test]
fn a_terminal_error_then_a_failed_completion_fails_the_turn_once() {
    let sink = run("error");
    assert_eq!(
        failure(&sink),
        "stream disconnected before completion\nresponseStreamDisconnected"
    );
    std::thread::sleep(std::time::Duration::from_millis(300));
    let failures = sink
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e.event, RuntimeEvent::TurnFailed(_)))
        .count();
    assert_eq!(failures, 1);
}

#[test]
fn a_plan_update_becomes_a_claude_shaped_todowrite_row() {
    let (summary, meta, detail, edits) = tool(&run("plan"), "TodoWrite");
    assert_eq!(
        (summary.as_str(), meta.as_str(), edits),
        ("3 items", "done", false)
    );
    let (input, _) = generic(&detail.expect("detail"));
    assert_eq!(
        input,
        serde_json::json!({"todos":[
            {"content":"Read the code","status":"completed","activeForm":"Read the code"},
            {"content":"Fix the bug","status":"in_progress","activeForm":"Fix the bug"},
            {"content":"Run the tests","status":"pending","activeForm":"Run the tests"}
        ]})
    );
}

#[test]
fn a_live_plan_update_maps_in_progress_and_pending_steps() {
    let (summary, meta, detail, _) = tool(&run("live-plan"), "TodoWrite");
    assert_eq!((summary.as_str(), meta.as_str()), ("3 items", "done"));
    let (input, _) = generic(&detail.expect("detail"));
    let step = |content: &str, status: &str| serde_json::json!({"content": content, "status": status, "activeForm": content});
    assert_eq!(
        input,
        serde_json::json!({"todos": [
            step("Prepare the text for hello.txt.", "in_progress"),
            step("Write the text to hello.txt.", "pending"),
            step("Verify the contents of hello.txt.", "pending"),
        ]})
    );
}

#[test]
fn a_file_change_counts_lines_and_carries_its_unified_diff() {
    let (summary, meta, detail, edits) = tool(&run("edit"), "Edit");
    // Codex reports absolute paths; the row title is cwd-relative, like Claude's.
    assert_eq!(summary, "existing.txt +1 more");
    assert_eq!(meta, "+3 \u{2212}1");
    assert!(edits, "an edit must recompute the diff view");
    let (input, output) = generic(&detail.expect("detail"));
    let first = input["changes"][0]["path"].as_str().unwrap().to_string();
    assert!(first.ends_with("existing.txt") && first.len() > "existing.txt".len());
    assert_eq!(
        input["changes"][1],
        serde_json::json!({"path":"new.txt","kind":"add"})
    );
    assert!(
        output.contains(&format!(
            "--- {first}\n+++ {first}\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n"
        )),
        "{output}"
    );
    assert!(
        output.contains("--- /dev/null\n+++ new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n"),
        "{output}"
    );
}

#[test]
fn an_mcp_call_carries_its_arguments_and_result() {
    let (summary, meta, detail, _) = tool(&run("mcp"), "mcp__docs__search");
    assert_eq!((summary.as_str(), meta.as_str()), ("search", "done"));
    let detail = detail.expect("detail");
    assert!(!detail.is_error);
    let (input, output) = generic(&detail);
    assert_eq!(
        input,
        serde_json::json!({"server":"docs","tool":"search","arguments":{"query":"tauri events"}})
    );
    assert_eq!(output, "found 2 pages");
}
