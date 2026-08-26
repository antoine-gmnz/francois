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

pub trait SessionEnv: Send + Sync {
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
    /// The installed-skills/commands inventory for `cwd` (slash-menu FR-3/4),
    /// injected rather than read straight off disk — the parse path's own
    /// review finding: `discover_skills` walks the LIVE `~/.claude/skills`,
    /// `~/.claude/plugins/marketplaces` and `~/.claude/settings.json`, which
    /// made the golden replay diverge on every machine whose installed
    /// skills differ from the capture machine's (and fail outright on CI,
    /// where `~/.claude` never exists). A test double returns a fixed list
    /// instead of touching the filesystem at all.
    fn discover_commands(&self, cwd: &str) -> Vec<SkillInfo>;
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
    fn discover_commands(&self, cwd: &str) -> Vec<SkillInfo> {
        crate::session::discover_skills(cwd)
    }
}

// core-architecture-wave3 FR-3: `pub` under the `harness` feature for the same
// reason `testutil` is — `benches/` needs a `SessionEnv` and cannot see this one
// otherwise.
#[cfg(any(test, feature = "harness"))]
pub mod testenv {
    use super::*;
    use std::sync::Mutex;

    /// FR-6/FR-18: a capturing `SessionEnv` — owns its own `Engine` (never the
    /// production managed one) and records every emission in arrival order,
    /// so a golden replay test can assert the exact `SessionEvent` sequence.
    #[derive(Default)]
    pub struct TestEnv {
        pub engine: Engine,
        pub session_events: Mutex<Vec<SessionEvent>>,
        pub agent_events: Mutex<Vec<AgentEvent>>,
        pub workflow_events: Mutex<Vec<WorkflowDetailEvent>>,
        pub persist_calls: Mutex<u32>,
        pub transcript_appends: Mutex<Vec<(String, String)>>, // (sessionId, blockId)
        pub diff_notes: Mutex<Vec<(String, String)>>,         // (sessionId, cwd)
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
        fn discover_commands(&self, _cwd: &str) -> Vec<SkillInfo> {
            fixed_command_inventory()
        }
    }

    /// The fixed stand-in `discover_commands` returns instead of touching
    /// disk — reproducible on any machine and on CI, where the real
    /// `~/.claude` never exists. `fixtures/turn.expected.json`'s
    /// `session.commands` skill entries are generated from exactly this
    /// list (golden_replay_produces_the_locked_session_event_sequence).
    pub fn fixed_command_inventory() -> Vec<SkillInfo> {
        vec![
            SkillInfo {
                name: "seam-fixture-skill-one".into(),
                description: "fixed inventory injected via SessionEnv::discover_commands, not the live disk (multi-provider-seam FR-6)".into(),
                installed: true,
                scope: Some("user".into()),
                kind: Some("skill".into()),
                plugin_id: None,
            },
            SkillInfo {
                name: "seam-fixture-skill-two".into(),
                description: "second fixed entry, same reason".into(),
                installed: true,
                scope: Some("user".into()),
                kind: Some("skill".into()),
                plugin_id: None,
            },
        ]
    }
}
