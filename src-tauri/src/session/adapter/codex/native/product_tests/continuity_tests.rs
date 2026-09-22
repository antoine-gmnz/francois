//! process-session-continuity §4 over the native Codex product path: the real
//! App Server adapter, the real atomic anchor commit into `sessions.json`, and
//! the real quarantine reader/record loader standing in for quit + reopen.
//! Only the server process is a fixture.
use super::*;
use std::path::PathBuf;

/// An isolated app-data dir: `sessions.json` lives here, nothing else.
struct AppData(PathBuf);
impl AppData {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "francois-codex-continuity-{}",
            crate::session::uuid()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn sessions(&self) -> PathBuf {
        self.0.join("sessions.json")
    }
    fn record(&self) -> serde_json::Value {
        let records: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(self.sessions()).unwrap()).unwrap();
        records.into_iter().find(|r| r["id"] == "s1").unwrap()
    }
}
impl Drop for AppData {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Quit + reopen: the loaded engine behind a fresh env, the session moved to
/// a busy status the way `do_send` does before a turn begins.
fn reopened(data: &AppData, accounts: &[&str]) -> (Arc<TestEnv>, Arc<Effects>) {
    let engine = persistence::reopen(&data.sessions(), accounts);
    engine.with_session_mut("s1", |s| s.status = "running".into());
    let cwd = engine.with_session("s1", |s| s.cwd.clone()).unwrap();
    let env = Arc::new(TestEnv {
        engine,
        ..Default::default()
    });
    let effects = Arc::new(Effects {
        env: env.clone(),
        cwd,
        terminals: Mutex::new(vec![]),
    });
    (env, effects)
}
fn anchor(env: &TestEnv) -> Option<String> {
    env.engine
        .with_session("s1", |s| s.claude_session_id.clone())
        .flatten()
}
fn streamed(env: &TestEnv) -> bool {
    env.session_events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, SessionEvent::AssistantDelta { .. }))
}

#[test]
fn a_native_thread_committed_to_disk_resumes_after_restart_under_the_same_home() {
    let data = AppData::new();
    let (native, _) = runtime("plain");
    let (env, effects) = setup(None);
    env.engine
        .with_session_mut("s1", |s| s.account_id = "codex-a".into());
    persistence::save(&env.engine, &data.sessions());
    *env.anchor_file.lock().unwrap() = Some(data.sessions());
    start(&env, &effects, &native, HOME);
    assert_eq!(effects.wait_terminal(), vec!["finished"]);
    native.close();
    let saved = data.record();
    assert_eq!(saved["claudeSessionId"], "opaque-fixture-thread");
    assert_eq!(saved["accountId"], "codex-a");
    assert_eq!(saved["agentRuntime"], "codex");

    let (env, effects) = reopened(&data, &["codex-a"]);
    assert_eq!(anchor(&env).as_deref(), Some("opaque-fixture-thread"));
    // The fixture refuses thread/start, another thread id, or another home.
    let (native, spawns) = runtime("restart-resume");
    start(&env, &effects, &native, HOME);
    assert_eq!(effects.wait_terminal(), vec!["finished"]);
    assert_eq!(spawns.load(Ordering::SeqCst), 1);
    assert!(streamed(&env));
    assert_eq!(anchor(&env).as_deref(), Some("opaque-fixture-thread"));
    assert_eq!(
        env.engine.with_session("s1", |s| s.account_id.clone()),
        Some("codex-a".into())
    );
    native.close();
}

#[test]
fn an_exec_created_anchor_loaded_from_disk_resumes_through_the_app_server() {
    let data = AppData::new();
    let (env, _) = setup(Some("exec-created-thread"));
    persistence::save(&env.engine, &data.sessions());
    let (env, effects) = reopened(&data, &["default"]);
    let (native, spawns) = runtime("exec-resume");
    start(&env, &effects, &native, HOME);
    assert_eq!(effects.wait_terminal(), vec!["finished"]);
    assert_eq!(spawns.load(Ordering::SeqCst), 1);
    assert_eq!(anchor(&env).as_deref(), Some("exec-created-thread"));
    native.close();
}

#[test]
fn an_invalid_native_reference_fails_without_a_fresh_thread() {
    let data = AppData::new();
    let (env, _) = setup(Some("invalid-anchor"));
    persistence::save(&env.engine, &data.sessions());
    let (env, effects) = reopened(&data, &["default"]);
    // `plain` would happily start a fresh thread if the adapter asked for one.
    let (native, spawns) = runtime("plain");
    start(&env, &effects, &native, HOME);
    assert_eq!(effects.wait_terminal(), vec!["failed"]);
    assert_eq!(spawns.load(Ordering::SeqCst), 1);
    assert!(!streamed(&env));
    assert_eq!(anchor(&env).as_deref(), Some("invalid-anchor"));
    persistence::save(&env.engine, &data.sessions());
    assert_eq!(data.record()["claudeSessionId"], "invalid-anchor");
    native.close();
}

#[test]
fn a_failed_anchor_write_blocks_the_dependent_turn_and_keeps_the_file() {
    let data = AppData::new();
    let (env, effects) = setup(None);
    persistence::save(&env.engine, &data.sessions());
    let original = std::fs::read(data.sessions()).unwrap();
    *env.persist_failure.lock().unwrap() = Some(AppError::new(
        ErrorCode::SettingsWriteFailed,
        "injected storage failure",
    ));
    let (native, _) = runtime("plain");
    start(&env, &effects, &native, HOME);
    assert_eq!(effects.wait_terminal(), vec!["failed"]);
    // turn/start never ran on an unsaved thread, and nothing was published as saved.
    assert!(!streamed(&env));
    assert_eq!(anchor(&env), None);
    assert_eq!(std::fs::read(data.sessions()).unwrap(), original);
    native.close();
}
