use super::*;
use crate::session::testenv::TestEnv;
use crate::session::testutil::{test_engine_with, test_session};

fn context(engine: &Engine) -> TurnContext {
    super::super::turn::build_turn_context(
        engine,
        "s1",
        "turn".into(),
        "hello".into(),
        TurnMode::Normal,
    )
    .unwrap()
}
#[test]
fn missing_saved_account_is_rejected_before_runtime_resolution() {
    let known = std::collections::HashSet::from(["default".to_string(), "available".to_string()]);
    assert!(require_known_account("default", &known).is_ok());
    assert_eq!(
        require_known_account("missing-native", &known)
            .unwrap_err()
            .code,
        ErrorCode::AccountNotFound
    );
    struct Missing;
    impl crate::account::AccountKinds for Missing {
        fn kind_of(&self, _: &str) -> crate::account::AccountKind {
            crate::account::AccountKind::ClaudeCodeOauth
        }
        fn exists(&self, _: &str) -> bool {
            false
        }
    }
    let mut session = test_session();
    session.agent_runtime = AgentRuntime::Codex;
    session.protocol = ProviderProtocol::Openai;
    session.account_id = "missing-native".into();
    assert_eq!(session.meta(&Missing).agent_runtime, AgentRuntime::Codex);
}
#[test]
fn competing_start_cannot_replace_owner_and_old_projection_cannot_mutate_new_owner() {
    let env = TestEnv {
        engine: test_engine_with(test_session()),
        ..Default::default()
    };
    let state = EngineState(&env.engine);
    let (_, first) = state.claim_start(context(&env.engine)).unwrap();
    assert_eq!(
        state.claim_start(context(&env.engine)).err().unwrap().code,
        ErrorCode::SessionBusy
    );
    state.claim_close("s1").unwrap();
    let (_, second) = state.claim_start(context(&env.engine)).unwrap();
    assert!(second.scope.generation > first.scope.generation);
    let _ = projection::apply_to_session(
        &env,
        "/fixture",
        &first.scope,
        RuntimeEvent::ResumeAnchor("stale".into()),
        |_| None,
    );
    assert_eq!(
        env.engine
            .with_session("s1", |s| s.claude_session_id.clone())
            .flatten(),
        None
    );
    assert_eq!(*env.persist_calls.lock().unwrap(), 0);
    let _ = projection::apply_to_session(
        &env,
        "/fixture",
        &second.scope,
        RuntimeEvent::ResumeAnchor("native-current".into()),
        |_| None,
    );
    assert_eq!(
        env.engine
            .with_session("s1", |s| s.claude_session_id.clone())
            .flatten()
            .as_deref(),
        Some("native-current")
    );
    assert_eq!(*env.persist_calls.lock().unwrap(), 1);
}
#[test]
fn normalized_tool_details_and_usage_use_real_projection_without_filesystem() {
    let env = TestEnv {
        engine: test_engine_with(test_session()),
        ..Default::default()
    };
    let state = EngineState(&env.engine);
    let (_, owner) = state.claim_start(context(&env.engine)).unwrap();
    let apply =
        |event| projection::apply_to_session(&env, "/fixture", &owner.scope, event, |_| None);
    let _ = apply(RuntimeEvent::ToolStarted {
        block_id: "tool".into(),
        tool: "Edit".into(),
        summary: "one file".into(),
    });
    let detail = build_step_detail(
        "tool",
        "Edit",
        "/fixture",
        "native",
        1,
        2,
        false,
        None,
        &serde_json::json!({"file_path":"x"}),
        "done",
        None,
    );
    let _ = apply(RuntimeEvent::ToolCompleted {
        block_id: "tool".into(),
        meta: "done".into(),
        detail: Some(detail),
        affects_workspace: true,
    });
    assert_eq!(env.step_details.lock().unwrap().len(), 1);
    assert_eq!(env.diff_notes.lock().unwrap().len(), 1);
    assert!(matches!(
        env.session_events.lock().unwrap().last(),
        Some(SessionEvent::ToolDone {
            has_detail: Some(true),
            ..
        })
    ));
    let _ = apply(RuntimeEvent::AssistantFinal {
        block_id: "answer".into(),
        text: "whole native message".into(),
    });
    let _ = apply(RuntimeEvent::Usage {
        context_used_tokens: Some(50),
        input_tokens: None,
        output_tokens: None,
        cost: None,
    });
    let _ = apply(RuntimeEvent::Usage {
        context_used_tokens: Some(30),
        input_tokens: None,
        output_tokens: None,
        cost: None,
    });
    env.engine.with_session("s1", |s| {
        assert_eq!(s.context_used_tokens, 30);
        assert_eq!(s.metrics.as_ref().unwrap().input_tokens, None);
        assert_eq!(s.metrics.as_ref().unwrap().cost_usd, None);
    });
}
/// process-settings-and-metrics FR-1/AC-1: the execution snapshot binds each
/// account to its OWN home — two isolated native accounts never share an
/// environment, only the built-in account runs on the ambient home, a signed-out
/// home fails preflight with the typed error, and a start whose account no
/// longer maps to the runtime it was routed to fails instead of spawning with
/// no home override.
#[test]
fn execution_snapshot_binds_each_account_to_its_own_home_and_never_ambient() {
    use crate::account::AccountKind;
    let engine = test_engine_with(test_session());
    let base = context(&engine);
    let signed_in = |_: AgentRuntime, home: &str| home != "/homes/signed-out";
    let resolve = |account: &str, runtime, kind, home: Option<&str>| {
        let mut ctx = base.clone();
        ctx.account_id = account.into();
        resolve_execution(&mut ctx, runtime, (kind, home.map(String::from)), signed_in)
            .map(|()| ctx)
    };

    let a = resolve(
        "codex-a",
        AgentRuntime::Codex,
        AccountKind::CodexCli,
        Some("/homes/a"),
    )
    .unwrap();
    let b = resolve(
        "codex-b",
        AgentRuntime::Codex,
        AccountKind::CodexCli,
        Some("/homes/b"),
    )
    .unwrap();
    assert_eq!(
        a.execution.environment,
        vec![("CODEX_HOME".to_string(), "/homes/a".to_string())]
    );
    assert_eq!(
        b.execution.environment,
        vec![("CODEX_HOME".to_string(), "/homes/b".to_string())]
    );
    assert_eq!(a.execution.identity.account_id, "codex-a");
    assert_eq!(a.execution.identity.home.as_deref(), Some("/homes/a"));
    assert!(
        a.execution.identity != b.execution.identity,
        "native reuse is account-bound"
    );
    assert!(a.execution.account_authenticated && b.execution.account_authenticated);

    let claude = resolve(
        "work",
        AgentRuntime::ClaudeCode,
        AccountKind::ClaudeCodeOauth,
        Some("/homes/work"),
    )
    .unwrap();
    assert_eq!(
        claude.execution.environment,
        vec![("CLAUDE_CONFIG_DIR".to_string(), "/homes/work".to_string())]
    );
    let builtin = resolve(
        "default",
        AgentRuntime::ClaudeCode,
        AccountKind::ClaudeCodeOauth,
        None,
    )
    .unwrap();
    assert!(builtin.execution.environment.is_empty() && builtin.execution.identity.home.is_none());
    assert!(builtin.execution.account_authenticated);

    let codex_out = resolve(
        "codex-a",
        AgentRuntime::Codex,
        AccountKind::CodexCli,
        Some("/homes/signed-out"),
    )
    .unwrap();
    assert!(!codex_out.execution.account_authenticated);
    assert_eq!(
        RuntimePort::preflight(&adapter::codex::CodexAdapter, &codex_out)
            .unwrap_err()
            .code,
        ErrorCode::AccountNotAuthenticated
    );
    let claude_out = resolve(
        "work",
        AgentRuntime::ClaudeCode,
        AccountKind::ClaudeCodeOauth,
        Some("/homes/signed-out"),
    )
    .unwrap();
    assert_eq!(
        RuntimePort::preflight(&adapter::ClaudeCodeAdapter, &claude_out)
            .unwrap_err()
            .code,
        ErrorCode::AccountNotAuthenticated
    );

    // Routed as Codex, but the account now resolves to the built-in Claude one
    // (removed and repointed mid-start): a typed error, not an ambient spawn.
    assert_eq!(
        resolve(
            "codex-a",
            AgentRuntime::Codex,
            AccountKind::ClaudeCodeOauth,
            None
        )
        .err()
        .unwrap()
        .code,
        ErrorCode::AccountNotFound
    );
}
