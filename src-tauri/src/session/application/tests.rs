use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct Effects(Mutex<Vec<RuntimeEvent>>);
impl RuntimeEffectPort for Effects {
    fn apply(&self, _: &RuntimeScope, event: RuntimeEvent) -> Result<(), AppError> {
        self.0.lock().unwrap().push(event);
        Ok(())
    }
}
fn owner(generation: u64) -> RuntimeOwner {
    RuntimeOwner::new(RuntimeScope {
        session_id: "s1".into(),
        turn_id: "b1".into(),
        generation,
    })
}
fn event(owner: &RuntimeOwner, sequence: u64, event: RuntimeEvent) -> RuntimeEventEnvelope {
    RuntimeEventEnvelope {
        scope: owner.scope.clone(),
        sequence,
        event,
    }
}
#[test]
fn duplicate_old_and_closed_output_has_no_effect() {
    let live = owner(2);
    let effects = Effects::default();
    let first = event(&live, 1, RuntimeEvent::ResumeAnchor("native-id".into()));
    assert_eq!(
        apply_event(&live, &effects, first.clone()),
        Ok(ApplyOutcome::Applied)
    );
    assert_eq!(
        apply_event(&live, &effects, first),
        Ok(ApplyOutcome::Duplicate)
    );
    let mut old = event(&live, 8, RuntimeEvent::ResumeAnchor("old".into()));
    old.scope.generation = 1;
    assert_eq!(apply_event(&live, &effects, old), Ok(ApplyOutcome::Stale));
    let mut wrong_turn = event(&live, 9, RuntimeEvent::ResumeAnchor("old".into()));
    wrong_turn.scope.turn_id = "other".into();
    assert_eq!(
        apply_event(&live, &effects, wrong_turn),
        Ok(ApplyOutcome::Stale)
    );
    assert_eq!(
        apply_event(
            &live,
            &effects,
            event(&live, 10, RuntimeEvent::TurnFinished)
        ),
        Ok(ApplyOutcome::Applied)
    );
    assert_eq!(
        apply_event(
            &live,
            &effects,
            event(&live, 10, RuntimeEvent::TurnFinished)
        ),
        Ok(ApplyOutcome::Duplicate)
    );
    assert_eq!(
        apply_event(
            &live,
            &effects,
            event(&live, 11, RuntimeEvent::ResumeAnchor("late".into()))
        ),
        Ok(ApplyOutcome::Closed)
    );
    assert_eq!(effects.0.lock().unwrap().len(), 2);
}

#[test]
fn accepted_effects_remain_in_sequence_while_first_publication_is_blocked() {
    use std::sync::mpsc;
    struct BlockingEffects {
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
        observed: mpsc::Sender<String>,
    }
    impl RuntimeEffectPort for BlockingEffects {
        fn apply(&self, _: &RuntimeScope, event: RuntimeEvent) -> Result<(), AppError> {
            if let RuntimeEvent::ResumeAnchor(text) = event {
                if text == "first" {
                    self.entered.send(()).unwrap();
                    self.release.lock().unwrap().recv().unwrap();
                }
                self.observed.send(text).unwrap();
            }
            Ok(())
        }
    }
    let live = owner(1);
    let (entered_tx, entered) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    let (observed_tx, observed) = mpsc::channel();
    let effects = BlockingEffects {
        entered: entered_tx,
        release: Mutex::new(release_rx),
        observed: observed_tx,
    };
    std::thread::scope(|threads| {
        threads.spawn(|| {
            apply_event(
                &live,
                &effects,
                event(&live, 1, RuntimeEvent::ResumeAnchor("first".into())),
            )
        });
        entered.recv().unwrap();
        threads.spawn(|| {
            apply_event(
                &live,
                &effects,
                event(&live, 2, RuntimeEvent::ResumeAnchor("second".into())),
            )
        });
        let premature = observed.recv_timeout(std::time::Duration::from_millis(50));
        release.send(()).unwrap();
        assert!(
            premature.is_err(),
            "second effect overtook accepted first effect"
        );
    });
    assert_eq!(observed.recv().unwrap(), "first");
    assert_eq!(observed.recv().unwrap(), "second");
}
#[test]
fn replayed_request_never_reopens_resolved_card() {
    let live = owner(1);
    let effects = Effects::default();
    let resolved = RuntimeEvent::RequestResolved {
        block_id: "q".into(),
        kind: RequestKind::Question,
        outcome: "answered".into(),
    };
    let _ = apply_event(&live, &effects, event(&live, 1, resolved));
    let _ = apply_event(
        &live,
        &effects,
        event(
            &live,
            2,
            RuntimeEvent::QuestionAsked {
                blocking: None,
                block_id: "q".into(),
                questions: vec![],
            },
        ),
    );
    assert_eq!(effects.0.lock().unwrap().len(), 1);
}
struct Control {
    writes: AtomicUsize,
    kills: AtomicUsize,
    ack: Mutex<ControlAck>,
    interrupts: AtomicUsize,
}
impl TurnControl for Control {
    fn interrupt(&self) {
        self.interrupts.fetch_add(1, Ordering::SeqCst);
    }
    fn kill(&self) {
        self.kills.fetch_add(1, Ordering::SeqCst);
    }
    fn answer_question(&self, _: &str, _: &Value) -> ControlAck {
        let ack = *self.ack.lock().unwrap();
        if ack != ControlAck::NotPending {
            self.writes.fetch_add(1, Ordering::SeqCst);
        }
        ack
    }
    fn decide_permission(&self, _: &str, _: PermissionDecision) -> ControlAck {
        let ack = *self.ack.lock().unwrap();
        if ack != ControlAck::NotPending {
            self.writes.fetch_add(1, Ordering::SeqCst);
        }
        ack
    }
    fn pending_permission_pattern(&self, _: &str) -> Option<String> {
        Some("Bash(test)".into())
    }
    fn pending_counts(&self) -> PendingCounts {
        PendingCounts {
            questions: 1,
            permissions: 1,
        }
    }
    fn drain_pending(&self) -> (Vec<String>, Vec<String>) {
        (vec![], vec![])
    }
}
fn control(ack: ControlAck) -> Arc<Control> {
    Arc::new(Control {
        writes: AtomicUsize::new(0),
        kills: AtomicUsize::new(0),
        ack: Mutex::new(ack),
        interrupts: AtomicUsize::new(0),
    })
}
#[test]
fn close_during_start_refuses_and_terminates_late_control() {
    let live = owner(1);
    let c = control(ControlAck::Applied);
    close_owner(&live, &Effects::default()).unwrap();
    assert!(!install_control(&live, c.clone()));
    assert_eq!(c.kills.load(Ordering::SeqCst), 1);
}
#[test]
fn awaiting_confirmation_claims_write_but_does_not_resolve_card() {
    let live = owner(1);
    let c = control(ControlAck::AwaitingConfirmation);
    install_control(&live, c.clone());
    let effects = Effects::default();
    assert!(answer_on_owner(&live, &effects, "q", &serde_json::json!({"a":"yes"})).is_ok());
    assert!(answer_on_owner(&live, &effects, "q", &serde_json::json!({"a":"yes"})).is_err());
    assert_eq!(c.writes.load(Ordering::SeqCst), 1);
    assert!(effects.0.lock().unwrap().is_empty());
}
#[test]
fn closed_channel_resolves_cancelled_once_and_is_not_retried() {
    let live = owner(1);
    let c = control(ControlAck::ChannelClosed);
    install_control(&live, c.clone());
    let effects = Effects::default();
    assert_eq!(
        answer_on_owner(&live, &effects, "q", &Value::Null)
            .unwrap_err()
            .code,
        ErrorCode::QuestionNotPending
    );
    assert!(answer_on_owner(&live, &effects, "q", &Value::Null).is_err());
    assert_eq!(c.writes.load(Ordering::SeqCst), 1);
    assert!(
        matches!(&effects.0.lock().unwrap()[0],RuntimeEvent::RequestResolved { outcome,.. } if outcome=="cancelled")
    );
}

fn context(id: &str) -> TurnContext {
    TurnContext {
        session_id: id.into(),
        block_id: "turn".into(),
        text: "hello".into(),
        mode: TurnMode::Normal,
        cwd: "/fixture".into(),
        model_id: "model-a".into(),
        effort: None,
        permission_mode: "default".into(),
        runtime: "native".into(),
        worktree_distro: None,
        account_id: "saved-account".into(),
        allow_git: false,
        resume: None,
        system_prompt: None,
        extra_args: vec![],
        response_mode: ResponseMode::Default,
        scope: RuntimeScope::default(),
        execution: ExecutionConfig::default(),
    }
}
struct State {
    id: String,
    runtime: AgentRuntime,
    owner: Mutex<Option<Arc<RuntimeOwner>>>,
    generation: AtomicUsize,
    revision: AtomicUsize,
    model: Mutex<String>,
}
impl State {
    fn new(id: &str) -> Self {
        Self {
            id: id.into(),
            runtime: AgentRuntime::ClaudeCode,
            owner: Mutex::new(None),
            generation: AtomicUsize::new(0),
            revision: AtomicUsize::new(0),
            model: Mutex::new("model-a".into()),
        }
    }
}
impl SessionStatePort for State {
    fn dispatch_control(
        &self,
        scope: &RuntimeScope,
        action: &mut dyn FnMut(&RuntimeOwner) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let owner = self.owner.lock().unwrap();
        let owner = owner
            .as_ref()
            .filter(|owner| owner.scope == *scope)
            .ok_or_else(|| {
                AppError::new(ErrorCode::SessionNotRunning, "runtime scope was replaced")
            })?;
        action(owner)
    }
    fn snapshot(&self, id: &str) -> Result<SessionSnapshot, AppError> {
        if id != self.id {
            return Err(AppError::new(ErrorCode::SessionNotFound, "no such session"));
        }
        Ok(SessionSnapshot {
            runtime: self.runtime,
            status: "starting".into(),
            owner: self.owner.lock().unwrap().clone(),
            settings_revision: self.revision.load(Ordering::SeqCst) as u64,
        })
    }
    fn claim_start(
        &self,
        mut ctx: TurnContext,
    ) -> Result<(TurnContext, Arc<RuntimeOwner>), AppError> {
        let mut owner = self.owner.lock().unwrap();
        if owner.is_some() {
            return Err(AppError::new(ErrorCode::SessionBusy, "already starting"));
        }
        ctx.scope = RuntimeScope {
            session_id: ctx.session_id.clone(),
            turn_id: ctx.block_id.clone(),
            generation: self.generation.fetch_add(1, Ordering::SeqCst) as u64 + 1,
        };
        let live = Arc::new(RuntimeOwner::new(ctx.scope.clone()));
        *owner = Some(live.clone());
        Ok((ctx, live))
    }
    fn install(&self, scope: &RuntimeScope, _: Arc<dyn TurnControl>) -> bool {
        self.owner
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|o| o.scope == *scope)
    }
    fn claim_close(&self, _: &str) -> Result<Option<Arc<RuntimeOwner>>, AppError> {
        Ok(self.owner.lock().unwrap().take())
    }
    fn compare_settings(
        &self,
        _: &str,
        revision: u64,
        settings: SettingsResult,
    ) -> Result<(), AppError> {
        self.revision
            .compare_exchange(
                revision as usize,
                revision as usize + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "stale settings"))?;
        *self.model.lock().unwrap() = settings.model_id;
        Ok(())
    }
}
struct Runtime {
    control: Arc<Control>,
    started: Arc<std::sync::Barrier>,
    release: Arc<std::sync::Barrier>,
}
impl RuntimePort for Runtime {
    fn preflight(&self, _: &TurnContext) -> Result<(), AppError> {
        Ok(())
    }
    fn begin_turn(
        &self,
        ctx: TurnContext,
        sink: Arc<dyn RuntimeEventSink>,
    ) -> Result<Arc<dyn TurnControl>, AppError> {
        self.started.wait();
        self.release.wait();
        let _ = sink.publish(RuntimeEventEnvelope {
            scope: ctx.scope,
            sequence: 1,
            event: RuntimeEvent::ResumeAnchor("thread".into()),
        });
        Ok(self.control.clone())
    }
}
#[test]
fn blocked_production_start_closed_before_return_cannot_install_or_emit() {
    let state = State::new("s1");
    let effects = Arc::new(Effects::default());
    let c = control(ControlAck::Applied);
    let runtime = Runtime {
        control: c.clone(),
        started: Arc::new(std::sync::Barrier::new(2)),
        release: Arc::new(std::sync::Barrier::new(2)),
    };
    std::thread::scope(|threads| {
        threads.spawn(|| start(&state, &runtime, effects.clone(), context("s1")).unwrap());
        runtime.started.wait();
        close(&state, effects.as_ref(), "s1").unwrap();
        runtime.release.wait();
    });
    assert!(state.owner.lock().unwrap().is_none());
    assert!(effects.0.lock().unwrap().is_empty());
    assert_eq!(c.kills.load(Ordering::SeqCst), 1);
}
#[test]
fn stop_during_start_is_latched_and_delivered_once() {
    let state = State::new("s1");
    let effects = Arc::new(Effects::default());
    let c = control(ControlAck::Applied);
    let runtime = Runtime {
        control: c.clone(),
        started: Arc::new(std::sync::Barrier::new(2)),
        release: Arc::new(std::sync::Barrier::new(2)),
    };
    std::thread::scope(|threads| {
        threads.spawn(|| start(&state, &runtime, effects.clone(), context("s1")).unwrap());
        runtime.started.wait();
        interrupt(&state, "s1").unwrap();
        interrupt(&state, "s1").unwrap();
        runtime.release.wait();
    });
    assert_eq!(c.interrupts.load(Ordering::SeqCst), 1);
    assert_eq!(c.kills.load(Ordering::SeqCst), 0);
}
#[test]
fn equal_request_ids_are_scoped_and_unknown_reply_does_not_poison_future_ask() {
    let a = owner(1);
    let mut b = owner(1);
    b.scope.session_id = "s2".into();
    let ca = control(ControlAck::NotPending);
    let cb = control(ControlAck::Applied);
    install_control(&a, ca.clone());
    install_control(&b, cb.clone());
    let effects = Effects::default();
    assert!(answer_on_owner(&a, &effects, "same", &Value::Null).is_err());
    assert_eq!(ca.writes.load(Ordering::SeqCst), 0);
    *ca.ack.lock().unwrap() = ControlAck::Applied;
    answer_on_owner(&a, &effects, "same", &Value::Null).unwrap();
    answer_on_owner(&b, &effects, "same", &Value::Null).unwrap();
    assert_eq!(ca.writes.load(Ordering::SeqCst), 1);
    assert_eq!(cb.writes.load(Ordering::SeqCst), 1);
}
struct FailingRules(AtomicUsize);
impl PermissionRulePort for FailingRules {
    fn remember(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
        _: bool,
    ) -> Result<PermissionRule, AppError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(AppError::new(
            ErrorCode::SettingsWriteFailed,
            "disk failure",
        ))
    }
}
#[test]
fn rule_failure_keeps_ask_pending_and_codex_cannot_write_claude_rules() {
    let mut state = State::new("s1");
    let (_, owner) = state.claim_start(context("s1")).unwrap();
    let c = control(ControlAck::Applied);
    install_control(&owner, c.clone());
    let rules = FailingRules(AtomicUsize::new(0));
    let effects = Effects::default();
    assert_eq!(
        decide_permission(
            &state,
            &effects,
            &rules,
            "s1",
            "p",
            PermissionDecision::Allow,
            true,
            None
        )
        .unwrap_err()
        .code,
        ErrorCode::SettingsWriteFailed
    );
    assert_eq!(c.writes.load(Ordering::SeqCst), 0);
    state.runtime = AgentRuntime::Codex;
    assert_eq!(
        decide_permission(
            &state,
            &effects,
            &rules,
            "s1",
            "p",
            PermissionDecision::Allow,
            true,
            None
        )
        .unwrap_err()
        .code,
        ErrorCode::RuntimeUnsupported
    );
    assert_eq!(rules.0.load(Ordering::SeqCst), 1);
    decide_permission(
        &state,
        &effects,
        &rules,
        "s1",
        "p",
        PermissionDecision::Allow,
        false,
        None,
    )
    .unwrap();
    assert_eq!(c.writes.load(Ordering::SeqCst), 1);
}
#[test]
fn settings_completion_compares_revision_and_does_not_mutate_running_snapshot() {
    let state = State::new("s1");
    let (running, _) = state.claim_start(context("s1")).unwrap();
    let result = SettingsResult {
        model_id: "model-b".into(),
        model_label: "Model B".into(),
        context_limit: 100,
        effort: None,
    };
    accept_settings(&state, "s1", 0, result.clone()).unwrap();
    assert!(accept_settings(&state, "s1", 0, result).is_err());
    assert_eq!(*state.model.lock().unwrap(), "model-b");
    assert_eq!(running.model_id, "model-a");
}

#[test]
fn startup_failure_resolves_published_requests_before_terminal_and_fences_late_output() {
    struct FailedRuntime;
    impl RuntimePort for FailedRuntime {
        fn preflight(&self, _: &TurnContext) -> Result<(), AppError> {
            Ok(())
        }
        fn begin_turn(
            &self,
            context: TurnContext,
            sink: Arc<dyn RuntimeEventSink>,
        ) -> Result<Arc<dyn TurnControl>, AppError> {
            let _ = sink.publish(RuntimeEventEnvelope {
                scope: context.scope,
                sequence: 1,
                event: RuntimeEvent::QuestionAsked {
                    blocking: None,
                    block_id: "question".into(),
                    questions: vec![],
                },
            });
            Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "startup failed",
            ))
        }
    }
    let state = State::new("s1");
    let effects = Arc::new(Effects::default());
    start(&state, &FailedRuntime, effects.clone(), context("s1")).unwrap();
    let owner = state.snapshot("s1").unwrap().owner.unwrap();
    assert_eq!(
        apply_event(
            &owner,
            effects.as_ref(),
            event(&owner, 2, RuntimeEvent::TurnFinished)
        ),
        Ok(ApplyOutcome::Closed)
    );
    let observed = effects.0.lock().unwrap();
    assert_eq!(observed.len(), 3);
    assert!(matches!(&observed[0], RuntimeEvent::QuestionAsked { .. }));
    assert!(
        matches!(&observed[1], RuntimeEvent::RequestResolved { outcome, .. } if outcome == "cancelled")
    );
    assert!(
        matches!(&observed[2], RuntimeEvent::TurnFailed(error) if error.code == ErrorCode::RuntimeUnavailable)
    );
}

/// Review finding (07, ordered-effect race): a reply is accepted under the
/// session gate, but its projection used to wait for the owner's dispatch
/// lock only after that gate was released. Native output that follows the
/// reply could slip into that window and be projected first. The racing
/// publisher here starts at the exact end of acceptance. With the fix it is
/// held on the dispatch lock, so the bounded wait only lets the reply go on.
/// It never decides the order that gets asserted.
struct RacingState {
    state: State,
    effects: Arc<Effects>,
    racer: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl SessionStatePort for RacingState {
    fn dispatch_control(
        &self,
        scope: &RuntimeScope,
        action: &mut dyn FnMut(&RuntimeOwner) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let result = self.state.dispatch_control(scope, action);
        let live = self.state.owner.lock().unwrap().clone().unwrap();
        let effects = self.effects.clone();
        let (done_tx, done) = std::sync::mpsc::channel();
        *self.racer.lock().unwrap() = Some(std::thread::spawn(move || {
            let envelope = event(&live, 2, RuntimeEvent::TurnFinished);
            apply_event(&live, effects.as_ref(), envelope).unwrap();
            let _ = done_tx.send(());
        }));
        let _ = done.recv_timeout(std::time::Duration::from_millis(100));
        result
    }
    fn snapshot(&self, id: &str) -> Result<SessionSnapshot, AppError> {
        self.state.snapshot(id)
    }
    fn claim_start(&self, c: TurnContext) -> Result<(TurnContext, Arc<RuntimeOwner>), AppError> {
        self.state.claim_start(c)
    }
    fn install(&self, scope: &RuntimeScope, control: Arc<dyn TurnControl>) -> bool {
        self.state.install(scope, control)
    }
    fn claim_close(&self, id: &str) -> Result<Option<Arc<RuntimeOwner>>, AppError> {
        self.state.claim_close(id)
    }
    fn compare_settings(&self, id: &str, r: u64, s: SettingsResult) -> Result<(), AppError> {
        self.state.compare_settings(id, r, s)
    }
}
fn racing_reply(reply: impl FnOnce(&RacingState)) -> Vec<&'static str> {
    let racing = RacingState {
        state: State::new("s1"),
        effects: Arc::new(Effects::default()),
        racer: Mutex::new(None),
    };
    let (_, live) = racing.state.claim_start(context("s1")).unwrap();
    install_control(&live, control(ControlAck::Applied));
    reply(&racing);
    racing.racer.lock().unwrap().take().unwrap().join().unwrap();
    let names = racing
        .effects
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|event| match event {
            RuntimeEvent::QuestionAnswered { .. } | RuntimeEvent::PermissionDecided { .. } => {
                "reply"
            }
            RuntimeEvent::TurnFinished => "turn-finished",
            _ => "other",
        })
        .collect();
    names
}
#[test]
fn accepted_question_reply_is_projected_before_later_native_output() {
    let order = racing_reply(|racing| {
        answer_question(
            racing.state_port(),
            racing.effects.as_ref(),
            "s1",
            "q",
            &serde_json::json!({"a":"yes"}),
        )
        .unwrap();
    });
    assert_eq!(order, vec!["reply", "turn-finished"]);
}
#[test]
fn accepted_permission_reply_is_projected_before_later_native_output() {
    let order = racing_reply(|racing| {
        decide_permission(
            racing.state_port(),
            racing.effects.as_ref(),
            &FailingRules(AtomicUsize::new(0)),
            "s1",
            "p",
            PermissionDecision::Allow,
            false,
            None,
        )
        .unwrap();
    });
    assert_eq!(order, vec!["reply", "turn-finished"]);
}
impl RacingState {
    fn state_port(&self) -> &dyn SessionStatePort {
        self
    }
}

/// process-runtime-events FR-8 / process-runtime-boundaries FR-3: the migrated
/// Codex translation and the application layer reach no Tauri, Engine or
/// process handle. Only production code is checked; test modules may build
/// fakes.
#[test]
fn migrated_codex_translation_and_application_stay_framework_free() {
    for (name, source) in [
        ("codex runner", include_str!("../adapter/codex/runner.rs")),
        (
            "codex translate",
            include_str!("../adapter/codex/translate.rs"),
        ),
        ("application", include_str!("mod.rs")),
        ("application commands", include_str!("commands.rs")),
        ("application values", include_str!("values.rs")),
    ] {
        let source = source.replace("\r\n", "\n");
        let production = source.split("\n#[cfg(test)]\nmod tests").next().unwrap();
        for forbidden in [
            "tauri::",
            "app.state",
            "Engine",
            ".engine()",
            "std::process::",
            "runtime_bridge",
            "adapter::",
            // claude-process-adapter AC-4: no vendor wire vocabulary.
            "stream_event",
            "control_request",
            "control_response",
            "can_use_tool",
            "stream-json",
            "serverRequest",
            "jsonrpc",
        ] {
            assert!(
                !production.contains(forbidden),
                "{name} depends on {forbidden}"
            );
        }
    }
}
/// claude-process-adapter FR-4/FR-5: once the turn-end drain resolved an ask
/// `cancelled`, the card is historical — a racing reply can neither write to
/// the native channel nor produce a second resolution.
#[test]
fn a_drained_request_cannot_be_claimed_by_a_racing_reply() {
    let state = State::new("s1");
    let live = Arc::new(owner(1));
    *state.owner.lock().unwrap() = Some(live.clone());
    let c = control(ControlAck::ChannelClosed);
    install_control(&live, c.clone());
    let effects = Effects::default();
    let asks = [
        RuntimeEvent::QuestionAsked {
            block_id: "q".into(),
            questions: vec![],
            blocking: None,
        },
        RuntimeEvent::PermissionAsked {
            block_id: "p".into(),
            ask: crate::permissions::build_ask("Bash", &serde_json::json!({"command": "x"}), "/"),
        },
    ];
    let drains =
        [("q", RequestKind::Question), ("p", RequestKind::Permission)].map(|(block_id, kind)| {
            RuntimeEvent::RequestResolved {
                block_id: block_id.into(),
                kind,
                outcome: "cancelled".into(),
            }
        });
    for (sequence, effect) in asks.into_iter().chain(drains).enumerate() {
        apply_event(&live, &effects, event(&live, sequence as u64 + 1, effect)).unwrap();
    }
    let before = effects.0.lock().unwrap().len();
    assert_eq!(
        answer_question(&state, &effects, "s1", "q", &Value::Null)
            .unwrap_err()
            .code,
        ErrorCode::QuestionNotPending
    );
    assert_eq!(
        decide_permission(
            &state,
            &effects,
            &FailingRules(AtomicUsize::new(0)),
            "s1",
            "p",
            PermissionDecision::Allow,
            false,
            None,
        )
        .unwrap_err()
        .code,
        ErrorCode::PermissionNotPending
    );
    assert_eq!(c.writes.load(Ordering::SeqCst), 0);
    assert_eq!(effects.0.lock().unwrap().len(), before);
}
