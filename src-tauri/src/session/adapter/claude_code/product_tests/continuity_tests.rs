//! process-session-continuity §4 over the Claude product path: the real
//! adapter, the real atomic anchor commit into `sessions.json`, the real
//! quarantine reader/record loader standing in for quit + reopen, and the
//! real transcript line format. Only the executable is a fixture.
use super::*;
use crate::session::persistence;
use crate::session::BlockKind;
use std::path::PathBuf;

/// An isolated app-data dir: `sessions.json` lives here, nothing else.
struct AppData(PathBuf);
impl AppData {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("francois-continuity-{}", crate::session::uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn sessions(&self) -> PathBuf {
        self.0.join("sessions.json")
    }
    fn record(&self, id: &str) -> Value {
        let records: Vec<Value> =
            serde_json::from_slice(&std::fs::read(self.sessions()).unwrap()).unwrap();
        records.into_iter().find(|r| r["id"] == id).unwrap()
    }
}
impl Drop for AppData {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A reopened app: the loaded engine behind a fresh env, and the session
/// moved to `starting` the way `do_send` does before a turn begins.
fn reopened(data: &AppData, accounts: &[&str]) -> (Arc<TestEnv>, Arc<Effects>) {
    let engine = persistence::reopen(&data.sessions(), accounts);
    engine.with_session_mut("s1", |s| s.status = "starting".into());
    let env = Arc::new(TestEnv {
        engine,
        ..Default::default()
    });
    let effects = Arc::new(Effects {
        env: env.clone(),
        terminals: Mutex::new(vec![]),
        failures: Mutex::new(vec![]),
    });
    (env, effects)
}

/// The session's buffer written as transcript lines and read back — what a
/// restart shows before any process starts.
fn transcript_after_restart(env: &TestEnv) -> Vec<crate::session::BufBlock> {
    let lines: String = env
        .engine
        .with_session("s1", |s| {
            s.block_buffer
                .iter()
                .map(|b| persistence::persisted_block_json(b).to_string() + "\n")
                .collect()
        })
        .unwrap();
    persistence::parse_transcript(&lines)
}

#[test]
fn a_committed_anchor_survives_restart_and_resumes_the_same_thread_account_and_home() {
    let data = AppData::new();
    let (env, effects) = setup(None);
    env.engine
        .with_session_mut("s1", |s| s.account_id = "claude-a".into());
    persistence::save(&env.engine, &data.sessions());
    *env.anchor_file.lock().unwrap() = Some(data.sessions());
    let first = FakeClaude::new("text");
    start(&env, &effects, &first, "s1");
    assert_eq!(effects.settled(), vec!["finished"]);
    // FR-3: the native anchor reached disk through the atomic writer.
    let saved = data.record("s1");
    assert_eq!(saved["claudeSessionId"], "fresh-claude-thread");
    assert_eq!(saved["accountId"], "claude-a");
    assert_eq!(saved["agentRuntime"], "claude-code");

    // Quit + reopen: identity survives, and the cached projection is readable
    // before any process starts (FR-4).
    let completed = transcript_after_restart(&env);
    let (env, effects) = reopened(&data, &["claude-a"]);
    env.engine
        .with_session("s1", |s| {
            assert_eq!(s.claude_session_id.as_deref(), Some("fresh-claude-thread"));
            assert_eq!(s.account_id, "claude-a");
            assert_eq!(s.agent_runtime, AgentRuntime::ClaudeCode);
        })
        .unwrap();
    assert!(completed
        .iter()
        .any(|b| b.kind == BlockKind::Assistant && b.text == "hello from fake claude"));

    let second = FakeClaude::new("resume");
    start(&env, &effects, &second, "s1");
    assert_eq!(effects.settled(), vec!["finished"]);
    let argv = second.argv();
    assert!(argv
        .windows(2)
        .any(|pair| pair[0] == "--resume" && pair[1] == "fresh-claude-thread"));
    assert_eq!(second.record()[0]["home"], HOME);
    assert_eq!(second.spawns.load(Ordering::SeqCst), 1);
    assert_eq!(anchor(&env).as_deref(), Some("fresh-claude-thread"));
}

#[test]
fn a_failed_anchor_write_fails_the_turn_and_never_reaches_disk() {
    let data = AppData::new();
    let (env, effects) = setup(None);
    persistence::save(&env.engine, &data.sessions());
    let original = std::fs::read(data.sessions()).unwrap();
    *env.persist_failure.lock().unwrap() = Some(AppError::new(
        ErrorCode::SettingsWriteFailed,
        "injected storage failure",
    ));
    let fake = FakeClaude::new("text");
    start(&env, &effects, &fake, "s1");
    assert_eq!(effects.settled(), vec!["failed"]);
    // No persisted-anchor success is published, the file is untouched, and a
    // dependent turn could not resume an id that was never saved.
    assert_eq!(anchor(&env), None);
    assert_eq!(std::fs::read(data.sessions()).unwrap(), original);
    assert!(!events(&env)
        .iter()
        .any(|e| matches!(e, SessionEvent::AssistantDone { .. })));
    assert_reaped(&fake);
}

#[test]
fn a_crash_after_partial_output_keeps_it_and_replays_nothing() {
    let (env, effects) = setup(Some("saved-thread"));
    let fake = FakeClaude::new("crash");
    start(&env, &effects, &fake, "s1");
    assert_eq!(effects.settled(), vec!["failed"]);
    assert_eq!(
        fake.spawns.load(Ordering::SeqCst),
        1,
        "the prompt was replayed"
    );
    assert_eq!(fake.stdin().len(), 1);
    let restored = transcript_after_restart(&env);
    assert!(restored
        .iter()
        .any(|b| b.kind == BlockKind::Assistant && b.text == "partial"));
    // The anchor the crashed turn ran on stays the session's identity.
    assert_eq!(anchor(&env).as_deref(), Some("saved-thread"));
    assert_reaped(&fake);
}

#[test]
fn a_crash_with_a_parked_ask_leaves_only_an_inert_card() {
    let (env, effects) = setup(None);
    let fake = FakeClaude::new("crash-parked");
    start(&env, &effects, &fake, "s1");
    assert_eq!(effects.settled(), vec!["failed"]);
    assert_eq!(resolved_permissions(&env), vec!["cancelled"]);
    let restored = transcript_after_restart(&env);
    let card = restored
        .iter()
        .find(|b| b.kind == BlockKind::Permission)
        .and_then(|b| b.card.clone())
        .unwrap();
    assert_eq!(card["state"], "cancelled");
    // Nothing the dead process asked can be answered: no live owner remains.
    let late = application::decide_permission(
        &EngineState(&env.engine),
        effects.as_ref(),
        &FailingRules::default(),
        "s1",
        &wait_asks(&env, "s1", 1)[0].0,
        PermissionDecision::Allow,
        false,
        None,
    );
    assert_eq!(late.unwrap_err().code, ErrorCode::PermissionNotPending);
    assert_eq!(fake.stdin().len(), 1);
    assert_reaped(&fake);
}

#[test]
fn a_rejected_resume_after_restart_keeps_the_anchor_and_starts_no_fresh_thread() {
    let data = AppData::new();
    let (env, _) = setup(Some("stale-thread"));
    persistence::save(&env.engine, &data.sessions());
    let (env, effects) = reopened(&data, &["default"]);
    let fake = FakeClaude::new("resume-rejected");
    start(&env, &effects, &fake, "s1");
    assert_eq!(effects.settled(), vec!["resume-rejected"]);
    assert_eq!(fake.spawns.load(Ordering::SeqCst), 1);
    assert!(!fake.argv().is_empty());
    assert_eq!(anchor(&env).as_deref(), Some("stale-thread"));
    // The explicit fresh route is a NEW session: its own identity, the old
    // one's anchor and record left exactly as they were.
    let mut fresh = session("s2", None);
    fresh.status = "starting".into();
    env.engine
        .sessions
        .lock()
        .unwrap()
        .insert("s2".into(), fresh);
    let second = FakeClaude::new("text");
    start(&env, &effects, &second, "s2");
    wait(|| {
        env.engine
            .with_session("s2", |s| s.claude_session_id.clone())
            .flatten()
    });
    assert!(!second.argv().contains(&"--resume".to_string()));
    assert_eq!(anchor(&env).as_deref(), Some("stale-thread"));
    persistence::save(&env.engine, &data.sessions());
    assert_eq!(data.record("s1")["claudeSessionId"], "stale-thread");
}

#[test]
fn a_moved_worktree_fails_explicitly_without_spawning_or_touching_the_anchor() {
    let data = AppData::new();
    let (env, _) = setup(Some("saved-thread"));
    let gone = data.0.join("moved-away");
    env.engine
        .with_session_mut("s1", |s| s.cwd = gone.to_string_lossy().into_owned());
    persistence::save(&env.engine, &data.sessions());
    let (env, effects) = reopened(&data, &["default"]);
    let fake = FakeClaude::new("resume");
    start(&env, &effects, &fake, "s1");
    assert_eq!(effects.settled(), vec!["failed"]);
    assert_eq!(
        *effects.failures.lock().unwrap(),
        vec![ErrorCode::SpawnFailed]
    );
    assert!(
        fake.record().is_empty(),
        "a child ran in some other directory"
    );
    assert_eq!(anchor(&env).as_deref(), Some("saved-thread"));
}

/// The real adapter with the executable missing from PATH.
struct MissingClaude;
impl RuntimePort for MissingClaude {
    fn preflight(&self, ctx: &TurnContext) -> Result<(), AppError> {
        ClaudeCodeAdapter.preflight(ctx)
    }
    fn begin_turn(
        &self,
        ctx: TurnContext,
        sink: Arc<dyn RuntimeEventSink>,
    ) -> Result<Arc<dyn TurnControl>, AppError> {
        begin_native_turn(ctx, sink, |_, argv| {
            ("francois-continuity-missing-claude".into(), argv)
        })
    }
}

#[test]
fn an_unavailable_binary_fails_explicitly_and_keeps_the_saved_identity() {
    let (env, effects) = setup(Some("saved-thread"));
    application::start(
        &EngineState(&env.engine),
        &MissingClaude,
        effects.clone(),
        context(&env, "s1"),
    )
    .unwrap();
    assert_eq!(effects.settled(), vec!["failed"]);
    assert_eq!(
        *effects.failures.lock().unwrap(),
        vec![ErrorCode::SpawnFailed]
    );
    assert_eq!(anchor(&env).as_deref(), Some("saved-thread"));
}
