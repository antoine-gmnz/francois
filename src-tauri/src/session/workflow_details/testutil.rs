//! Shared fixtures for the workflow_details children's unit tests: a throwaway
//! run directory and the reference run the scan tests read back.

use super::*;

use crate::session::testutil::test_session;
use serde_json::json;
use std::path::PathBuf;

/// One attributed ask, for the FR-22/FR-24 assertions on both sides of the
/// registry (the run's count and the detail's `pendingAsks`).
pub(crate) fn ask(block_id: &str, agent: Option<&str>) -> WorkflowPendingAsk {
    WorkflowPendingAsk {
        block_id: block_id.into(),
        kind: "permission".into(),
        agent_id: agent.map(|a| a.to_string()),
        tool_name: Some("Bash".into()),
        confidence: "exact".into(),
    }
}

// ---------- fixture plumbing ----------

/// A throwaway run directory. No shared global state between tests: each one
/// gets its own uuid-named directory under the OS temp dir, removed on drop.
pub(crate) struct RunDir(PathBuf);

impl RunDir {
    pub(crate) fn new() -> RunDir {
        let p = std::env::temp_dir().join(format!("francois-wf-{}", uuid()));
        std::fs::create_dir_all(&p).unwrap();
        RunDir(p)
    }
    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
    pub(crate) fn write(&self, name: &str, body: &str) {
        std::fs::write(self.0.join(name), body).unwrap();
    }
    pub(crate) fn append(&self, name: &str, body: &str) {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.0.join(name))
            .unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }
}

impl Drop for RunDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn assistant_line(ts: &str, text: &str, input: u64, output: u64) -> String {
    json!({
        "type": "assistant", "timestamp": ts,
        "message": { "role": "assistant", "content": [{ "type": "text", "text": text }],
            "usage": { "input_tokens": input, "output_tokens": output,
                "cache_read_input_tokens": 2, "cache_creation_input_tokens": 1 } }
    })
    .to_string()
        + "\n"
}

pub(crate) fn user_line_at(ts: &str, text: &str) -> String {
    json!({
        "type": "user", "timestamp": ts,
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    })
    .to_string()
        + "\n"
}

/// The reference fixture: two agents, one finished and one still going.
pub(crate) fn fixture() -> RunDir {
    let d = RunDir::new();
    d.write(
        "journal.jsonl",
        &format!(
            "{}\n{}\n{}\n",
            json!({ "type": "started", "agentId": "a1" }),
            json!({ "type": "started", "agentId": "a2" }),
            json!({ "type": "result", "agentId": "a1", "result": "12 findings" }),
        ),
    );
    d.write(
        "agent-a1.meta.json",
        &json!({ "agentType": "frontend", "model": "claude-sonnet-5" }).to_string(),
    );
    d.write("agent-a2.meta.json", &json!({}).to_string());
    d.write(
        "agent-a1.jsonl",
        &format!(
            "{}{}",
            user_line_at(
                "2026-07-31T10:00:00.000Z",
                "review the frontend\nand report"
            ),
            assistant_line("2026-07-31T10:00:20.000Z", "done", 10, 5),
        ),
    );
    d.write(
        "agent-a2.jsonl",
        &format!(
            "{}{}",
            user_line_at("2026-07-31T10:00:10.000Z", "review the core"),
            assistant_line("2026-07-31T10:00:30.000Z", "working", 20, 7),
        ),
    );
    d
}

pub(crate) fn running_run() -> WorkflowRun {
    let mut s = test_session();
    mint_workflow(&mut s, "s1", "run-1", "toolu_w", 1_000);
    s.workflows.get("run-1").unwrap().clone()
}

pub(crate) fn terminal_run() -> WorkflowRun {
    let mut run = running_run();
    run.status = "done".into();
    run.ended_at = Some(9_000);
    run
}

pub(crate) fn detail_of(
    dir: &RunDir,
    run: &WorkflowRun,
    asks: &[WorkflowPendingAsk],
) -> WorkflowDetail {
    let mut state = ScanState::default();
    scan_run_dir(dir.path(), &mut state);
    build_detail(
        run,
        "s1",
        &dir.path().to_string_lossy(),
        false,
        &state,
        asks,
    )
}
