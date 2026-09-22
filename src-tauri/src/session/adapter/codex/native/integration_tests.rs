//! The real adapter entry and supervised JSONL process, with a deterministic
//! native peer. Live authenticated coverage is separately ignored/opted in.
use super::{runtime::NativeRuntime, transport::Transport};
use crate::ipc::{AppError, ErrorCode};
use crate::session::application::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Sink {
    events: Mutex<Vec<RuntimeEventEnvelope>>,
    ready: Condvar,
    fail_anchor: bool,
}
impl RuntimeEventSink for Sink {
    fn publish(&self, event: RuntimeEventEnvelope) -> Result<ApplyOutcome, AppError> {
        if self.fail_anchor && matches!(event.event, RuntimeEvent::ResumeAnchor(_)) {
            return Err(AppError::new(
                ErrorCode::Internal,
                "fixture persistence failure",
            ));
        }
        self.events.lock().unwrap().push(event);
        self.ready.notify_all();
        Ok(ApplyOutcome::Applied)
    }
}
impl Sink {
    fn wait(&self, predicate: impl Fn(&RuntimeEvent) -> bool) -> RuntimeEvent {
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut events = self.events.lock().unwrap();
        loop {
            if let Some(event) = events.iter().find(|event| predicate(&event.event)) {
                return event.event.clone();
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "expected native effect was not published ({} effects)",
                events.len()
            );
            events = self.ready.wait_timeout(events, remaining).unwrap().0;
        }
    }
    fn terminal(&self) {
        self.wait(|event| {
            matches!(
                event,
                RuntimeEvent::TurnFinished | RuntimeEvent::TurnFailed(_)
            )
        });
    }
}
fn context(generation: u64, resume: Option<&str>) -> TurnContext {
    TurnContext {
        scope: RuntimeScope {
            session_id: "fixture-session".into(),
            turn_id: format!("application-turn-{generation}"),
            generation,
        },
        execution: ExecutionConfig {
            identity: ExecutionIdentity {
                account_id: "fixture-account".into(),
                runtime: "native".into(),
                home: Some("fixture-home".into()),
                worktree_distro: None,
            },
            account_authenticated: true,
            ..Default::default()
        },
        session_id: "fixture-session".into(),
        block_id: format!("application-turn-{generation}"),
        text: "fixture prompt".into(),
        mode: TurnMode::Normal,
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        model_id: "fixture-model".into(),
        effort: Some("low".into()),
        permission_mode: "default".into(),
        runtime: "native".into(),
        worktree_distro: None,
        account_id: "fixture-account".into(),
        allow_git: false,
        resume: resume.map(String::from),
        system_prompt: None,
        extra_args: vec![],
        response_mode: crate::session::ResponseMode::Default,
    }
}
pub(super) fn runtime(scenario: &str) -> (NativeRuntime, Arc<AtomicUsize>) {
    let scenario = scenario.to_string();
    let spawns = Arc::new(AtomicUsize::new(0));
    let count = spawns.clone();
    (
        NativeRuntime::with_launcher(Arc::new(move |ctx, receive| {
            count.fetch_add(1, Ordering::SeqCst);
            Transport::spawn_program(
                "node",
                &[
                    "-e".into(),
                    include_str!("fixtures/fake-server.cjs").into(),
                    scenario.clone(),
                ],
                &ctx.cwd,
                &ctx.execution.environment,
                receive,
            )
        })),
        spawns,
    )
}
#[test]
fn two_adapter_turns_reuse_process_anchor_and_text_block_then_close_explicitly() {
    let (runtime, spawns) = runtime("plain");
    let first = Arc::new(Sink::default());
    let old = runtime.begin_turn(context(1, None), first.clone()).unwrap();
    first.terminal();
    let anchor = match first.wait(|event| matches!(event, RuntimeEvent::ResumeAnchor(_))) {
        RuntimeEvent::ResumeAnchor(anchor) => anchor,
        _ => unreachable!(),
    };
    let events = first.events.lock().unwrap();
    let delta = events
        .iter()
        .find_map(|e| match &e.event {
            RuntimeEvent::AssistantDelta { block_id, .. } => Some(block_id),
            _ => None,
        })
        .unwrap();
    let final_id = events
        .iter()
        .find_map(|e| match &e.event {
            RuntimeEvent::AssistantFinal { block_id, .. } => Some(block_id),
            _ => None,
        })
        .unwrap();
    assert_eq!(delta, final_id);
    assert!(events
        .windows(2)
        .all(|pair| pair[0].sequence < pair[1].sequence));
    drop(events);
    old.kill();
    let second = Arc::new(Sink::default());
    runtime
        .begin_turn(context(2, Some(&anchor)), second.clone())
        .unwrap();
    second.terminal();
    assert_eq!(spawns.load(Ordering::SeqCst), 1);
    assert_eq!(
        old.answer_question("old", &json!({})),
        ControlAck::NotPending
    );
    let mut changed = context(3, Some(&anchor));
    changed.execution.identity.home = Some("different-home".into());
    assert_eq!(
        runtime.preflight(&changed).unwrap_err().code,
        ErrorCode::RuntimeUnavailable
    );
    runtime.close();
    assert!(runtime.preflight(&context(3, Some(&anchor))).is_err());
}
#[test]
fn command_offered_choices_confirm_once_and_never_infer_tool_success() {
    let (runtime, _) = runtime("permission");
    let sink = Arc::new(Sink::default());
    let control = runtime.begin_turn(context(1, None), sink.clone()).unwrap();
    let (block, ask) =
        match sink.wait(|event| matches!(event, RuntimeEvent::PermissionAsked { .. })) {
            RuntimeEvent::PermissionAsked { block_id, ask } => (block_id, ask),
            _ => unreachable!(),
        };
    assert!(!block.contains("native-turn"));
    assert_eq!(
        ask.allowed_decisions,
        Some(vec!["allowOnce".into(), "cancel".into()])
    );
    assert_eq!(
        control.decide_permission(&block, PermissionDecision::Deny),
        ControlAck::Unsupported
    );
    assert_eq!(control.pending_counts().permissions, 1);
    assert_eq!(
        control.decide_permission(&block, PermissionDecision::Allow),
        ControlAck::AwaitingConfirmation
    );
    sink.wait(
        |event| matches!(event,RuntimeEvent::PermissionDecided{outcome,..} if outcome=="allowed"),
    );
    sink.terminal();
    assert_eq!(
        control.decide_permission(&block, PermissionDecision::Allow),
        ControlAck::NotPending
    );
    let events = sink.events.lock().unwrap();
    assert!(matches!(events[0].event, RuntimeEvent::Capabilities(_)));
    assert!(!events
        .iter()
        .any(|event| matches!(event.event, RuntimeEvent::ToolCompleted { .. })));
}
#[test]
fn file_approval_uses_own_defaults_and_correlated_detail() {
    let (runtime, _) = runtime("file");
    let sink = Arc::new(Sink::default());
    let control = runtime.begin_turn(context(1, None), sink.clone()).unwrap();
    let (block, ask) =
        match sink.wait(|event| matches!(event, RuntimeEvent::PermissionAsked { .. })) {
            RuntimeEvent::PermissionAsked { block_id, ask } => (block_id, ask),
            _ => unreachable!(),
        };
    assert_eq!(
        ask.allowed_decisions,
        Some(vec!["allowOnce".into(), "denyOnce".into(), "cancel".into()])
    );
    assert!(ask.input_json.contains("fixture.txt"));
    assert!(!ask.input_json.contains("command-item"));
    assert!(!ask.input_json.contains("unrelated.txt"));
    assert_eq!(
        control.decide_permission(&block, PermissionDecision::Cancel),
        ControlAck::AwaitingConfirmation
    );
    sink.wait(
        |event| matches!(event,RuntimeEvent::PermissionDecided{outcome,..} if outcome=="cancelled"),
    );
    sink.terminal();
}
#[test]
fn secret_reply_reaches_native_stdin_only_and_nonblocking_question_does_not_park() {
    let (runtime, _) = runtime("question");
    let sink = Arc::new(Sink::default());
    let control = runtime.begin_turn(context(1, None), sink.clone()).unwrap();
    let block = match sink.wait(|event| matches!(event, RuntimeEvent::QuestionAsked { .. })) {
        RuntimeEvent::QuestionAsked {
            block_id,
            questions,
            blocking,
        } => {
            assert_eq!(blocking, Some(false));
            assert_eq!(questions[0].id.as_deref(), Some("opaque-secret"));
            block_id
        }
        _ => unreachable!(),
    };
    assert_eq!(control.pending_counts().questions, 0);
    assert_eq!(
        control.answer_question(&block, &json!({"wrong":"secret"})),
        ControlAck::InvalidAnswer
    );
    assert_eq!(
        control.answer_question(&block, &json!({"opaque-secret":"SENTINEL-NATIVE-SECRET"})),
        ControlAck::AwaitingConfirmation
    );
    match sink.wait(|event| matches!(event, RuntimeEvent::QuestionAnswered { .. })) {
        RuntimeEvent::QuestionAnswered { answers, .. } => {
            assert_eq!(answers, json!({"opaque-secret":"[redacted]"}))
        }
        _ => unreachable!(),
    };
    sink.terminal();
    for event in sink.events.lock().unwrap().iter() {
        match &event.event {
            RuntimeEvent::AssistantDelta { text, .. }
            | RuntimeEvent::AssistantFinal { text, .. } => {
                assert!(!text.contains("SENTINEL-NATIVE-SECRET"))
            }
            RuntimeEvent::TurnFailed(error) | RuntimeEvent::ConnectionClosed(error) => {
                assert!(!error.message.contains("SENTINEL-NATIVE-SECRET"))
            }
            _ => {}
        }
    }
}
#[test]
fn stop_before_started_latches_interrupt_and_keeps_connection_owned() {
    let (runtime, spawns) = runtime("stop");
    let sink = Arc::new(Sink::default());
    let control = runtime.begin_turn(context(1, None), sink.clone()).unwrap();
    control.interrupt();
    sink.terminal();
    assert_eq!(spawns.load(Ordering::SeqCst), 1);
    assert!(!runtime.inner.state.lock().unwrap().closed);
    assert_eq!(
        sink.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(
                e.event,
                RuntimeEvent::TurnFinished | RuntimeEvent::TurnFailed(_)
            ))
            .count(),
        1
    );
}
#[test]
fn invalid_resume_never_starts_a_replacement_thread_or_delivers_prompt() {
    let (runtime, _) = runtime("plain");
    let sink = Arc::new(Sink::default());
    runtime
        .begin_turn(context(1, Some("invalid-anchor")), sink.clone())
        .unwrap();
    sink.wait(|event| matches!(event, RuntimeEvent::ConnectionClosed(_)));
    assert!(!sink.events.lock().unwrap().iter().any(|e| matches!(
        e.event,
        RuntimeEvent::ResumeAnchor(_)
            | RuntimeEvent::PromptDelivered(_)
            | RuntimeEvent::AssistantFinal { .. }
    )));
}
#[test]
fn failed_anchor_persistence_prevents_native_turn_start() {
    let (runtime, _) = runtime("plain");
    let sink = Arc::new(Sink {
        fail_anchor: true,
        ..Default::default()
    });
    runtime.begin_turn(context(1, None), sink.clone()).unwrap();
    sink.wait(|event| matches!(event, RuntimeEvent::ConnectionClosed(_)));
    assert!(!sink.events.lock().unwrap().iter().any(|e| matches!(
        e.event,
        RuntimeEvent::PromptDelivered(_) | RuntimeEvent::AssistantFinal { .. }
    )));
}
#[test]
fn eof_after_terminal_invalidates_session_connection() {
    let (runtime, _) = runtime("idle-eof");
    let sink = Arc::new(Sink::default());
    runtime.begin_turn(context(1, None), sink.clone()).unwrap();
    sink.terminal();
    sink.wait(|event| matches!(event, RuntimeEvent::ConnectionClosed(_)));
    assert!(runtime.inner.state.lock().unwrap().closed);
}
fn final_text(sink: &Sink) -> String {
    match sink.wait(|event| matches!(event, RuntimeEvent::AssistantFinal { .. })) {
        RuntimeEvent::AssistantFinal { text, .. } => text,
        _ => unreachable!(),
    }
}
/// process-settings-and-metrics AC-1: two isolated Codex accounts, resolved by
/// the production execution snapshot, each launch their own App Server under
/// their own `CODEX_HOME` — no environment crossover, no ambient home.
#[test]
fn two_native_accounts_launch_under_their_own_homes() {
    use crate::account::AccountKind;
    use crate::session::AgentRuntime;
    for home in ["fixture-home-a", "fixture-home-b"] {
        let (runtime, spawns) = runtime("home");
        let sink = Arc::new(Sink::default());
        let mut ctx = context(1, None);
        ctx.account_id = format!("account-{home}");
        crate::session::runtime_bridge::resolve_execution(
            &mut ctx,
            AgentRuntime::Codex,
            (AccountKind::CodexCli, Some(home.into())),
            |_, _| true,
        )
        .unwrap();
        runtime.begin_turn(ctx, sink.clone()).unwrap();
        sink.terminal();
        assert_eq!(final_text(&sink), format!("home:{home}"));
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        runtime.close();
    }
}
/// process-settings-and-metrics FR-5/AC-4: context occupancy is the LAST
/// request's size, never the thread-cumulative total; the cumulative counters
/// are reported as aggregates, and no cost is invented. A turn whose server
/// reports no usage publishes no usage at all — unknown stays unknown.
#[test]
fn native_usage_separates_occupancy_from_aggregate_and_absent_usage_stays_unknown() {
    let (runtime, _) = runtime("usage");
    let sink = Arc::new(Sink::default());
    runtime.begin_turn(context(1, None), sink.clone()).unwrap();
    sink.terminal();
    match sink.wait(|event| matches!(event, RuntimeEvent::Usage { .. })) {
        RuntimeEvent::Usage {
            context_used_tokens,
            input_tokens,
            output_tokens,
            cost,
        } => {
            assert_eq!(context_used_tokens, Some(31000));
            assert_eq!(input_tokens, Some(80000));
            assert_eq!(output_tokens, Some(10000));
            assert_eq!(cost, None);
        }
        _ => unreachable!(),
    }
    runtime.close();

    let (runtime, _) = self::runtime("plain");
    let sink = Arc::new(Sink::default());
    runtime.begin_turn(context(1, None), sink.clone()).unwrap();
    sink.terminal();
    assert!(!sink
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e.event, RuntimeEvent::Usage { .. })));
    runtime.close();
}
