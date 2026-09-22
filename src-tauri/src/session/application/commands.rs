use super::*;

struct ApplicationSink {
    owner: Arc<RuntimeOwner>,
    effects: Arc<dyn RuntimeEffectPort>,
}
impl RuntimeEventSink for ApplicationSink {
    fn publish(&self, envelope: RuntimeEventEnvelope) -> Result<ApplyOutcome, AppError> {
        apply_event(&self.owner, self.effects.as_ref(), envelope)
    }
}
pub(crate) fn start(
    state: &dyn SessionStatePort,
    runtime: &dyn RuntimePort,
    effects: Arc<dyn RuntimeEffectPort>,
    context: TurnContext,
) -> Result<RuntimeScope, AppError> {
    let snapshot = state.snapshot(&context.session_id)?;
    if snapshot.runtime == AgentRuntime::Pi {
        return Err(crate::ipc::retired_pi_error());
    }
    if super::super::status::is_terminal(&snapshot.status) {
        return Err(AppError::new(
            ErrorCode::SessionNotRunning,
            "session has ended",
        ));
    }
    runtime.preflight(&context)?;
    let (context, owner) = state.claim_start(context)?;
    let sink = Arc::new(ApplicationSink {
        owner: owner.clone(),
        effects: effects.clone(),
    });
    match runtime.begin_turn(context, sink) {
        Ok(control) => {
            if install_control(&owner, control.clone())
                && !state.install(&owner.scope, control.clone())
            {
                control.kill();
            }
            Ok(owner.scope.clone())
        }
        Err(error) => {
            let _dispatch = owner.dispatch.lock().unwrap();
            let mut inner = owner.inner.lock().unwrap();
            if !inner.closed {
                let outward = reduce(&mut inner, RuntimeEvent::TurnFailed(error));
                drop(inner);
                for event in outward {
                    effects.apply(&owner.scope, event)?;
                }
            }
            Ok(owner.scope.clone())
        }
    }
}
pub(crate) fn interrupt(state: &dyn SessionStatePort, session_id: &str) -> Result<(), AppError> {
    let snapshot = state.snapshot(session_id)?;
    if let Some(owner) = snapshot.owner {
        let mut inner = owner.inner.lock().unwrap();
        if !inner.closed && !inner.interrupted {
            inner.interrupted = true;
            if let Some(control) = &inner.control {
                control.interrupt();
            }
        }
    }
    Ok(())
}
pub(crate) fn close(
    state: &dyn SessionStatePort,
    effects: &dyn RuntimeEffectPort,
    session_id: &str,
) -> Result<(), AppError> {
    if let Some(owner) = state.claim_close(session_id)? {
        close_owner(&owner, effects)?;
    }
    Ok(())
}
fn not_pending(kind: RequestKind) -> AppError {
    match kind {
        RequestKind::Question => AppError::new(
            ErrorCode::QuestionNotPending,
            "that question is no longer pending",
        ),
        RequestKind::Permission => AppError::new(
            ErrorCode::PermissionNotPending,
            "that request is no longer pending",
        ),
    }
}
pub(crate) fn answer_question(
    state: &dyn SessionStatePort,
    effects: &dyn RuntimeEffectPort,
    session_id: &str,
    block_id: &str,
    answers: &Value,
) -> Result<(), AppError> {
    let owner = state
        .snapshot(session_id)?
        .owner
        .ok_or_else(|| not_pending(RequestKind::Question))?;
    let deferred = DeferredEffects::default();
    // Held from acceptance through projection (lock order dispatch -> gate, as
    // in `apply_event`): native output that follows the reply can never be
    // projected ahead of it.
    let dispatch = owner.dispatch.lock().unwrap();
    let result = state.dispatch_control(&owner.scope, &mut |live| {
        answer_on_owner(live, &deferred, block_id, answers)
    });
    deferred.publish(effects, &owner.scope)?;
    drop(dispatch);
    result.map_err(|e| {
        if e.code == ErrorCode::SessionNotRunning {
            not_pending(RequestKind::Question)
        } else {
            e
        }
    })
}
pub(crate) fn answer_on_owner(
    owner: &RuntimeOwner,
    effects: &dyn RuntimeEffectPort,
    block_id: &str,
    answers: &Value,
) -> Result<(), AppError> {
    let mut inner = owner.inner.lock().unwrap();
    let key = (RequestKind::Question, block_id.to_string());
    if inner.closed || inner.replies.contains(&key) || inner.requests.get(&key) == Some(&false) {
        return Err(not_pending(RequestKind::Question));
    }
    let control = inner
        .control
        .clone()
        .ok_or_else(|| not_pending(RequestKind::Question))?;
    inner.replies.insert(key.clone());
    match control.answer_question(block_id, answers) {
        ack @ (ControlAck::Unsupported | ControlAck::InvalidAnswer) => {
            inner.replies.remove(&key);
            Err(rejected_reply(ack))
        }
        ControlAck::NotPending => {
            inner.replies.remove(&key);
            Err(not_pending(RequestKind::Question))
        }
        ControlAck::AwaitingConfirmation => Ok(()),
        ControlAck::ChannelClosed => {
            inner.requests.insert(key, false);
            drop(inner);
            effects.apply(
                &owner.scope,
                RuntimeEvent::RequestResolved {
                    block_id: block_id.into(),
                    kind: RequestKind::Question,
                    outcome: "cancelled".into(),
                },
            )?;
            Err(not_pending(RequestKind::Question))
        }
        ControlAck::Applied => {
            inner.requests.insert(key, false);
            drop(inner);
            effects.apply(
                &owner.scope,
                RuntimeEvent::QuestionAnswered {
                    block_id: block_id.into(),
                    answers: answers.clone(),
                },
            )?;
            Ok(())
        }
    }
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn decide_permission(
    state: &dyn SessionStatePort,
    effects: &dyn RuntimeEffectPort,
    rules: &dyn PermissionRulePort,
    session_id: &str,
    block_id: &str,
    decision: PermissionDecision,
    remember: bool,
    tier: Option<&str>,
) -> Result<(), AppError> {
    let snapshot = state.snapshot(session_id)?;
    let allow = decision == PermissionDecision::Allow;
    if decision == PermissionDecision::Cancel
        && (snapshot.runtime != AgentRuntime::Codex || remember)
    {
        return Err(AppError::new(
            ErrorCode::RuntimeUnsupported,
            "This runtime cannot cancel a turn through a permission decision.",
        ));
    }
    if remember && snapshot.runtime != AgentRuntime::ClaudeCode {
        return Err(AppError::new(
            ErrorCode::RuntimeUnsupported,
            "this runtime cannot persist Claude permission rules",
        ));
    }
    let owner = snapshot
        .owner
        .ok_or_else(|| not_pending(RequestKind::Permission))?;
    let deferred = DeferredEffects::default();
    let dispatch = owner.dispatch.lock().unwrap(); // ordered as in `answer_question`
    let result = state.dispatch_control(&owner.scope, &mut |owner| {
        let mut inner = owner.inner.lock().unwrap();
        let key = (RequestKind::Permission, block_id.to_string());
        // A request the owner already resolved (e.g. cancelled by the turn-end
        // drain) is historical: it can never claim the native channel.
        if inner.closed || inner.replies.contains(&key) || inner.requests.get(&key) == Some(&false)
        {
            return Err(not_pending(RequestKind::Permission));
        }
        let control = inner
            .control
            .clone()
            .ok_or_else(|| not_pending(RequestKind::Permission))?;
        let rule = if remember {
            let pattern = control
                .pending_permission_pattern(block_id)
                .ok_or_else(|| not_pending(RequestKind::Permission))?;
            Some(rules.remember(session_id, &pattern, tier, allow)?)
        } else {
            None
        };
        inner.replies.insert(key.clone());
        match control.decide_permission(block_id, decision) {
            ack @ (ControlAck::Unsupported | ControlAck::InvalidAnswer) => {
                inner.replies.remove(&key);
                Err(rejected_reply(ack))
            }
            ControlAck::NotPending => {
                inner.replies.remove(&key);
                Err(not_pending(RequestKind::Permission))
            }
            ControlAck::AwaitingConfirmation => Ok(()),
            ack => {
                inner.requests.insert(key, false);
                drop(inner);
                let outcome =
                    if ack == ControlAck::ChannelClosed || decision == PermissionDecision::Cancel {
                        "cancelled"
                    } else if allow {
                        "allowed"
                    } else {
                        "denied"
                    };
                deferred.apply(
                    &owner.scope,
                    RuntimeEvent::PermissionDecided {
                        block_id: block_id.into(),
                        outcome: outcome.into(),
                        rule,
                    },
                )?;
                if ack == ControlAck::ChannelClosed {
                    Err(not_pending(RequestKind::Permission))
                } else {
                    Ok(())
                }
            }
        }
    });
    deferred.publish(effects, &owner.scope)?;
    drop(dispatch);
    result.map_err(|e| {
        if e.code == ErrorCode::SessionNotRunning {
            not_pending(RequestKind::Permission)
        } else {
            e
        }
    })
}
fn rejected_reply(ack: ControlAck) -> AppError {
    if ack == ControlAck::Unsupported {
        AppError::new(
            ErrorCode::RuntimeUnsupported,
            "That choice is not offered by this native request.",
        )
    } else {
        AppError::new(
            ErrorCode::InvalidInput,
            "The answer does not match this native request.",
        )
    }
}

pub(crate) fn accept_settings(
    state: &dyn SessionStatePort,
    session_id: &str,
    revision: u64,
    settings: SettingsResult,
) -> Result<(), AppError> {
    let snapshot = state.snapshot(session_id)?;
    if snapshot.settings_revision != revision {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Session changed while loading models. Please retry.",
        ));
    }
    state.compare_settings(session_id, revision, settings)
}

#[derive(Default)]
struct DeferredEffects(Mutex<Vec<RuntimeEvent>>);
impl RuntimeEffectPort for DeferredEffects {
    fn apply(&self, _: &RuntimeScope, event: RuntimeEvent) -> Result<(), AppError> {
        self.0.lock().unwrap().push(event);
        Ok(())
    }
}
impl DeferredEffects {
    fn publish(self, target: &dyn RuntimeEffectPort, scope: &RuntimeScope) -> Result<(), AppError> {
        for effect in self.0.into_inner().unwrap() {
            target.apply(scope, effect)?;
        }
        Ok(())
    }
}
