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
    end_retry(env, id, &event);
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
                    // token-viewer FR-4: a settled child exiting may have
                    // folded its background tasks into the thread.
                    if s.current.take().is_some() {
                        s.context.note_turn_ended();
                    }
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
                plan: None,
            });
        }
        RuntimeEvent::ToolSnapshot { block_id, tool } => {
            let block = engine
                .with_session_mut(id, |s| {
                    let block = s
                        .block_buffer
                        .iter_mut()
                        .find(|block| block.block_id == block_id)?;
                    block.execution = serde_json::to_value(&tool).ok();
                    block.streaming = tool.status == "running";
                    Some(block.clone())
                })
                .flatten();
            if let Some(block) = block {
                env.append_transcript(id, &block);
            }
            env.emit_session(SessionEvent::ToolUpdate {
                session_id: id.clone(),
                block_id,
                tool,
            });
        }
        RuntimeEvent::ToolCompleted {
            block_id,
            meta,
            detail,
            affects_workspace,
            tone,
        } => {
            let has_detail = detail.is_some();
            if let Some(detail) = detail {
                env.append_step_detail(id, &detail);
            }
            let block = engine
                .with_session_mut(id, |s| {
                    s.buf_tool_done(&block_id, meta.clone(), has_detail, tone.clone())
                })
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
                tone,
            });
        }
        RuntimeEvent::Metrics(metrics) => {
            let context = engine
                .with_session_mut(id, |s| {
                    if let Some(window) = metrics.context_window.filter(|window| *window > 0) {
                        s.context_limit_tokens = window;
                    }
                    if let Some(used) = metrics.context_tokens {
                        s.context_used_tokens = used;
                    }
                    s.last_activity_at = now_ms();
                    let context = metrics
                        .context_tokens
                        .map(|used| (used, s.context_limit_tokens));
                    s.metrics = Some(metrics);
                    context
                })
                .flatten();
            if let Some((used_tokens, limit_tokens)) = context {
                env.emit_session(SessionEvent::ContextUsage {
                    session_id: id.clone(),
                    used_tokens,
                    limit_tokens,
                });
            }
            env.publish_meta(id);
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
                // audit C2: a costless refresh (the turn-end context figure)
                // keeps the cost accumulated so far rather than wiping it.
                let (cost_usd, cost_basis) = match (cost, s.metrics.as_ref()) {
                    (Some(cost), _) => (Some(cost), "estimated".into()),
                    (None, Some(prev)) => (prev.cost_usd, prev.cost_basis.clone()),
                    (None, None) => (None, "unknown".into()),
                };
                // audit C2: the per-model split rides with the cost it sums to.
                let by_model = s
                    .metrics
                    .as_mut()
                    .map(|prev| std::mem::take(&mut prev.by_model))
                    .unwrap_or_default();
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
                    cost_usd,
                    cost_basis,
                    measured_at: now_ms(),
                    stale: false,
                    by_model,
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
        RuntimeEvent::CostReported { thread_total_usd } => {
            // audit C2: the thread's running total REPLACES the persisted
            // figure, so held-open turns, `--resume` turns and an app restart
            // all land on the same number and nothing is double counted. The
            // max guard keeps a late/out-of-order line on the same thread from
            // shrinking it; a new thread (/clear, `apply_clear`) resets the cost
            // first. Basis 'estimated': the CLI derives it from its own pricing
            // table (contract/common.ts RuntimeMetrics doc).
            engine.with_session_mut(id, |s| {
                let now = now_ms();
                let metrics = s.metrics.get_or_insert_with(|| unmeasured(now));
                metrics.cost_usd = Some(
                    metrics
                        .cost_usd
                        .map_or(thread_total_usd, |stored| stored.max(thread_total_usd)),
                );
                metrics.cost_basis = "estimated".into();
                metrics.measured_at = now;
            });
            env.publish_meta(id);
        }
        RuntimeEvent::ModelUsageReported { models } => {
            // audit C2: each model's entry is that model's THREAD total, so a
            // report REPLACES it (same semantics as `CostReported`). A model
            // the report omits keeps its last entry; the cost max guard
            // carries over per model so a late line cannot shrink one.
            engine.with_session_mut(id, |s| {
                let now = now_ms();
                let metrics = s.metrics.get_or_insert_with(|| unmeasured(now));
                for model in models {
                    match metrics.by_model.iter_mut().find(|m| m.model == model.model) {
                        Some(stored) if stored.cost_usd > model.cost_usd => {}
                        Some(stored) => *stored = model,
                        None => metrics.by_model.push(model),
                    }
                }
                metrics.by_model.sort_by(|a, b| a.model.cmp(&b.model));
                metrics
                    .by_model
                    .truncate(crate::session::stream::MAX_USAGE_MODELS);
                metrics.measured_at = now;
            });
            env.publish_meta(id);
        }
        // audit C4: both reach the user over channels the Claude path already
        // has — `SessionEvent::RuntimeEvent` needs an envelope (`generation`,
        // ordered `sequence`) no Claude-path code produces. A retry rides on
        // `SessionMeta.retry` (cleared by `end_retry` on the next progress);
        // a completed compaction leaves a `compaction` command card — the
        // transcript divider — via the same path `/usage` cards take.
        RuntimeEvent::Retry {
            state,
            attempt,
            delay_ms,
            max_retries,
            error_status,
            error,
        } => {
            let now = now_ms();
            engine.with_session_mut(id, |s| {
                s.retry = (state != "finished").then(|| events::SessionRetry {
                    attempt,
                    max_retries,
                    error_status,
                    error,
                    retry_at: delay_ms.map(|d| now.saturating_add(d)),
                    since: now,
                });
            });
            env.publish_meta(id);
        }
        RuntimeEvent::Compaction {
            state,
            automatic,
            pre_tokens,
            boundary_id,
            ..
        } => {
            if state == "completed" {
                // Keyed on the boundary's own id where it has one: a re-emitted
                // boundary upserts its divider instead of drawing a second one.
                let block_id = boundary_id
                    .map(|b| format!("compact-{b}"))
                    .unwrap_or_else(crate::ids::uuid);
                crate::session::interactive::finalize_command_block(
                    env,
                    id,
                    &block_id,
                    "compact",
                    &crate::session::interactive::CommandCard::Compaction {
                        trigger: if automatic { "auto" } else { "manual" }.into(),
                        pre_tokens,
                    },
                );
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

/// audit C4: any event but another retry is the turn moving again (or ending),
/// so a pending retry is over — clear it and republish only if one was set.
fn end_retry(env: &dyn SessionEnv, id: &str, event: &RuntimeEvent) {
    if matches!(event, RuntimeEvent::Retry { .. }) {
        return;
    }
    let cleared = env
        .engine()
        .with_session_mut(id, |s| s.retry.take().is_some())
        .unwrap_or(false);
    if cleared {
        env.publish_meta(id);
    }
}

/// A metrics record with nothing measured yet — what a cost or per-model
/// report lands in when the session has reported no usage before it.
fn unmeasured(now: u64) -> events::RuntimeMetrics {
    events::RuntimeMetrics {
        input_tokens: None,
        output_tokens: None,
        cache_read_tokens: None,
        cache_write_tokens: None,
        context_tokens: None,
        context_window: None,
        context_basis: "unknown".into(),
        cost_usd: None,
        cost_basis: "unknown".into(),
        measured_at: now,
        stale: false,
        by_model: Vec::new(),
    }
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
