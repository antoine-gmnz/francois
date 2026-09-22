//! codex-process-adapter §7 "product integration": the real application entry
//! (`application::start`) over the real native adapter and supervised JSONL
//! process, the real normalized sink/owner reduction, the real session
//! projection, and the real reply commands. Only the process is a fixture
//! (`fixtures/fake-server.cjs`): no network, no credentials, no model.
use super::integration_tests::runtime;
use crate::ipc::{AppError, ErrorCode};
use crate::permissions::PermissionRule;
use crate::session::application::{self, *};
use crate::session::runtime_bridge::{project_runtime_event, EngineState};
use crate::session::testenv::TestEnv;
use crate::session::testutil::{test_engine_with, test_session};
use crate::session::{persistence, AgentRuntime, SessionEvent};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const HOME: &str = "fixture-codex-home";
const SECRET: &str = "SENTINEL-NATIVE-SECRET";

/// Production `AppEffects` minus the `AppHandle`: the same session projection,
/// plus a record of terminal effects so a test can wait for the turn to end.
struct Effects {
    env: Arc<TestEnv>,
    cwd: String,
    terminals: Mutex<Vec<&'static str>>,
}
impl RuntimeEffectPort for Effects {
    fn apply(&self, scope: &RuntimeScope, event: RuntimeEvent) -> Result<(), AppError> {
        let terminal = match &event {
            RuntimeEvent::TurnFinished => Some("finished"),
            RuntimeEvent::TurnFailed(_) => Some("failed"),
            RuntimeEvent::ConnectionClosed(_) => Some("closed"),
            _ => None,
        };
        let result = project_runtime_event(self.env.as_ref(), &scope.session_id, &self.cwd, event);
        if let Some(terminal) = terminal {
            self.terminals.lock().unwrap().push(terminal);
        }
        result
    }
}
impl Effects {
    fn wait_terminal(&self) -> Vec<&'static str> {
        wait(|| {
            let terminals = self.terminals.lock().unwrap();
            (!terminals.is_empty()).then(|| terminals.clone())
        })
    }
}

/// Counts every access: native Codex must never reach Claude permission rules.
#[derive(Default)]
struct Rules(AtomicUsize);
impl PermissionRulePort for Rules {
    fn remember(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
        _: bool,
    ) -> Result<PermissionRule, AppError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(AppError::new(
            ErrorCode::Internal,
            "rules must not be accessed",
        ))
    }
}

fn wait<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "expected product effect never arrived"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn wait_event<T>(env: &TestEnv, pick: impl Fn(&SessionEvent) -> Option<T>) -> T {
    wait(|| env.session_events.lock().unwrap().iter().find_map(&pick))
}

fn setup(anchor: Option<&str>) -> (Arc<TestEnv>, Arc<Effects>) {
    let mut session = test_session();
    session.agent_runtime = AgentRuntime::Codex;
    session.status = "running".into();
    session.cwd = std::env::temp_dir().to_string_lossy().into_owned();
    session.claude_session_id = anchor.map(String::from);
    let cwd = session.cwd.clone();
    let env = Arc::new(TestEnv {
        engine: test_engine_with(session),
        ..Default::default()
    });
    let effects = Arc::new(Effects {
        env: env.clone(),
        cwd,
        terminals: Mutex::new(vec![]),
    });
    (env, effects)
}
/// What `runtime_bridge::start_runtime` resolves before `application::start`.
fn context(env: &TestEnv, home: &str) -> TurnContext {
    let mut ctx = crate::session::turn::build_turn_context(
        &env.engine,
        "s1",
        "user-block".into(),
        "fixture prompt".into(),
        TurnMode::Normal,
    )
    .unwrap();
    ctx.execution.identity = ExecutionIdentity {
        account_id: ctx.account_id.clone(),
        home: Some(home.into()),
        runtime: ctx.runtime.clone(),
        worktree_distro: None,
    };
    ctx.execution.environment = vec![("CODEX_HOME".into(), home.into())];
    ctx.execution.account_authenticated = true;
    ctx
}
fn start(env: &TestEnv, effects: &Arc<Effects>, runtime: &dyn RuntimePort, home: &str) {
    application::start(
        &EngineState(&env.engine),
        runtime,
        effects.clone(),
        context(env, home),
    )
    .unwrap();
}

#[test]
fn command_approval_roundtrips_through_reply_commands_without_claude_rules() {
    let (native, _) = runtime("permission");
    let (env, effects) = setup(None);
    let state = EngineState(&env.engine);
    start(&env, &effects, &native, HOME);
    let (block, ask) = wait_event(&env, |event| match event {
        SessionEvent::PermissionAsked { block_id, ask, .. } => {
            Some((block_id.clone(), ask.clone()))
        }
        _ => None,
    });
    // FR-10: live capabilities + generation are published before the request.
    {
        let events = env.session_events.lock().unwrap();
        let meta = events.iter().position(
            |e| matches!(e, SessionEvent::Meta { meta } if meta.runtime_generation.is_some()),
        );
        let asked = events
            .iter()
            .position(|e| matches!(e, SessionEvent::PermissionAsked { .. }));
        assert!(meta.unwrap() < asked.unwrap());
    }
    assert!(!block.contains("native-turn") && !block.contains("41"));
    assert_eq!(
        ask.allowed_decisions,
        Some(vec!["allowOnce".into(), "cancel".into()])
    );
    let rules = Rules::default();
    let decide = |decision, remember| {
        application::decide_permission(
            &state,
            effects.as_ref(),
            &rules,
            "s1",
            &block,
            decision,
            remember,
            None,
        )
    };
    // FR-10: Always is refused before any Claude rule access.
    assert_eq!(
        decide(PermissionDecision::Allow, true).unwrap_err().code,
        ErrorCode::RuntimeUnsupported
    );
    // FR-6: Deny once was not offered by this native request.
    assert_eq!(
        decide(PermissionDecision::Deny, false).unwrap_err().code,
        ErrorCode::RuntimeUnsupported
    );
    decide(PermissionDecision::Allow, false).unwrap();
    // FR-8: a duplicate click writes nothing more.
    assert_eq!(
        decide(PermissionDecision::Allow, false).unwrap_err().code,
        ErrorCode::PermissionNotPending
    );
    assert_eq!(effects.wait_terminal(), vec!["finished"]);
    assert_eq!(rules.0.load(Ordering::SeqCst), 0);
    let events = env.session_events.lock().unwrap();
    let resolved: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::PermissionResolved { state, .. } => Some(state.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(resolved, vec!["allowed"]);
    // Removal is not tool success.
    assert!(!events
        .iter()
        .any(|e| matches!(e, SessionEvent::ToolDone { .. })));
    drop(events);
    application::close(&state, effects.as_ref(), "s1").unwrap();
    native.close();
}

#[test]
fn file_approval_cancel_through_product_entry_uses_native_defaults() {
    let (native, _) = runtime("file");
    let (env, effects) = setup(None);
    let state = EngineState(&env.engine);
    start(&env, &effects, &native, HOME);
    let (block, ask) = wait_event(&env, |event| match event {
        SessionEvent::PermissionAsked { block_id, ask, .. } => {
            Some((block_id.clone(), ask.clone()))
        }
        _ => None,
    });
    assert_eq!(
        ask.allowed_decisions,
        Some(vec!["allowOnce".into(), "denyOnce".into(), "cancel".into()])
    );
    assert!(ask.input_json.contains("fixture.txt") && !ask.input_json.contains("unrelated.txt"));
    application::decide_permission(
        &state,
        effects.as_ref(),
        &Rules::default(),
        "s1",
        &block,
        PermissionDecision::Cancel,
        false,
        None,
    )
    .unwrap();
    effects.wait_terminal();
    let states: Vec<_> = env
        .session_events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            SessionEvent::PermissionResolved { state, .. } => Some(state.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(states, vec!["cancelled".to_string()]);
    native.close();
}

#[test]
fn secret_answer_reaches_native_stdin_only_through_product_entry() {
    // The fixture exits (turn fails) unless its stdin carries the exact secret.
    let (native, _) = runtime("question");
    let (env, effects) = setup(None);
    let state = EngineState(&env.engine);
    start(&env, &effects, &native, HOME);
    let block = wait_event(&env, |event| match event {
        SessionEvent::QuestionAsked {
            block_id, blocking, ..
        } => {
            assert_eq!(*blocking, Some(false));
            Some(block_id.clone())
        }
        _ => None,
    });
    // Nonblocking: the session does not park on this question.
    assert_ne!(
        env.engine
            .with_session("s1", |s| s.status.clone())
            .as_deref(),
        Some("awaiting_input")
    );
    let invalid = application::answer_question(
        &state,
        effects.as_ref(),
        "s1",
        &block,
        &json!({"Fixture secret": SECRET}),
    )
    .unwrap_err();
    assert!(!invalid.message.contains(SECRET));
    application::answer_question(
        &state,
        effects.as_ref(),
        "s1",
        &block,
        &json!({"opaque-secret": SECRET}),
    )
    .unwrap();
    assert_eq!(effects.wait_terminal(), vec!["finished"]);
    let answers = wait_event(&env, |event| match event {
        SessionEvent::QuestionResolved { answers, state, .. } if state == "answered" => {
            answers.clone()
        }
        _ => None,
    });
    assert_eq!(answers, json!({"opaque-secret": "[redacted]"}));
    // Emitted, persisted and transcript captures never carry the secret.
    let emitted = serde_json::to_string(&*env.session_events.lock().unwrap()).unwrap();
    assert!(!emitted.contains(SECRET));
    let persisted = env
        .engine
        .with_session("s1", |s| {
            s.block_buffer
                .iter()
                .map(|b| persistence::persisted_block_json(b).to_string())
                .collect::<Vec<_>>()
        })
        .unwrap();
    assert!(!persisted.is_empty());
    assert!(persisted.iter().all(|block| !block.contains(SECRET)));
    assert!(persisted.iter().any(|block| block.contains("[redacted]")));
    native.close();
}

#[test]
fn exec_created_anchor_resumes_natively_under_the_same_account_home() {
    let (native, spawns) = runtime("exec-resume");
    let (env, effects) = setup(Some("exec-created-thread"));
    start(&env, &effects, &native, HOME);
    assert_eq!(effects.wait_terminal(), vec!["finished"]);
    assert_eq!(spawns.load(Ordering::SeqCst), 1);
    assert_eq!(
        env.engine
            .with_session("s1", |s| s.claude_session_id.clone())
            .flatten()
            .as_deref(),
        Some("exec-created-thread")
    );
    native.close();
}

#[test]
fn exec_anchor_under_another_account_home_fails_explicitly_without_replacement() {
    let (native, _) = runtime("exec-resume");
    let (env, effects) = setup(Some("exec-created-thread"));
    start(&env, &effects, &native, "some-other-home");
    let terminals = effects.wait_terminal();
    assert!(!terminals.contains(&"finished"));
    // No fresh thread was created and the saved anchor is untouched.
    assert_eq!(
        env.engine
            .with_session("s1", |s| s.claude_session_id.clone())
            .flatten()
            .as_deref(),
        Some("exec-created-thread")
    );
    assert!(!env
        .session_events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, SessionEvent::AssistantDelta { .. })));
    native.close();
}

#[test]
fn stop_before_native_start_then_close_releases_the_owned_process() {
    let (native, spawns) = runtime("stop");
    let (env, effects) = setup(None);
    let state = EngineState(&env.engine);
    start(&env, &effects, &native, HOME);
    application::interrupt(&state, "s1").unwrap();
    application::interrupt(&state, "s1").unwrap();
    assert_eq!(effects.wait_terminal(), vec!["finished"]);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(effects.terminals.lock().unwrap().len(), 1);
    assert_eq!(spawns.load(Ordering::SeqCst), 1);
    // Normal interrupt keeps the session's native server (FR-4).
    assert!(!native.inner.state.lock().unwrap().closed);
    application::close(&state, effects.as_ref(), "s1").unwrap();
    native.close();
    let inner = native.inner.state.lock().unwrap();
    assert!(inner.closed && inner.transport.is_none());
}

/// process-native-capabilities AC-2/AC-3: the live snapshot authorizes the
/// negotiated controls only while the connection that negotiated it exists.
/// Losing the native connection mid-request clears it, and the old card stays
/// inert: no reply write, no Claude rule access.
#[test]
fn connection_loss_clears_live_capabilities_and_leaves_the_pending_card_inert() {
    let (native, _) = runtime("permission-eof");
    let (env, effects) = setup(None);
    let state = EngineState(&env.engine);
    start(&env, &effects, &native, HOME);
    let block = wait_event(&env, |event| match event {
        SessionEvent::PermissionAsked { block_id, .. } => Some(block_id.clone()),
        _ => None,
    });
    // Live scope: the negotiated control is authorized; unproven parity is not,
    // even with the native server connected.
    assert_eq!(env.engine.require_capability("s1", "permissions"), Ok(()));
    for key in [
        "mcp",
        "subagents",
        "skills",
        "skillsInstall",
        "workflows",
        "remoteControl",
        "compaction",
    ] {
        assert_eq!(
            env.engine.require_capability("s1", key).unwrap_err().0,
            ErrorCode::RuntimeUnsupported,
            "{key}"
        );
    }
    wait(|| {
        effects
            .terminals
            .lock()
            .unwrap()
            .contains(&"closed")
            .then_some(())
    });
    let (caps, generation) = env
        .engine
        .with_session("s1", |s| {
            (
                s.effective_capabilities.clone(),
                s.runtime_generation.clone(),
            )
        })
        .unwrap();
    assert!(caps.is_none() && generation.is_none());
    assert_eq!(
        env.engine.require_capability("s1", "permissions"),
        Err((
            ErrorCode::RuntimeUnavailable,
            crate::session::adapter::capabilities::CAPABILITY_DISCONNECTED
        ))
    );
    let last_meta = env
        .session_events
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find_map(|e| match e {
            SessionEvent::Meta { meta } => Some(meta.runtime_generation.clone()),
            _ => None,
        })
        .unwrap();
    assert!(
        last_meta.is_none(),
        "the published meta drops the generation"
    );
    let rules = Rules::default();
    assert!(application::decide_permission(
        &state,
        effects.as_ref(),
        &rules,
        "s1",
        &block,
        PermissionDecision::Allow,
        false,
        None,
    )
    .is_err());
    assert_eq!(rules.0.load(Ordering::SeqCst), 0);
    native.close();
}

mod continuity_tests;
