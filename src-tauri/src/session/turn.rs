//! turn lifecycle: build a `TurnContext`, route it through the session's
//! `SessionAdapter` (multi-provider-seam FR-1), and handle completion/failure.
//! The argv/spawn/stdio-control-channel plumbing lives behind that seam now —
//! see `session/adapter/claude_code.rs`.

use super::*;

use crate::ipc::AppError;
use serde_json::Value;
use tauri::{AppHandle, Manager};

// ---------- turn execution ----------

/// Input-side tokens of ONE API request: every token the model had to read
/// (fresh prompt + freshly cached + cache hits). `cache_creation_input_tokens`
/// counts too — those tokens are in the request, they were merely written to
/// the cache on the way in.
fn input_side(usage: &Value) -> u64 {
    let g = |k: &str| usage.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    g("input_tokens") + g("cache_creation_input_tokens") + g("cache_read_input_tokens")
}

fn output_side(usage: &Value) -> u64 {
    usage
        .get("output_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
}

/// Context size of ONE API request = what it read + what it produced.
pub(crate) fn compute_used(usage: &Value) -> u64 {
    input_side(usage) + output_side(usage)
}

/// Tracks how full the context window is over a turn.
///
/// The context after a turn is the size of the turn's **last** API request, not
/// the sum over its requests. A turn makes one request per tool round-trip and
/// each one re-reads the whole conversation, so summing them (which is exactly
/// what the CLI's terminal `result.usage` reports — a cost aggregate, subagent
/// requests included) drifts far past the window: a 20-round turn at 100K of
/// cache reads "uses" 2M of a 200K window. So: take the per-request usage the
/// stream carries and let the newest one win.
#[derive(Default)]
pub(crate) struct ContextTracker {
    /// Input side of the request currently streaming, from its `message_start`.
    input: u64,
    /// Newest complete per-request figure — the context as of now.
    pending: Option<u64>,
}

impl ContextTracker {
    /// Feed the inner `event` object of one parent-turn `stream_event` line.
    /// Subagent lines are routed away before this (async-agents FR-8), which is
    /// what keeps a subagent's own window out of the parent's figure.
    pub(crate) fn observe_stream_event(&mut self, ev: &Value) {
        match ev.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            // Opens a request: carries the full input side, output still ~0.
            "message_start" => {
                if let Some(u) = ev.get("message").and_then(|m| m.get("usage")) {
                    self.input = input_side(u);
                }
            }
            // Closes it: carries the final output count for that message, and on
            // newer API versions the input side again — prefer it when present,
            // fall back to what `message_start` recorded.
            "message_delta" => {
                if let Some(u) = ev.get("usage") {
                    let input = match input_side(u) {
                        0 => self.input,
                        n => n,
                    };
                    self.pending = Some(input + output_side(u));
                }
            }
            _ => {}
        }
    }

    /// The terminal `result.usage`. It is a turn-wide aggregate, so it is only
    /// trustworthy when the turn streamed no message at all (one request, or
    /// none) — otherwise it would undo everything the stream told us.
    pub(crate) fn observe_result(&mut self, usage: &Value) {
        if self.pending.is_none() {
            self.pending = Some(compute_used(usage));
        }
    }

    /// The figure to report, clamped to the window: a context can never hold
    /// more than it can hold, so a larger number is noise, not information.
    pub(crate) fn finish(&self, limit: u64) -> Option<u64> {
        self.pending
            .map(|u| if limit > 0 { u.min(limit) } else { u })
    }
}

/// Emit message.user, then spawn the turn's claude child + reader thread.
/// Detects a rejected `--resume`: the turn used resume but exited before starting a
/// thread (no system/init, no result) and wasn't interrupted (FR-8). The retry runs
/// with resume forced off, so it can never re-trigger this — at most one retry.
pub(crate) fn is_resume_fail(
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
fn build_turn_context(
    engine: &Engine,
    session_id: &str,
    block_id: String,
    text: String,
    mode: TurnMode,
) -> Option<TurnContext> {
    engine.with_session_mut(session_id, |s| {
        // ResumeRetry forces resume off regardless of the stored id, so a
        // still-good id is never dropped preemptively — a fresh init
        // overwrites it only on success.
        let resume = if mode == TurnMode::ResumeRetry {
            None
        } else {
            s.claude_session_id.clone()
        };
        TurnContext {
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
        }
    })
}

/// multi-provider-seam FR-1: snapshot the session into a `TurnContext`, route
/// it through `adapter_for(session.provider)` (preflight, then spawn/connect),
/// and store the returned `TurnControl` on `Session.current`. Provider-shaped
/// behaviour (argv, env, the control-channel protocol, …) lives entirely
/// behind that seam now — this function is the same for every provider.
pub(crate) fn begin_turn(
    app: &AppHandle,
    session_id: &str,
    block_id: String,
    text: String,
    mode: TurnMode,
) {
    let engine = app.state::<Engine>();
    let provider = engine
        .with_session(session_id, |s| s.provider)
        .unwrap_or_default();
    let adapter = adapter_for(provider);
    let Some(ctx) = build_turn_context(&engine, session_id, block_id, text, mode) else {
        return;
    };

    if let Err(e) = adapter.preflight(app, &ctx) {
        fail_session(app, session_id, &e.code, &e.message);
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

    match adapter.begin_turn(app, ctx) {
        Ok(control) => {
            engine.with_session_mut(session_id, |s| {
                s.current = Some(control);
            });
        }
        Err(e) => fail_session(app, session_id, &e.code, &e.message),
    }
}

/// `starting` → `running`: the stream produced its `system/init`, so the turn is
/// really under way. Idempotent and narrow — it ONLY promotes from `starting`, so
/// a turn already parked on an approval when a later init arrives is never
/// dragged back to `running`.
pub(crate) fn mark_stream_live(env: &dyn SessionEnv, session_id: &str) {
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
pub(crate) fn refresh_parked_status(env: &dyn SessionEnv, session_id: &str) {
    let engine = env.engine();
    // Phase 1: snapshot the turn handle and RELEASE the sessions lock — the
    // same discipline decisions.rs follows, so a control-channel write can
    // never stall a command. multi-provider-seam FR-9: derived purely from
    // `TurnControl::pending_counts()`, so this never knows which adapter it
    // is talking to.
    let control = engine
        .with_session(session_id, |s| s.current.clone())
        .flatten();
    let Some(control) = control else {
        return; // no turn in flight ⇒ nothing to be parked on
    };
    let PendingCounts {
        questions: n_questions,
        permissions: n_permissions,
    } = control.pending_counts();

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
pub(crate) fn finish_turn(
    app: &AppHandle,
    session_id: &str,
    errored: bool,
    error_msg: Option<String>,
) {
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
    let Some((next, agent_ems, workflow_runs)) = result else {
        return;
    };
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
                error: AppError {
                    code: if transient { "USAGE_LIMIT" } else { "INTERNAL" }.into(),
                    message: msg,
                    detail: None,
                },
            },
        );
        emit(
            app,
            SessionEvent::Status {
                session_id: session_id.into(),
                status: end_status.into(),
            },
        );
        return;
    }

    match next {
        Some((block_id, text)) => begin_turn(app, session_id, block_id, text, TurnMode::Normal), // no idle blip (FR-20)
        None => emit(
            app,
            SessionEvent::Status {
                session_id: session_id.into(),
                status: "idle".into(),
            },
        ),
    }
}

/// Pure state transition shared by `fail_session`: marks the session errored
/// and finalizes (async-agents FR-16) any agent still `running` — a session
/// error is a legitimate `endedAt` setter (FR-7), so a card never keeps
/// ticking against a dead session. Returns the emissions the caller must send
/// BEFORE the terminal `session.status` / `session.error` (FR-16 ordering).
/// workflow-panel FR-9 rides along: a dead session closes its `Workflow` runs
/// for the same reason it closes its agents.
pub(crate) fn apply_fail_session(
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

pub(crate) fn fail_session(app: &AppHandle, session_id: &str, code: &str, msg: &str) {
    let engine = app.state::<Engine>();
    let (agent_ems, workflow_runs) = engine
        .with_session_mut(session_id, |s| apply_fail_session(s, msg, now_ms()))
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
            error: AppError {
                code: code.into(),
                message: msg.into(),
                detail: None,
            },
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

pub(crate) fn update_used(app: &AppHandle, session_id: &str, used: u64) {
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
    use serde_json::json;

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
    fn compute_used_sums_every_input_side_bucket_plus_output() {
        let u =
            json!({ "input_tokens": 10, "cache_read_input_tokens": 21213, "output_tokens": 47 });
        assert_eq!(compute_used(&u), 21270);
        // cache CREATION tokens are in the request too — they were merely written
        // to the cache on the way in, so they count toward the context.
        let u = json!({ "input_tokens": 10, "cache_creation_input_tokens": 1000,
            "cache_read_input_tokens": 21213, "output_tokens": 47 });
        assert_eq!(compute_used(&u), 22270);
    }

    fn delta(usage: serde_json::Value) -> Value {
        json!({ "type": "message_delta", "usage": usage })
    }

    #[test]
    fn context_tracker_reports_the_last_request_not_the_turn_total() {
        // THE BUG: a turn is many API requests and each re-reads the whole
        // conversation. Summing them blows past the window; the newest one wins.
        let mut t = ContextTracker::default();
        for cache_read in [90_000, 120_000, 150_000] {
            t.observe_stream_event(&json!({
                "type": "message_start",
                "message": { "usage": { "input_tokens": 4, "cache_read_input_tokens": cache_read } }
            }));
            t.observe_stream_event(&delta(json!({ "output_tokens": 1_000 })));
        }
        assert_eq!(t.finish(200_000), Some(151_004));
    }

    #[test]
    fn context_tracker_ignores_the_result_aggregate_once_the_stream_spoke() {
        let mut t = ContextTracker::default();
        t.observe_stream_event(&json!({
            "type": "message_start",
            "message": { "usage": { "input_tokens": 10, "cache_read_input_tokens": 40_000 } }
        }));
        t.observe_stream_event(&delta(json!({ "output_tokens": 500 })));
        // the CLI's terminal usage is a cost aggregate over every request of the
        // turn (subagents included) — it must not overwrite the real figure.
        t.observe_result(
            &json!({ "input_tokens": 200, "cache_read_input_tokens": 3_400_000,
            "output_tokens": 12_000 }),
        );
        assert_eq!(t.finish(200_000), Some(40_510));
    }

    #[test]
    fn context_tracker_falls_back_to_result_when_nothing_streamed() {
        let mut t = ContextTracker::default();
        assert_eq!(t.finish(200_000), None); // nothing seen → no event at all
        t.observe_result(&json!({ "input_tokens": 100, "output_tokens": 20 }));
        assert_eq!(t.finish(200_000), Some(120));
    }

    #[test]
    fn context_tracker_prefers_a_delta_that_carries_its_own_input_side() {
        // newer API versions repeat the input buckets on message_delta
        let mut t = ContextTracker::default();
        t.observe_stream_event(&json!({
            "type": "message_start",
            "message": { "usage": { "input_tokens": 1, "cache_read_input_tokens": 10 } }
        }));
        t.observe_stream_event(&delta(
            json!({ "input_tokens": 5, "cache_read_input_tokens": 70_000, "output_tokens": 900 }),
        ));
        assert_eq!(t.finish(1_000_000), Some(70_905));
    }

    #[test]
    fn context_tracker_clamps_to_the_window() {
        let mut t = ContextTracker::default();
        t.observe_result(&json!({ "input_tokens": 5_000_000, "output_tokens": 1 }));
        assert_eq!(t.finish(200_000), Some(200_000));
        assert_eq!(t.finish(0), Some(5_000_001)); // unknown window → no clamp
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
