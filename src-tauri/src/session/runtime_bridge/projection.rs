//! Session projection and ordered outward effects, independently testable through SessionEnv.
use super::*;
pub(super) fn apply_to_session(
    env: &dyn SessionEnv,
    cwd: &str,
    scope: &RuntimeScope,
    event: RuntimeEvent,
    finish: impl FnOnce(RuntimeEvent) -> Option<(String, String)>,
) -> Result<Option<(String, String)>, AppError> {
    let id = &scope.session_id;
    let engine = env.engine();
    let Ok(gate) = EngineState(engine).gate(id) else {
        return Err(AppError::new(
            ErrorCode::SessionNotRunning,
            "The runtime scope is no longer active.",
        ));
    };
    let guard = gate.lock().unwrap();
    let cleanup =
        matches!(&event,RuntimeEvent::RequestResolved {outcome,..} if outcome=="cancelled");
    let current = engine
        .with_session(id, |s| {
            s.runtime_owner.as_ref().is_some_and(|o| o.scope == *scope)
                || (cleanup && s.runtime_owner.is_none() && s.next_generation == scope.generation)
        })
        .unwrap_or(false);
    if !current {
        return Err(AppError::new(
            ErrorCode::SessionNotRunning,
            "The runtime scope was replaced.",
        ));
    }
    let result = apply_projected(env, cwd, scope, event, finish);
    drop(guard);
    result
}

fn apply_projected(
    env: &dyn SessionEnv,
    cwd: &str,
    scope: &RuntimeScope,
    event: RuntimeEvent,
    finish: impl FnOnce(RuntimeEvent) -> Option<(String, String)>,
) -> Result<Option<(String, String)>, AppError> {
    let id = &scope.session_id;
    let engine = env.engine();
    let mut next = None;
    match event {
        RuntimeEvent::Capabilities(capabilities) => {
            adapter::validate_capabilities(&capabilities)?;
            engine.with_session_mut(id, |s| {
                s.runtime_generation = Some(scope.generation.to_string());
                s.effective_capabilities = Some(capabilities);
            });
            env.publish_meta(id);
        }
        RuntimeEvent::ConnectionClosed(error) => {
            let was_running = engine
                .with_session_mut(id, |s| {
                    s.effective_capabilities = None;
                    s.runtime_generation = None;
                    s.session_runtime = None;
                    s.current = None;
                    s.status == "running"
                        || s.status == "awaiting_approval"
                        || s.status == "awaiting_input"
                })
                .unwrap_or(false);
            env.publish_meta(id);
            if was_running {
                next = finish(RuntimeEvent::TurnFailed(error));
            }
        }
        RuntimeEvent::ResumeAnchor(anchor) => {
            env.commit_anchor(id, &anchor)?;
        }
        RuntimeEvent::PromptDelivered(mode) => {
            engine.with_session_mut(id, |s| s.response_mode_sent = Some(mode));
        }
        RuntimeEvent::AssistantDelta { block_id, text } => {
            env.emit_session(SessionEvent::AssistantDelta {
                session_id: id.clone(),
                block_id,
                text,
                offset: 0,
            })
        }
        RuntimeEvent::AssistantFinal { block_id, text } => {
            finalize_text_block(env, id, &block_id, text)
        }
        RuntimeEvent::ToolStarted {
            block_id,
            tool,
            summary,
        } => {
            let block = engine
                .with_session_mut(id, |s| {
                    s.buf_tool(&block_id, tool.clone(), summary.clone(), false, None);
                    s.block_buffer.last().cloned()
                })
                .flatten();
            if let Some(block) = block {
                env.append_transcript(id, &block);
            }
            env.emit_session(SessionEvent::ToolStart {
                session_id: id.clone(),
                block_id,
                tool,
                summary,
                model: None,
            });
        }
        RuntimeEvent::ToolCompleted {
            block_id,
            meta,
            detail,
            affects_workspace,
        } => {
            let has_detail = detail.is_some();
            if let Some(detail) = detail {
                env.append_step_detail(id, &detail);
            }
            let block = engine
                .with_session_mut(id, |s| s.buf_tool_done(&block_id, meta.clone(), has_detail))
                .flatten();
            if let Some(block) = block {
                env.append_transcript(id, &block);
            }
            if affects_workspace {
                env.note_file_diff(id, cwd);
            }
            env.emit_session(SessionEvent::ToolDone {
                session_id: id.clone(),
                block_id,
                meta,
                has_detail: has_detail.then_some(true),
            });
        }
        RuntimeEvent::Usage {
            context_used_tokens,
            input_tokens,
            output_tokens,
            cost,
        } => {
            let limit = engine
                .with_session(id, |s| s.context_limit_tokens)
                .unwrap_or(0);
            let used = context_used_tokens.map(|u| if limit > 0 { u.min(limit) } else { u });
            engine.with_session_mut(id, |s| {
                if let Some(used) = used {
                    s.context_used_tokens = used;
                }
                s.last_activity_at = now_ms();
                s.metrics = Some(events::RuntimeMetrics {
                    input_tokens,
                    output_tokens,
                    cache_read_tokens: None,
                    cache_write_tokens: None,
                    context_tokens: used,
                    context_window: (limit > 0).then_some(limit),
                    context_basis: if used.is_some() {
                        "reported"
                    } else {
                        "unknown"
                    }
                    .into(),
                    cost_usd: cost,
                    cost_basis: if cost.is_some() {
                        "estimated"
                    } else {
                        "unknown"
                    }
                    .into(),
                    measured_at: now_ms(),
                    stale: false,
                });
            });
            if let Some(used_tokens) = used {
                env.emit_session(SessionEvent::ContextUsage {
                    session_id: id.clone(),
                    used_tokens,
                    limit_tokens: limit,
                });
            }
        }
        RuntimeEvent::PermissionAsked { block_id, ask } => {
            let block = engine
                .with_session_mut(id, |s| {
                    s.buf_permission(&block_id, serde_json::to_value(&ask).unwrap());
                    s.block_buffer.last().cloned()
                })
                .flatten();
            if let Some(block) = block {
                env.append_transcript(id, &block);
            }
            env.emit_session(SessionEvent::PermissionAsked {
                session_id: id.clone(),
                block_id,
                ask,
            });
            refresh_parked_status(env, id);
        }
        RuntimeEvent::QuestionAsked {
            block_id,
            questions,
            blocking,
        } => {
            let block = engine
                .with_session_mut(id, |s| {
                    s.buf_question(&block_id, serde_json::to_value(&questions).unwrap());
                    if let Some(blocking) = blocking {
                        if let Some(card) = s.block_buffer.last_mut().and_then(|b| b.card.as_mut())
                        {
                            card["blocking"] = Value::Bool(blocking);
                        }
                    }
                    s.block_buffer.last().cloned()
                })
                .flatten();
            if let Some(block) = block {
                env.append_transcript(id, &block);
            }
            env.emit_session(SessionEvent::QuestionAsked {
                session_id: id.clone(),
                block_id,
                questions,
                blocking,
            });
            refresh_parked_status(env, id);
        }
        RuntimeEvent::RequestResolved {
            block_id,
            kind,
            outcome,
        } => {
            match kind {
                RequestKind::Question => resolve_question(env, id, &block_id, &outcome, None),
                RequestKind::Permission => resolve_permission(env, id, &block_id, &outcome, None),
            }
            refresh_parked_status(env, id);
        }
        RuntimeEvent::QuestionAnswered { block_id, answers } => {
            resolve_question(env, id, &block_id, "answered", Some(&answers));
            refresh_parked_status(env, id);
        }
        RuntimeEvent::PermissionDecided {
            block_id,
            outcome,
            rule,
        } => {
            resolve_permission(env, id, &block_id, &outcome, rule.as_ref());
            refresh_parked_status(env, id);
        }
        RuntimeEvent::ResumeRejected => {
            // process-session-continuity FR-5: the saved native reference is
            // invalid. Fail explicitly and keep it — never a silent fresh
            // thread, never a replay of a prompt whose fate is uncertain.
            env.emit_session(SessionEvent::ResumeFailed {
                session_id: id.clone(),
            });
            next = finish(RuntimeEvent::TurnFailed(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "The saved conversation could not be resumed. Start a new session to continue.",
            )));
        }
        terminal @ (RuntimeEvent::TurnFinished | RuntimeEvent::TurnFailed(_)) => {
            next = finish(terminal);
        }
        other => super::observations::apply(env, id, cwd, other)?,
    }
    Ok(next)
}

#[cfg(any(test, feature = "harness"))]
pub(crate) fn project_runtime_event(
    env: &dyn SessionEnv,
    session_id: &str,
    cwd: &str,
    event: RuntimeEvent,
) -> Result<(), AppError> {
    let scope = RuntimeScope {
        session_id: session_id.into(),
        ..Default::default()
    };
    apply_projected(env, cwd, &scope, event, |_| None).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testenv::TestEnv;
    use crate::session::testutil::{test_engine_with, test_session};

    /// process-session-continuity FR-5: an invalid native reference is an
    /// explicit failure — never a silent fresh thread carrying the same prompt.
    #[test]
    fn a_rejected_resume_fails_the_turn_explicitly_and_replays_nothing() {
        let mut session = test_session();
        session.claude_session_id = Some("stale-thread".into());
        let env = TestEnv {
            engine: test_engine_with(session),
            ..Default::default()
        };
        let ctx = crate::session::turn::build_turn_context(
            &env.engine,
            "s1",
            "user-block".into(),
            "hi".into(),
            TurnMode::Normal,
        )
        .unwrap();
        env.engine
            .with_session_mut("s1", |s| s.running_context = Some(ctx));
        let scope = RuntimeScope {
            session_id: "s1".into(),
            ..Default::default()
        };
        let mut terminal = None;
        let next = apply_projected(&env, "/x", &scope, RuntimeEvent::ResumeRejected, |event| {
            terminal = Some(event);
            None
        })
        .unwrap();
        assert_eq!(next, None, "the rejected prompt was queued for replay");
        let Some(RuntimeEvent::TurnFailed(error)) = terminal else {
            panic!("the rejected resume did not end the turn");
        };
        assert_eq!(error.code, ErrorCode::RuntimeUnavailable);
        assert!(error.message.contains("could not be resumed"));
        assert!(env
            .session_events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, SessionEvent::ResumeFailed { .. })));
        assert_eq!(
            env.engine
                .with_session("s1", |s| s.claude_session_id.clone())
                .flatten()
                .as_deref(),
            Some("stale-thread")
        );
    }
}
