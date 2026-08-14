//! `SessionEnv` — what the NDJSON parse path (`stream/*`, plus the handful of
//! `stdio`/`agents`/`workflows`/`workflow_watch` helpers it calls into) needs
//! from its environment, abstracted behind a trait instead of a live
//! `AppHandle` (multi-provider-seam FR-6).
//!
//! `AppHandle` implements it by delegating to the exact pre-existing
//! functions (`emit`, `persist`, `append_transcript`, …) — so production
//! behaviour is byte-for-byte unchanged. A test builds a `TestEnv` that owns
//! its own `Engine` and collects every emission into a `Vec`, which is what
//! makes a golden replay of a captured stream possible at all: this crate
//! wires up no `AppHandle` test harness (see `session/testutil.rs`), so
//! nothing reachable from a unit test may require a live one.
//!
//! Everywhere else in this domain keeps calling the free `emit(app, ev)`
//! function with its existing `&AppHandle` signature, unchanged — only the
//! parse path (and what it calls) takes `&dyn SessionEnv`.

use super::*;

use crate::diff::on_tool_done;
use tauri::{AppHandle, Manager};

pub(crate) trait SessionEnv: Send + Sync {
    fn engine(&self) -> &Engine;
    fn emit_session(&self, ev: SessionEvent);
    fn emit_agent(&self, ev: AgentEvent);
    fn emit_workflow_detail(&self, ev: WorkflowDetailEvent);
    fn persist(&self);
    fn append_transcript(&self, session_id: &str, block: &BufBlock);
    /// FR-16: a file-mutating tool (Edit/Write) finished — recompute the diff
    /// summary. Named for the effect, not the call, so a test double can be a
    /// no-op without pretending to understand the diff domain.
    fn note_file_diff(&self, session_id: &str, cwd: &str);
}

impl SessionEnv for AppHandle {
    fn engine(&self) -> &Engine {
        self.state::<Engine>().inner()
    }
    fn emit_session(&self, ev: SessionEvent) {
        crate::session::emit(self, ev);
    }
    fn emit_agent(&self, ev: AgentEvent) {
        emit_agent_event(self, ev);
    }
    fn emit_workflow_detail(&self, ev: WorkflowDetailEvent) {
        emit_workflow_event(self, ev);
    }
    fn persist(&self) {
        crate::session::persist(self, self.state::<Engine>().inner());
    }
    fn append_transcript(&self, session_id: &str, block: &BufBlock) {
        crate::session::append_transcript(self, session_id, block);
    }
    fn note_file_diff(&self, session_id: &str, cwd: &str) {
        on_tool_done(self, session_id, cwd);
    }
}

#[cfg(test)]
pub(crate) mod testenv {
    use super::*;
    use std::sync::Mutex;

    /// FR-6/FR-18: a capturing `SessionEnv` — owns its own `Engine` (never the
    /// production managed one) and records every emission in arrival order,
    /// so a golden replay test can assert the exact `SessionEvent` sequence.
    #[derive(Default)]
    pub(crate) struct TestEnv {
        pub(crate) engine: Engine,
        pub(crate) session_events: Mutex<Vec<SessionEvent>>,
        pub(crate) agent_events: Mutex<Vec<AgentEvent>>,
        pub(crate) workflow_events: Mutex<Vec<WorkflowDetailEvent>>,
        pub(crate) persist_calls: Mutex<u32>,
        pub(crate) transcript_appends: Mutex<Vec<(String, String)>>, // (sessionId, blockId)
        pub(crate) diff_notes: Mutex<Vec<(String, String)>>,         // (sessionId, cwd)
    }

    impl SessionEnv for TestEnv {
        fn engine(&self) -> &Engine {
            &self.engine
        }
        fn emit_session(&self, ev: SessionEvent) {
            self.session_events.lock().unwrap().push(ev);
        }
        fn emit_agent(&self, ev: AgentEvent) {
            self.agent_events.lock().unwrap().push(ev);
        }
        fn emit_workflow_detail(&self, ev: WorkflowDetailEvent) {
            self.workflow_events.lock().unwrap().push(ev);
        }
        fn persist(&self) {
            *self.persist_calls.lock().unwrap() += 1;
        }
        fn append_transcript(&self, session_id: &str, block: &BufBlock) {
            self.transcript_appends
                .lock()
                .unwrap()
                .push((session_id.to_string(), block.block_id.clone()));
        }
        fn note_file_diff(&self, session_id: &str, cwd: &str) {
            self.diff_notes
                .lock()
                .unwrap()
                .push((session_id.to_string(), cwd.to_string()));
        }
    }
}
