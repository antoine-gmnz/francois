//! turn lifecycle: build a `TurnContext`, route it through the session's
//! `SessionAdapter` (multi-provider-seam FR-1), and handle completion/failure.
//! The argv/spawn/stdio-control-channel plumbing lives behind that seam now —
//! see `session/adapter/claude_code.rs`.

use super::*;
use crate::ipc::ErrorCode;

use crate::ipc::AppError;
use tauri::{AppHandle, Manager};

// ---------- turn execution ----------

/// Emit message.user, then spawn the turn's claude child + reader thread.
/// Detects a rejected `--resume`: the turn used resume but exited before starting a
/// thread (no system/init, no result) and wasn't interrupted (FR-8). The turn then
/// fails explicitly with its anchor kept — never retried fresh
/// (process-session-continuity FR-5).
pub fn is_resume_fail(
    resume_used: bool,
    got_init: bool,
    got_result: bool,
    was_interrupted: bool,
) -> bool {
    resume_used && !got_init && !got_result && !was_interrupted
}

/// Build a session's `TurnContext` snapshot: everything `begin_turn` reads
/// off it, under `Engine.sessions`, released immediately after. `None` ⇔ the
/// session no longer exists.
pub(crate) fn build_turn_context(
    engine: &Engine,
    session_id: &str,
    block_id: String,
    text: String,
    mode: TurnMode,
) -> Option<TurnContext> {
    engine.with_session_mut(session_id, |s| {
        let resume = s.claude_session_id.clone();
        TurnContext {
            scope: Default::default(),
            execution: Default::default(),
            session_id: session_id.to_string(),
            block_id,
            text,
            mode,
            cwd: s.cwd.clone(),
            model_id: s.model_id.clone(),
            effort: s.effort.clone(),
            permission_mode: s.permission_mode.clone(),
            runtime: s.runtime.clone(),
            worktree_distro: s.worktree_distro.clone(),
            account_id: s.account_id.clone(),
            allow_git: s.allow_git,
            resume,
            // session-profiles FR-13: both ride EVERY turn of this session,
            // snapshotted at creation — never re-read from the profile.
            system_prompt: s.system_prompt.clone(),
            extra_args: s.extra_args.clone(),
            // response-mode FR-5: snapshotted at spawn like everything else
            // here — a switch mid-turn cannot reach the running turn (FR-4).
            response_mode: s.response_mode,
        }
    })
}

/// multi-provider-seam FR-1/FR-14a: snapshot the session into a `TurnContext`,
/// route it through `adapter_for(session.agent_runtime)` (preflight, then
/// spawn/connect), and store the returned `TurnControl` on `Session.current`.
/// Runtime-shaped behaviour (argv, env, the control-channel protocol, …)
/// lives entirely behind that seam now — this function is the same for
/// every runtime.
pub fn begin_turn(
    app: &AppHandle,
    session_id: &str,
    block_id: String,
    text: String,
    mode: TurnMode,
) {
    let engine = app.state::<Engine>();
    if engine.ensure_available(session_id).is_err() {
        return;
    }
    // FR-4: the runtime that decides which CLI spawns is DERIVED from the
    // session's account kind, never read from the stored (and now
    // non-authoritative) `Session.agent_runtime` field — that field can
    // desync from the account when the account is removed (edge case #4).
    let account_id = engine
        .with_session(session_id, |s| s.account_id.clone())
        .unwrap_or_default();
    if let Err(error) = runtime_bridge::require_account(app, &account_id) {
        fail_session_error(app, session_id, error);
        return;
    }
    if let Some(Err((code, msg))) =
        engine.with_session(session_id, |s| s.validate_attachment_submission(&text))
    {
        fail_session(app, session_id, code, msg);
        return;
    }
    // pi-runtime-boundary FR-1/FR-8: no account kind maps to Pi, so a Pi
    // session dispatches on its stored runtime (and fails as unavailable).
    let (agent_runtime, _protocol) =
        if engine.with_session(session_id, |s| s.agent_runtime) == Some(AgentRuntime::Pi) {
            (AgentRuntime::Pi, ProviderProtocol::Pi)
        } else {
            AgentRuntime::from_account_kind(crate::account::kind_of(app, &account_id))
        };
    let adapter = adapter_for(agent_runtime);
    let Some(ctx) = build_turn_context(&engine, session_id, block_id, text, mode) else {
        return;
    };

    if let Err(e) = adapter.preflight(app, &ctx) {
        fail_session_error(app, session_id, e);
        return;
    }

    if ctx.mode == TurnMode::Normal {
        let block = engine
            .with_session_mut(session_id, |s| {
                s.buf_user(&ctx.block_id, ctx.text.clone());
                s.last_activity_at = now_ms();
                s.block_buffer.last().cloned()
            })
            .flatten();
        if let Some(b) = &block {
            append_transcript(app, session_id, b); // durable-sessions FR-2
        }
        emit(
            app,
            SessionEvent::MessageUser {
                session_id: session_id.into(),
                block_id: ctx.block_id.clone(),
                text: ctx.text.clone(),
            },
        );
    }

    if let Err(error) = runtime_bridge::start_runtime(app, agent_runtime, ctx) {
        fail_session_error(app, session_id, error);
    }
}

/// `starting` → `running`: the stream produced its `system/init`, so the turn is
/// really under way. Idempotent and narrow — it ONLY promotes from `starting`, so
/// a turn already parked on an approval when a later init arrives is never
/// dragged back to `running`.
pub fn mark_stream_live(env: &dyn SessionEnv, session_id: &str) {
    let promoted = env
        .engine()
        .with_session_mut(session_id, |s| {
            if s.status != status::STARTING {
                return false;
            }
            s.status = status::RUNNING.into();
            true
        })
        .unwrap_or(false);
    if promoted {
        env.emit_session(SessionEvent::Status {
            session_id: session_id.into(),
            status: status::RUNNING.into(),
        });
    }
}

/// Recompute the session's parked status from the turn's pending maps and publish
/// it if it moved.
///
/// The `awaiting_*` states are DERIVED, never latched: this is called after every
/// park and every user decision, and it always reads the maps rather than
/// tracking a counter, so a cancelled ask, a lost claim race, or two asks parked
/// at once can never strand a session looking blocked when it is not.
///
/// Deliberately NOT called from the turn-end drains — a turn tearing down settles
/// on idle/error via `finish_turn`, and a refresh there would flash `running`
/// between the last resolution and the terminal status.
pub fn refresh_parked_status(env: &dyn SessionEnv, session_id: &str) {
    let engine = env.engine();
    // Phase 1: snapshot the turn handle and RELEASE the sessions lock — the
    // same discipline decisions.rs follows, so a control-channel write can
    // never stall a command. multi-provider-seam FR-9: derived purely from
    // `TurnControl::pending_counts()`, so this never knows which adapter it
    // is talking to.
    let Some((control, owner)) =
        engine.with_session(session_id, |s| (s.current.clone(), s.runtime_owner.clone()))
    else {
        return;
    };
    let counts = if let Some(control) = control {
        control.pending_counts()
    } else if let Some(owner) = owner {
        owner.pending_counts()
    } else {
        return;
    };
    let PendingCounts {
        questions: n_questions,
        permissions: n_permissions,
    } = counts;

    // Phase 2: `next_parked_status` owns the decision — see
    // session/status.rs, where it is unit-tested.
    let applied = engine
        .with_session_mut(session_id, |s| {
            let next = status::next_parked_status(&s.status, n_permissions, n_questions)?;
            s.status = next.into();
            s.last_activity_at = now_ms();
            Some(next)
        })
        .flatten();
    if let Some(next) = applied {
        env.emit_session(SessionEvent::Status {
            session_id: session_id.into(),
            status: next.into(),
        });
    }
}

/// Route turn completion (FR-20): drain the queue or go idle; or mark error —
/// except for a transient (usage-limit) failure, which fails the turn but leaves
/// the session idle and usable (see `end_status` below).
pub fn finish_turn(app: &AppHandle, session_id: &str, errored: bool, error_msg: Option<String>) {
    runtime_bridge::finish_legacy(app, session_id);
    if let Some((block, text)) = finish_turn_effect(app, session_id, errored, error_msg) {
        begin_turn(app, session_id, block, text, TurnMode::Normal);
    }
}

pub(crate) fn finish_turn_effect(
    app: &AppHandle,
    session_id: &str,
    errored: bool,
    error_msg: Option<String>,
) -> Option<(String, String)> {
    finish_turn_with_error(app, session_id, errored, error_msg, None)
}
pub(crate) fn finish_turn_failure(
    app: &AppHandle,
    session_id: &str,
    error: AppError,
) -> Option<(String, String)> {
    finish_turn_with_error(
        app,
        session_id,
        true,
        Some(error.message.clone()),
        Some(error),
    )
}
fn finish_turn_with_error(
    app: &AppHandle,
    session_id: &str,
    errored: bool,
    error_msg: Option<String>,
    original_error: Option<AppError>,
) -> Option<(String, String)> {
    let engine = app.state::<Engine>();
    // A usage/rate-limit failure is TRANSIENT (status::is_transient_failure): the
    // plan window rolls over on its own and NOTHING is emitted at that moment, so
    // a session left on the terminal `error` status would stay dead — composer
    // disabled, placeholder still quoting the limit — long after the limit
    // cleared. The turn fails, the session goes back to `idle`, and the next
    // message just works.
    let transient = errored
        && error_msg
            .as_deref()
            .is_some_and(status::is_transient_failure);
    let end_status = if transient {
        status::IDLE
    } else {
        status::ERROR
    };
    // async-agents FR-16: every agent of this session still `running` is finalized
    // at turn end — 'error' when the turn errored (session-engine FR-40), else
    // 'done' — with endedAt and an `ended with the turn` notice step. This is the
    // backstop that keeps the elapsed clock correct when FR-13's notice never came.
    // workflow-panel FR-9: the same backstop for `Workflow` runs — no run of a
    // finished turn is left `running` with a ticking clock.
    let result: Option<(
        Option<(String, String)>,
        Vec<AgentEmission>,
        Vec<WorkflowRun>,
    )> = engine.with_session_mut(session_id, |s| {
        s.current = None;
        let at = now_ms();
        let agent_ems = finalize_agents(s, errored, at);
        let workflow_runs = finalize_workflows(s, errored, at);
        let next = if errored {
            s.status = end_status.into();
            // Only a session that actually died carries the message: a transient
            // failure leaves an idle, healthy session, and a stored message would
            // outlive the limit it describes (every reader gates on
            // `status == error`, so it would also be unreachable).
            s.error_message = if transient { None } else { error_msg.clone() };
            s.queue.clear();
            None
        } else if let Some(entry) = s.queue.pop_front() {
            Some(entry)
        } else {
            s.status = "idle".into();
            None
        };
        (next, agent_ems, workflow_runs)
    });
    let (next, agent_ems, workflow_runs) = result?;
    // Emitted BEFORE the turn's terminal session.status (FR-16), with no lock held.
    emit_agent_emissions(app, session_id, agent_ems);
    emit_workflow_updates(app, workflow_runs);

    // Persist updated usage/activity/thread-id at turn boundary (durable-sessions FR-3).
    persist(app, &engine);

    // usage-bar FR-13: this session just left `running` (idle or error), so plan
    // usage moved — schedule the debounced app-scoped probe. Called with NO engine
    // lock held; usage state is a leaf that never reaches back into the engine.
    // multi-account FR-29: the post-turn probe targets THIS session's account,
    // and only it.
    if errored || next.is_none() {
        if let Some(account_id) = engine.account_of(session_id) {
            crate::usage::note_turn_ended(app, &account_id);
        }
    }

    if errored {
        let msg = error_msg.unwrap_or_else(|| "session error".into());
        // multi-account FR-23: a turn that died on a credential failure flags its
        // account, so the Accounts modal offers `Re-login` on that row. Done with
        // no engine lock held — account state is a leaf (multi-account §6).
        if crate::account::is_credential_failure(&msg) {
            if let Some(account_id) = engine.account_of(session_id) {
                crate::account::mark_auth_failed(app, &account_id);
            }
        }
        // (The agent.update for every agent just errored was emitted above by the
        // FR-16 finalization — one update per agent, carrying its notice step.)
        // The code is how the frontend tells the two apart: `USAGE_LIMIT` is a
        // dismissible notice over a live session, `INTERNAL` a dead one.
        emit(
            app,
            SessionEvent::Error {
                session_id: session_id.into(),
                error: original_error.unwrap_or(AppError {
                    code: if transient {
                        ErrorCode::UsageLimit
                    } else {
                        ErrorCode::Internal
                    },
                    message: msg,
                    detail: None,

                    runtime_failure: None,
                }),
            },
        );
        emit(
            app,
            SessionEvent::Status {
                session_id: session_id.into(),
                status: end_status.into(),
            },
        );
        return None;
    }

    if next.is_none() {
        emit(
            app,
            SessionEvent::Status {
                session_id: session_id.into(),
                status: "idle".into(),
            },
        );
    }
    next
}

/// Pure state transition shared by `fail_session`: marks the session errored
/// and finalizes (async-agents FR-16) any agent still `running` — a session
/// error is a legitimate `endedAt` setter (FR-7), so a card never keeps
/// ticking against a dead session. Returns the emissions the caller must send
/// BEFORE the terminal `session.status` / `session.error` (FR-16 ordering).
/// workflow-panel FR-9 rides along: a dead session closes its `Workflow` runs
/// for the same reason it closes its agents.
pub fn apply_fail_session(
    s: &mut Session,
    msg: &str,
    at: u64,
) -> (Vec<AgentEmission>, Vec<WorkflowRun>) {
    s.status = "error".into();
    s.error_message = Some(msg.to_string());
    s.current = None;
    s.queue.clear();
    (
        finalize_agents(s, true, at),
        finalize_workflows(s, true, at),
    )
}

pub fn fail_session(app: &AppHandle, session_id: &str, code: ErrorCode, msg: &str) {
    fail_session_error(app, session_id, AppError::new(code, msg));
}

/// pi-runtime-boundary FR-6: settles the session carrying the full `AppError`,
/// so a `runtimeFailure` survives onto `session.error`.
pub(crate) fn fail_session_error(app: &AppHandle, session_id: &str, error: AppError) {
    let engine = app.state::<Engine>();
    let (agent_ems, workflow_runs) = engine
        .with_session_mut(session_id, |s| {
            apply_fail_session(s, &error.message, now_ms())
        })
        .unwrap_or_default();
    // usage-bar FR-13: running → error. multi-account FR-29: that session's
    // account only.
    if let Some(account_id) = engine.account_of(session_id) {
        crate::usage::note_turn_ended(app, &account_id);
    }

    // async-agents FR-16 ordering rule: agent finalization is emitted BEFORE the
    // turn's terminal session.error / session.status (mirrors finish_turn).
    emit_agent_emissions(app, session_id, agent_ems);
    emit_workflow_updates(app, workflow_runs);
    emit(
        app,
        SessionEvent::Error {
            session_id: session_id.into(),
            error,
        },
    );
    emit(
        app,
        SessionEvent::Status {
            session_id: session_id.into(),
            status: "error".into(),
        },
    );
}

pub fn update_used(app: &AppHandle, session_id: &str, used: u64) {
    app.state::<Engine>().with_session_mut(session_id, |s| {
        s.context_used_tokens = used;
        s.last_activity_at = now_ms();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::session::testenv::TestEnv;
    use crate::session::testutil::{test_engine_with, test_session, FakeTurnControl};

    /// multi-provider-seam FR-9: `refresh_parked_status` reads
    /// `TurnControl::pending_counts()` and NOTHING else about the turn — driven
    /// here by a control that is not the Claude one, which is the whole proof
    /// that the engine no longer knows which adapter it is talking to.
    fn parked(status: &str, permissions: usize, questions: usize) -> (TestEnv, Option<String>) {
        let mut session = test_session();
        session.status = status.into();
        session.current = Some(FakeTurnControl::new(questions, permissions));
        let env = TestEnv {
            engine: test_engine_with(session),
            ..Default::default()
        };
        refresh_parked_status(&env, "s1");
        let emitted = env
            .session_events
            .lock()
            .unwrap()
            .iter()
            .find_map(|ev| match ev {
                SessionEvent::Status { status, .. } => Some(status.clone()),
                _ => None,
            });
        (env, emitted)
    }

    #[test]
    fn parked_status_is_derived_from_a_non_claude_turn_controls_pending_counts() {
        // An approval outranks a question (existing precedence, unchanged).
        let (env, emitted) = parked(status::RUNNING, 1, 1);
        assert_eq!(emitted.as_deref(), Some(status::AWAITING_APPROVAL));
        assert_eq!(
            env.engine
                .with_session("s1", |s| s.status.clone())
                .as_deref(),
            Some(status::AWAITING_APPROVAL)
        );

        // Only a question pending ⇒ awaiting_input.
        let (_, emitted) = parked(status::RUNNING, 0, 1);
        assert_eq!(emitted.as_deref(), Some(status::AWAITING_INPUT));

        // Nothing pending ⇒ never latched: straight back to running.
        let (_, emitted) = parked(status::AWAITING_APPROVAL, 0, 0);
        assert_eq!(emitted.as_deref(), Some(status::RUNNING));

        // Already correct ⇒ no redundant event.
        let (_, emitted) = parked(status::AWAITING_INPUT, 0, 1);
        assert_eq!(emitted, None);

        // A session that is no longer busy owns its terminal status.
        let (env, emitted) = parked(status::ERROR, 1, 0);
        assert_eq!(emitted, None);
        assert_eq!(
            env.engine
                .with_session("s1", |s| s.status.clone())
                .as_deref(),
            Some(status::ERROR)
        );
    }

    #[test]
    fn parked_status_refresh_is_a_no_op_with_no_turn_in_flight() {
        let mut session = test_session();
        session.status = status::RUNNING.into();
        session.current = None; // turn over — nothing to be parked on
        let env = TestEnv {
            engine: test_engine_with(session),
            ..Default::default()
        };
        refresh_parked_status(&env, "s1");
        assert!(env.session_events.lock().unwrap().is_empty());
        assert_eq!(
            env.engine
                .with_session("s1", |s| s.status.clone())
                .as_deref(),
            Some(status::RUNNING)
        );
    }

    // ---------- session-permission-mode ----------

    #[test]
    fn a_mode_switch_reaches_the_next_turn_context_but_not_one_already_snapshotted() {
        // FR-5: the switched mode is picked up by the NEXT `build_turn_context`
        // call — the only place every runtime family (claude-code, codex, grok,
        // the Francois loop) reads `permission_mode` off the session, since none
        // of them re-read the session mid-turn (adapter/mod.rs's `TurnContext`
        // doc, session/adapter/openai/runner.rs's owned-value destructure).
        // `permission_args` (session/spawn.rs) is the exact fragment
        // `claude_code::turn_args` extends its argv with, so asserting its
        // output changed is the claude-code family's "built argv reflects the
        // switch" proof (FR-5's acceptance bullet) without reaching into that
        // module's private `turn_args`.
        let engine = test_engine_with(test_session()); // starts "default"

        // A turn already in flight snapshotted BEFORE the switch...
        let ctx_before =
            build_turn_context(&engine, "s1", "b1".into(), "hi".into(), TurnMode::Normal).unwrap();
        assert_eq!(ctx_before.permission_mode, "default");
        assert!(permission_args(&ctx_before.permission_mode).is_empty());

        // FR-1: switch takes effect on the session immediately...
        let meta = switch_permission_mode_in_engine(
            &engine,
            &crate::session::testutil::fake_accounts(),
            "s1",
            "bypassPermissions",
        )
        .unwrap();
        assert_eq!(meta.permission_mode, "bypassPermissions");

        // FR-6: ...but the already-built snapshot is an owned value — it never
        // changes underneath the in-flight turn.
        assert_eq!(ctx_before.permission_mode, "default");

        // FR-5: the NEXT turn's snapshot picks the new mode up.
        let ctx_after = build_turn_context(
            &engine,
            "s1",
            "b2".into(),
            "hi again".into(),
            TurnMode::Normal,
        )
        .unwrap();
        assert_eq!(ctx_after.permission_mode, "bypassPermissions");
        assert_eq!(
            permission_args(&ctx_after.permission_mode),
            vec![
                "--permission-mode".to_string(),
                "bypassPermissions".to_string()
            ]
        );
    }

    #[test]
    fn resume_fail_predicate_truth_table() {
        // fires only for a resumed turn that never started a thread and wasn't interrupted
        assert!(is_resume_fail(true, false, false, false));
        assert!(!is_resume_fail(false, false, false, false)); // not resumed → ordinary early error
        assert!(!is_resume_fail(true, true, false, false)); // saw init → thread started
        assert!(!is_resume_fail(true, false, true, false)); // produced a result → turn ran
        assert!(!is_resume_fail(true, false, false, true)); // user interrupted → no retry
    }

    #[test]
    fn fail_session_finalizes_running_agents_before_terminal_status() {
        // Finding 1 / async-agents FR-16 & FR-7: a session error is a legitimate
        // endedAt setter — no agent is left running (and therefore ticking)
        // against a dead session, and the returned emissions (sent BEFORE the
        // terminal session.error/session.status) already carry the finalized
        // agent's Step-then-Update pair.
        use crate::session::testutil::*;

        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_1", true);
        mint_workflow(&mut s, "s1", "w1", "toolu_2", 1_000);
        let (ems, runs) = apply_fail_session(&mut s, "spawn crashed", 9_000);

        // workflow-panel FR-9: the session's runs close for the same reason.
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "error");
        assert_eq!(runs[0].ended_at, Some(9_000));

        assert_eq!(s.status, "error");
        assert_eq!(s.error_message.as_deref(), Some("spawn crashed"));

        let a = s.agents.get("a1").unwrap();
        assert_eq!(a.status, "error");
        assert_eq!(a.ended_at, Some(9_000));
        assert_eq!(a.last_activity.as_deref(), Some("ended with the turn"));

        // ordering: the notice step precedes the agent.update that carries it —
        // both must land before fail_session's own SessionEvent::Error/Status.
        // (agent-tab FR-4 puts the notice's transcript block between the two.)
        assert_eq!(ems.len(), 3);
        assert!(matches!(ems[0], AgentEmission::Step { .. }));
        assert!(matches!(ems[1], AgentEmission::Block { .. }));
        assert!(matches!(ems[2], AgentEmission::Update { .. }));
    }
}
