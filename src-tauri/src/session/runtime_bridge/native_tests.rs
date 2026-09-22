use super::*;
use crate::session::testutil::{test_engine_with, test_session};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Resource(AtomicUsize);
impl RuntimePort for Resource {
    fn preflight(&self, _: &TurnContext) -> Result<(), AppError> {
        Ok(())
    }
    fn begin_turn(
        &self,
        _: TurnContext,
        _: Arc<dyn RuntimeEventSink>,
    ) -> Result<Arc<dyn TurnControl>, AppError> {
        unreachable!("resource admission must not start a process")
    }
}
impl SessionRuntime for Resource {
    fn close(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
fn identity() -> ExecutionIdentity {
    ExecutionIdentity {
        account_id: "account-a".into(),
        home: Some("isolated-a".into()),
        runtime: "host".into(),
        worktree_distro: None,
    }
}
#[test]
fn session_resource_survives_turn_retirement_and_rejects_identity_change() {
    let engine = test_engine_with(test_session());
    let state = EngineState(&engine);
    let first = Arc::new(Resource(AtomicUsize::new(0)));
    let admitted = state
        .session_runtime("s1", &identity(), first.clone())
        .unwrap();
    state.claim_close("s1").unwrap();
    let unused = Arc::new(Resource(AtomicUsize::new(0)));
    let reused = state
        .session_runtime("s1", &identity(), unused.clone())
        .unwrap();
    assert!(Arc::ptr_eq(&admitted, &reused));
    assert_eq!(first.0.load(Ordering::SeqCst), 0);
    assert_eq!(unused.0.load(Ordering::SeqCst), 1);
    let mut other = identity();
    other.home = Some("isolated-b".into());
    let rejected = Arc::new(Resource(AtomicUsize::new(0)));
    assert_eq!(
        state
            .session_runtime("s1", &other, rejected.clone())
            .err()
            .unwrap()
            .code,
        ErrorCode::RuntimeUnavailable
    );
    assert_eq!(rejected.0.load(Ordering::SeqCst), 1);
    state.take_session_runtime("s1").unwrap().unwrap().close();
    assert_eq!(first.0.load(Ordering::SeqCst), 1);
    assert!(state.take_session_runtime("s1").unwrap().is_none());
}
#[test]
fn native_question_metadata_survives_canonical_serde_and_legacy_stays_unchanged() {
    let native = serde_json::json!({"id":"opaque", "question":"Which?", "header":"Choice", "options":[], "multiSelect":false,"isOther":false,"isSecret":true});
    let parsed: SessionQuestion = serde_json::from_value(native.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), native);
    let legacy = serde_json::json!({"question":"Which?", "header":"Choice", "options":[], "multiSelect":false});
    let parsed: SessionQuestion = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), legacy);
}
#[test]
fn codex_permissions_require_valid_live_snapshot_and_keep_supported_ceiling() {
    assert!(!adapter::resolve_capability(
        AgentRuntime::Codex,
        None,
        "permissions"
    ));
    let caps = adapter::native_capabilities(AgentRuntime::Codex);
    assert!(adapter::resolve_capability(
        AgentRuntime::Codex,
        Some(&caps),
        "permissions"
    ));
    assert!(!adapter::resolve_capability(
        AgentRuntime::Codex,
        Some(&caps),
        "subagents"
    ));
    assert!(!adapter::resolve_capability(
        AgentRuntime::Pi,
        Some(&caps),
        "permissions"
    ));
}

struct Projection<'a>(&'a crate::session::testenv::TestEnv);
impl RuntimeEffectPort for Projection<'_> {
    fn apply(&self, scope: &RuntimeScope, event: RuntimeEvent) -> Result<(), AppError> {
        projection::apply_to_session(self.0, "/fixture", scope, event, |_| None).map(|_| ())
    }
}
#[test]
fn native_request_projects_capabilities_first_nonblocking_and_redacted_confirmation() {
    let mut session = test_session();
    session.agent_runtime = AgentRuntime::Codex;
    session.status = "running".into();
    let env = crate::session::testenv::TestEnv {
        engine: test_engine_with(session),
        ..Default::default()
    };
    let context = super::super::turn::build_turn_context(
        &env.engine,
        "s1",
        "b".into(),
        "hi".into(),
        TurnMode::Normal,
    )
    .unwrap();
    let (_, owner) = EngineState(&env.engine).claim_start(context).unwrap();
    let effects = Projection(&env);
    let publish = |sequence, event| {
        application::apply_event(
            &owner,
            &effects,
            RuntimeEventEnvelope {
                scope: owner.scope.clone(),
                sequence,
                event,
            },
        )
        .unwrap()
    };
    publish(
        1,
        RuntimeEvent::Capabilities(adapter::native_capabilities(AgentRuntime::Codex)),
    );
    let question:SessionQuestion=serde_json::from_value(serde_json::json!({"id":"opaque","question":"Secret?","header":"Secret","options":[],"multiSelect":false,"isSecret":true})).unwrap();
    publish(
        2,
        RuntimeEvent::QuestionAsked {
            block_id: "q".into(),
            questions: vec![question],
            blocking: Some(false),
        },
    );
    assert_eq!(owner.pending_counts().questions, 0);
    assert_eq!(
        env.engine
            .with_session("s1", |s| s.status.clone())
            .as_deref(),
        Some("running")
    );
    let events = env.session_events.lock().unwrap();
    assert!(matches!(&events[0],SessionEvent::Meta {meta} if meta.runtime_generation.is_some()));
    assert!(matches!(
        &events[1],
        SessionEvent::QuestionAsked {
            blocking: Some(false),
            ..
        }
    ));
    drop(events);
    publish(
        3,
        RuntimeEvent::QuestionAnswered {
            block_id: "q".into(),
            answers: serde_json::json!({"opaque":"SENTINEL_PRIVATE"}),
        },
    );
    publish(4, RuntimeEvent::TurnFinished);
    let events = env.session_events.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, SessionEvent::QuestionResolved { .. }))
            .count(),
        1
    );
    assert!(!serde_json::to_string(&*events)
        .unwrap()
        .contains("SENTINEL_PRIVATE"));
    let block = env
        .engine
        .with_session("s1", |s| {
            s.block_buffer.iter().find(|b| b.block_id == "q").cloned()
        })
        .flatten()
        .unwrap();
    let stored = persistence::persisted_block_json(&block);
    assert_eq!(stored["blocking"], false);
    assert_eq!(stored["answers"]["opaque"], "[redacted]");
    let reloaded = persistence::parse_persisted_block(&stored.to_string()).unwrap();
    assert_eq!(classify_block(&reloaded)["blocking"], false);
}
#[test]
fn failed_anchor_commit_is_returned_to_native_sink_without_mutation() {
    let env = crate::session::testenv::TestEnv {
        engine: test_engine_with(test_session()),
        ..Default::default()
    };
    *env.persist_failure.lock().unwrap() =
        Some(AppError::new(ErrorCode::SettingsWriteFailed, "injected"));
    let (_, owner) = EngineState(&env.engine)
        .claim_start(
            super::super::turn::build_turn_context(
                &env.engine,
                "s1",
                "b".into(),
                "hi".into(),
                TurnMode::Normal,
            )
            .unwrap(),
        )
        .unwrap();
    let error = application::apply_event(
        &owner,
        &Projection(&env),
        RuntimeEventEnvelope {
            scope: owner.scope.clone(),
            sequence: 1,
            event: RuntimeEvent::ResumeAnchor("uncommitted".into()),
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::SettingsWriteFailed);
    assert_eq!(
        env.engine
            .with_session("s1", |s| s.claude_session_id.clone())
            .flatten(),
        None
    );
    assert_eq!(*env.persist_calls.lock().unwrap(), 0);
}
#[test]
fn generation_replacement_drops_the_previous_live_snapshot() {
    let mut session = test_session();
    session.agent_runtime = AgentRuntime::Codex;
    session.status = "running".into();
    session.effective_capabilities = Some(adapter::native_capabilities(AgentRuntime::Codex));
    session.runtime_generation = Some("0".into());
    let engine = test_engine_with(session);
    assert!(engine.require_capability("s1", "permissions").is_ok());
    let context = super::super::turn::build_turn_context(
        &engine,
        "s1",
        "b".into(),
        "hi".into(),
        TurnMode::Normal,
    )
    .unwrap();
    EngineState(&engine).claim_start(context).unwrap();
    let (caps, generation) = engine
        .with_session("s1", |s| {
            (
                s.effective_capabilities.clone(),
                s.runtime_generation.clone(),
            )
        })
        .unwrap();
    assert!(caps.is_none());
    assert_eq!(generation.as_deref(), Some("1"));
    assert_eq!(
        engine.require_capability("s1", "permissions"),
        Err((
            ErrorCode::RuntimeUnavailable,
            adapter::capabilities::CAPABILITY_DISCONNECTED
        ))
    );
}
