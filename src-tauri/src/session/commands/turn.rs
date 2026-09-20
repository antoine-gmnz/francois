//! turn-shaped commands: send (+ queueing/intercept), compact, clear.

use crate::ipc::ErrorCode;
use crate::ipc::{err, ok, IpcResult};
use crate::session::*;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
pub struct SendOutput {
    queued: bool,
    #[serde(rename = "queuePosition", skip_serializing_if = "Option::is_none")]
    queue_position: Option<usize>,
}

/// Where a send originated — controls the interactive-commands intercept branch.
#[derive(Clone, Copy, PartialEq)]
pub enum SendSource {
    /// Typed input (francois:session:send): slash commands in the intercept set
    /// are answered locally (interactive-commands FR-2).
    Typed,
    /// francois:skills:run: custom skills pass through byte-for-byte
    /// (interactive-commands §2 non-goal) — never intercepted, always a real turn.
    Skill,
}

/// The intercept decision for a send (interactive-commands FR-1/2), honoring the
/// skills passthrough. Pure; unit-tested.
pub fn send_intercept(text: &str, source: SendSource) -> Option<(String, Option<String>)> {
    match source {
        SendSource::Typed => intercepted_command(text),
        SendSource::Skill => None,
    }
}

/// Shared send logic (used by session_send and skills_run): queue if a turn is
/// running, else start a new turn. Assumes `text` is already non-empty.
pub fn do_send(
    app: &AppHandle,
    session_id: &str,
    text: String,
    block_id: String,
    source: SendSource,
) -> IpcResult<SendOutput> {
    let engine = app.state::<Engine>();
    if engine
        .unsupported_runtime_records
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains_key(session_id)
    {
        return err(
            ErrorCode::RuntimeUnsupported,
            "unsupported runtime record retained for recovery",
        );
    }
    if let Some((command, _)) = send_intercept(&text, source) {
        let key = match command.as_str() {
            "compact" => "compaction",
            "model" => "modelSwitching",
            _ => "interactiveCommands",
        };
        if let Err((code, msg)) = engine.require_capability(session_id, key) {
            return err(code, msg);
        }
    }
    if source == SendSource::Skill {
        if let Err((code, msg)) = engine.require_capability(session_id, "skills") {
            return err(code, msg);
        }
    }
    let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
    let Some(s) = map.get_mut(session_id) else {
        return err(ErrorCode::SessionNotFound, "no such session");
    };
    if let Err((code, msg)) = s.validate_attachment_submission(&text) {
        return err(code, msg);
    }
    if status::is_terminal(&s.status) {
        return err(
            ErrorCode::SessionNotRunning,
            "session has ended; create a new one",
        );
    }
    // interactive-commands FR-1/2: an intercepted slash command never enqueues, never
    // changes SessionStatus, and works identically whether running or idle. It sits
    // BEFORE the running→enqueue branch so it bypasses the FIFO queue.
    if let Some((command, arg)) = send_intercept(&text, source) {
        // FR-4: user echo first — buffer + persist the user block, then message.user
        // with the request's blockId, then the per-command flow.
        s.buf_user(&block_id, text.clone());
        s.last_activity_at = now_ms();
        let user_block = s.block_buffer.last().cloned();
        drop(map);
        if let Some(b) = &user_block {
            append_transcript(app, session_id, b);
        }
        emit(
            app,
            SessionEvent::MessageUser {
                session_id: session_id.into(),
                block_id,
                text,
            },
        );
        run_intercepted_command(app, session_id, &command, arg.as_deref());
        return ok(SendOutput {
            queued: false,
            queue_position: None,
        }); // FR-3
    }
    // A turn is in flight — INCLUDING one parked on an approval or a question,
    // whose child is alive and will read this message once it is unparked. Enqueue.
    if status::is_busy(&s.status) {
        if s.queue.len() >= QUEUE_CAP {
            return err(ErrorCode::InvalidInput, "send queue is full (20 pending)");
        }
        s.queue.push_back((block_id, text));
        let pos = s.queue.len();
        return ok(SendOutput {
            queued: true,
            queue_position: Some(pos),
        });
    }
    // idle → start a turn. `starting` until the stream's system/init arrives, so
    // the card can say "spawning" instead of claiming work that has not begun.
    s.status = status::STARTING.into();
    s.last_activity_at = now_ms();
    drop(map);
    emit(
        app,
        SessionEvent::Status {
            session_id: session_id.into(),
            status: status::STARTING.into(),
        },
    );
    begin_turn(app, session_id, block_id, text, TurnMode::Normal);
    ok(SendOutput {
        queued: false,
        queue_position: None,
    })
}

#[tauri::command(async)]
pub fn session_send(
    app: AppHandle,
    session_id: String,
    text: String,
    block_id: Option<String>,
) -> IpcResult<SendOutput> {
    if text.trim().is_empty() {
        return err(ErrorCode::InvalidInput, "message is empty");
    }
    // The client generates the blockId so its optimistic block matches the
    // eventual message.user event (conversation-view FR-15/FR-21).
    do_send(
        &app,
        &session_id,
        text,
        block_id.unwrap_or_else(uuid),
        SendSource::Typed,
    )
}

#[derive(Serialize)]
pub struct UnqueueOutput {
    removed: bool,
}

/// transcript-perf FR-19: remove the queued prompt whose blockId matches from
/// `Session.queue`. Never touches `current`/status and mutates nothing but the
/// queue — a lost race (already drained, or never queued) is not an error,
/// just `removed: false`. Pure map mutation, split out like `apply_clear` so
/// the command wrapper below is a one-line lock + call.
pub fn apply_unqueue(
    map: &mut HashMap<String, Session>,
    session_id: &str,
    block_id: &str,
) -> Option<bool> {
    let s = map.get_mut(session_id)?;
    let before = s.queue.len();
    s.queue.retain(|(id, _)| id != block_id);
    Some(s.queue.len() < before)
}

/// francois:session:unqueue — retract a prompt parked in the FIFO queue before
/// the running turn drains it (transcript-perf FR-19). Emits no event: the
/// caller (conversation-view) removes the pending row itself on `removed:
/// true`, and lets the eventual `message.user` clear it on `removed: false`.
///
/// pi-turn-controls FR-5: for a Pi session, the legacy `Session.queue` FIFO is
/// not what holds a pending intent at all — the admissions ledger does, keyed
/// by `clientMessageId` (a still-pending Pi intent has no transcript block to
/// carry a `blockId` yet). `block_id` is read as that id for a Pi session
/// only. Once Pi has accepted it (ledger state `queued`), individual removal
/// answers `RUNTIME_UNSUPPORTED` — `session_clear_queue` is the only way to
/// cancel it (never clear-and-re-enqueue, which could duplicate consumed work).
#[tauri::command(async)]
pub fn session_unqueue(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    block_id: String,
) -> IpcResult<UnqueueOutput> {
    let agent_runtime = match engine.with_session(&session_id, |s| s.agent_runtime) {
        Some(rt) => rt,
        None => return err(ErrorCode::SessionNotFound, "no such session"),
    };
    if agent_runtime == AgentRuntime::Pi {
        return match engine.with_admissions(&session_id, |l| l.unqueue(&block_id)) {
            admission::UnqueueOutcome::Removed => {
                admission::write_admission_sidecar(&app, &engine, &session_id);
                admission::publish_queue_changed(&app, &engine, &app, &session_id);
                ok(UnqueueOutput { removed: true })
            }
            admission::UnqueueOutcome::Unsupported => err(
                ErrorCode::RuntimeUnsupported,
                "this message has already been accepted by the runtime — use Clear queue",
            ),
            admission::UnqueueOutcome::NotFound => ok(UnqueueOutput { removed: false }),
        };
    }
    let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
    match apply_unqueue(&mut map, &session_id, &block_id) {
        Some(removed) => ok(UnqueueOutput { removed }),
        None => err(ErrorCode::SessionNotFound, "no such session"),
    }
}

#[tauri::command(async)]
pub fn session_compact(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Option<()>> {
    if let Err((code, msg)) = engine.require_capability(&session_id, "compaction") {
        return err(code, msg);
    }
    // pi-turn-controls FR-8: a Pi session's compaction goes through its OWN
    // runtime connection — never `spawn_claude` — and never falls through to
    // the claude-shaped path below.
    if engine.with_session(&session_id, |s| s.agent_runtime) == Some(AgentRuntime::Pi) {
        return session_compact_pi(&app, &engine, &session_id);
    }
    // Snapshot cwd/model/resume/effort; enforce status.
    let (
        cwd,
        model_id,
        resume,
        effort,
        permission_mode,
        runtime,
        worktree_distro,
        account_id,
        system_prompt,
        extra_args,
        turn_response_mode,
    ) = {
        let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let Some(s) = map.get_mut(&session_id) else {
            return err(ErrorCode::SessionNotFound, "no such session");
        };
        if status::is_terminal(&s.status) {
            return err(ErrorCode::SessionNotRunning, "session has ended");
        }
        if status::is_busy(&s.status) {
            return err(
                ErrorCode::SessionAlreadyRunning,
                "a turn is already running",
            );
        }
        // /compact is a synchronous side-spawn with its stdin closed immediately
        // (it can never park on an ask), so it goes straight to `running` — there
        // is no init to wait on and no `starting` window worth showing.
        s.status = status::RUNNING.into();
        (
            s.cwd.clone(),
            s.model_id.clone(),
            s.claude_session_id.clone(),
            s.effort.clone(),
            s.permission_mode.clone(),
            s.runtime.clone(),
            s.worktree_distro.clone(),
            s.account_id.clone(),
            // session-profiles FR-13: /compact is a claude spawn on behalf of
            // this session like any other turn — both ride along.
            s.system_prompt.clone(),
            s.extra_args.clone(),
            // response-mode FR-7: EVERY claude invocation carries the directive,
            // and /compact is a claude spawn on behalf of this session like any
            // other turn — it rides along with the two above.
            s.response_mode,
        )
    };
    // multi-account FR-21: a /compact turn is a claude spawn on behalf of the
    // session, so it runs under the session's account like any other.
    let account_config_dir = crate::account::config_dir_of(&app, &account_id);

    // multi-account FR-22: same guard as begin_turn — an account whose
    // `.claude.json` has vanished has no credentials, so a /compact spawn
    // would hang on an interactive login prompt no one can answer. Fail the
    // compact instead of spawning.
    if let Some(dir) = account_config_dir.as_deref() {
        if !crate::account::identity_file_exists(dir) {
            crate::account::mark_auth_failed(&app, &account_id);
            fail_session(
                &app,
                &session_id,
                ErrorCode::AccountNotAuthenticated,
                "this session's account is not signed in — use Re-login in the Accounts modal",
            );
            return ok(None);
        }
    }

    emit(
        &app,
        SessionEvent::Status {
            session_id: session_id.clone(),
            status: status::RUNNING.into(),
        },
    );

    // Run a synchronous compaction turn ("/compact"), reading only its final
    // usage — FR-28. No transcript events are surfaced.
    let limit = context_limit(&model_id);
    let mut ctx_usage = ContextTracker::default();
    if let Ok(mut child) = spawn_claude(
        &cwd,
        &model_id,
        resume.as_deref(),
        "/compact",
        effort.as_deref(),
        &permission_mode,
        &runtime,
        worktree_distro.as_deref(),
        account_config_dir.as_deref(),
        system_prompt.as_deref(),
        &extra_args,
        turn_response_mode,
    ) {
        // session-questions FR-5: /compact rides the stdin path like any turn, but a
        // compaction can never park on a question — close the pipe right away; the
        // EOF is what lets the CLI exit after its result (stream-json input mode).
        drop(child.stdin.take());
        if let Some(out) = child_stdout_lines(child) {
            for line in out {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                // Same rule as a normal turn: per-request stream usage is the
                // context, `result.usage` only a last resort (see ContextTracker).
                // Subagent lines carry a parent_tool_use_id and are skipped.
                if matches!(route_line(&v), LineRoute::Attributed(_)) {
                    continue;
                }
                match v.get("type").and_then(|t| t.as_str()) {
                    Some("stream_event") => {
                        if let Some(ev) = v.get("event") {
                            ctx_usage.observe_stream_event(ev);
                        }
                    }
                    Some("result") => {
                        if let Some(u) = v.get("usage") {
                            ctx_usage.observe_result(u);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let used = ctx_usage.finish(limit);
    {
        let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(s) = map.get_mut(&session_id) {
            if let Some(u) = used {
                s.context_used_tokens = u;
            }
            s.status = status::IDLE.into();
        }
    }
    // usage-bar FR-13: a /compact turn ended too — multi-account FR-29 scopes it
    // to that session's account.
    crate::usage::note_turn_ended(&app, &account_id);
    if let Some(u) = used {
        emit(
            &app,
            SessionEvent::ContextUsage {
                session_id: session_id.clone(),
                used_tokens: u,
                limit_tokens: limit,
            },
        );
    }
    emit(
        &app,
        SessionEvent::Status {
            session_id,
            status: status::IDLE.into(),
        },
    );
    ok(None)
}

/// pi-turn-controls FR-8 ("Mark compacting until terminal result/settled
/// state"): a Pi compaction holds the session BUSY for its whole duration,
/// exactly as the claude-shaped `/compact` above does.
///
/// HIGH (review): it used to mark nothing at all, so while a compaction was
/// in flight — up to `Deadlines::compaction`, 180 s — the session still read
/// `idle` and three things were accepted against a connection busy
/// compacting: a Normal submit (`admission::admit_and_deliver`'s FR-1
/// mode/state matrix), a model/effort switch (`pi_settled_gate`) and a SECOND
/// compaction (this claim).
///
/// A GUARD rather than paired calls: the compaction returns from four places
/// (no connection, the wire call's error, its success, a panic), and one that
/// left the session stuck `running` would need an app restart to clear.
/// `on_status` is the emission half, injected so the claim itself needs no
/// `AppHandle` and stays testable — the same shape `clear_queue_bracketed`
/// (commands/submit.rs) uses, and for the same reason.
struct CompactingClaim<'a> {
    engine: &'a Engine,
    session_id: &'a str,
    on_status: &'a dyn Fn(&str),
}

impl<'a> CompactingClaim<'a> {
    /// FR-8: accepted only while settled. A terminal session is
    /// `SESSION_NOT_RUNNING`; anything in flight is `SESSION_BUSY` — NOT the
    /// claude-shaped `/compact`'s `SESSION_ALREADY_RUNNING`: the contract
    /// (`session-engine.ts`, `session_compact` for a Pi session) names
    /// `SESSION_BUSY`, the code every other Pi verb refuses a busy session
    /// with, and the webview keys its "busy" handling on it. The terminal
    /// check is load-bearing here and not merely tidy: a `done`/`error`
    /// session is not BUSY, so without it the mark below would resurrect a
    /// dead session as `running`.
    fn claim(
        engine: &'a Engine,
        session_id: &'a str,
        on_status: &'a dyn Fn(&str),
    ) -> Result<Self, AppError> {
        let marked = engine.with_session_mut(session_id, |s| {
            if status::is_terminal(&s.status) {
                return Err(AppError::new(
                    ErrorCode::SessionNotRunning,
                    "session has ended",
                ));
            }
            if status::is_busy(&s.status) {
                return Err(AppError::new(
                    ErrorCode::SessionBusy,
                    "a turn is already running",
                ));
            }
            s.status = status::RUNNING.into();
            s.last_activity_at = now_ms();
            Ok(())
        });
        match marked {
            None => Err(AppError::new(ErrorCode::SessionNotFound, "no such session")),
            Some(Err(e)) => Err(e),
            Some(Ok(())) => {
                on_status(status::RUNNING);
                Ok(Self {
                    engine,
                    session_id,
                    on_status,
                })
            }
        }
    }
}

impl Drop for CompactingClaim<'_> {
    fn drop(&mut self) {
        // Undoes ONLY its own mark. A `run.state`/`failure` envelope arriving
        // mid-compaction owns the session's status (`runtime.rs`), and
        // stamping `idle` over an `error` it just recorded would hide the
        // failure the user needs to see.
        let settled = self.engine.with_session_mut(self.session_id, |s| {
            if s.status == status::RUNNING {
                s.status = status::IDLE.into();
                s.last_activity_at = now_ms();
                true
            } else {
                false
            }
        });
        if settled == Some(true) {
            (self.on_status)(status::IDLE);
        }
    }
}

/// pi-turn-controls FR-8: manual compaction over the session's OWN Pi
/// connection — never `spawn_claude`. Accepted only while idle; a failed
/// compaction reports the error and touches neither the conversation nor its
/// display history (nothing here mutates either).
fn session_compact_pi(app: &AppHandle, engine: &Engine, session_id: &str) -> IpcResult<Option<()>> {
    let on_status = |status: &str| {
        emit(
            app,
            SessionEvent::Status {
                session_id: session_id.into(),
                status: status.into(),
            },
        )
    };
    let _compacting = match CompactingClaim::claim(engine, session_id, &on_status) {
        Ok(claim) => claim,
        Err(e) => return e.into(),
    };
    let Some(connection) = engine.runtime_connection_for(session_id) else {
        return err(ErrorCode::RuntimeUnavailable, "runtime is not connected");
    };
    publish_compaction(app, engine, session_id, "started", None);
    match connection.compact() {
        Ok(()) => {
            publish_compaction(app, engine, session_id, "completed", None);
            ok(None)
        }
        Err(e) => {
            // FR-8: "failure preserves conversation + display history" —
            // this branch mutates neither; it only reports the error.
            publish_compaction(app, engine, session_id, "failed", Some(e.message.clone()));
            e.into()
        }
    }
}

/// FR-8: publish the `compaction` runtime event through the same envelope/
/// sequencing every other Pi event uses. Best-effort — a session with no live
/// runtime-event producer yet has nothing to publish through.
fn publish_compaction(
    app: &AppHandle,
    engine: &Engine,
    session_id: &str,
    state: &str,
    message: Option<String>,
) {
    if let Ok((batch, _block)) = engine.runtime_event_for_session(
        app,
        session_id,
        now_ms(),
        None,
        None,
        events::RuntimeEventPayload::Compaction {
            state: state.into(),
            automatic: false,
            message,
        },
    ) {
        for ev in batch {
            emit(app, ev);
        }
    }
}

/// Outcome of the /clear full-reset mutation, applied under the sessions lock.
pub enum ClearOutcome {
    NotFound,
    Running,
    /// Reset succeeded; carries `context_limit_tokens` for the follow-up usage event.
    Cleared {
        limit: u64,
    },
}

/// /clear FULL RESET, applied under `engine.sessions`: wipe the transcript buffer,
/// drop the resume anchor (fresh Claude context next turn), and zero the context
/// counter. Refuses while a turn is running so it never races the resume anchor.
pub fn apply_clear(map: &mut HashMap<String, Session>, session_id: &str) -> ClearOutcome {
    let Some(s) = map.get_mut(session_id) else {
        return ClearOutcome::NotFound;
    };
    // Any in-flight turn blocks a reset, parked ones included — the resume anchor
    // must not move under a live child.
    if status::is_busy(&s.status) {
        return ClearOutcome::Running;
    }
    s.block_buffer.clear();
    s.claude_session_id = None;
    // response-mode FR-10: the thread anchor is gone, so nothing has been told
    // to the thread the next turn will start — the directive is re-sent there.
    s.response_mode_sent = None;
    s.context_used_tokens = 0;
    s.last_activity_at = now_ms();
    ClearOutcome::Cleared {
        limit: s.context_limit_tokens,
    }
}

/// francois:session:clear — /clear performs a FULL RESET: wipe the transcript
/// (in-memory buffer + on-disk file), reset the context token counter, and drop
/// the resume anchor so the next turn starts a fresh Claude context. It never
/// spawns a turn and leaves no echo/command card behind (the frontend intercepts
/// `/clear` and calls this instead of session_send).
#[tauri::command(async)]
pub fn session_clear(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Option<()>> {
    // Mutate under the lock, then release it before any fs / persist / emit work.
    let limit = {
        let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        match apply_clear(&mut map, &session_id) {
            ClearOutcome::NotFound => return err(ErrorCode::SessionNotFound, "no such session"),
            ClearOutcome::Running => {
                return err(
                    ErrorCode::SessionAlreadyRunning,
                    "finish or interrupt the current turn before clearing",
                )
            }
            ClearOutcome::Cleared { limit } => limit,
        }
    };
    clear_transcript(&app, &session_id);
    persist(&app, &engine); // claude_session_id changed → must survive restart
    emit(
        &app,
        SessionEvent::Cleared {
            session_id: session_id.clone(),
        },
    );
    // Reset the context/usage UI to empty.
    emit(
        &app,
        SessionEvent::ContextUsage {
            session_id,
            used_tokens: 0,
            limit_tokens: limit,
        },
    );
    ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::*;

    #[test]
    fn clear_full_reset_on_idle_session() {
        // /clear FULL RESET: transcript buffer emptied, resume anchor dropped,
        // context counter zeroed.
        let mut s = test_session();
        s.status = "idle".into();
        s.claude_session_id = Some("abc-resume".into());
        s.context_used_tokens = 42_000;
        s.buf_user("b1", "hello".into());
        s.buf_assistant("b2", "hi".into());
        assert_eq!(s.block_buffer.len(), 2);

        let engine = test_engine_with(s);
        let outcome = {
            let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
            apply_clear(&mut map, "s1")
        };
        assert!(matches!(outcome, ClearOutcome::Cleared { limit: 200_000 }));

        let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let s = map.get("s1").unwrap();
        assert!(s.block_buffer.is_empty());
        assert_eq!(s.claude_session_id, None);
        assert_eq!(s.context_used_tokens, 0);
    }

    #[test]
    fn clear_refuses_running_session_without_mutating() {
        // A full reset must not race a live turn / mutate the resume anchor mid-stream.
        let mut s = test_session();
        s.status = "running".into();
        s.claude_session_id = Some("abc-resume".into());
        s.context_used_tokens = 42_000;
        s.buf_user("b1", "hello".into());

        let engine = test_engine_with(s);
        let outcome = {
            let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
            apply_clear(&mut map, "s1")
        };
        assert!(matches!(outcome, ClearOutcome::Running));

        let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let s = map.get("s1").unwrap();
        assert_eq!(s.block_buffer.len(), 1); // untouched
        assert_eq!(s.claude_session_id.as_deref(), Some("abc-resume"));
        assert_eq!(s.context_used_tokens, 42_000);
    }

    #[test]
    fn clear_missing_session_reports_not_found() {
        let engine = test_engine_with(test_session());
        let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        assert!(matches!(
            apply_clear(&mut map, "nope"),
            ClearOutcome::NotFound
        ));
    }

    #[test]
    fn unqueue_removes_the_matching_pending_prompt() {
        // FR-19: removes the entry whose blockId matches, returns removed:true.
        let mut s = test_session();
        s.status = "running".into();
        s.queue.push_back(("b1".into(), "first".into()));
        s.queue.push_back(("b2".into(), "second".into()));
        let engine = test_engine_with(s);

        let removed = {
            let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
            apply_unqueue(&mut map, "s1", "b1")
        };
        assert_eq!(removed, Some(true));

        let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let s = map.get("s1").unwrap();
        assert_eq!(s.queue.len(), 1);
        assert_eq!(s.queue.front().unwrap().0, "b2");
        // FR-19: never touches status.
        assert_eq!(s.status, "running");
    }

    #[test]
    fn unqueue_lost_race_reports_not_removed_without_mutating() {
        // FR-19/edge case: the turn already drained it (or it was never
        // queued) — removed:false, queue left exactly as it was.
        let mut s = test_session();
        s.queue.push_back(("b1".into(), "first".into()));
        let engine = test_engine_with(s);

        let removed = {
            let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
            apply_unqueue(&mut map, "s1", "b2")
        };
        assert_eq!(removed, Some(false));

        let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(map.get("s1").unwrap().queue.len(), 1);
    }

    #[test]
    fn unqueue_on_idle_session_with_empty_queue_is_not_an_error() {
        let engine = test_engine_with(test_session());
        let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(apply_unqueue(&mut map, "s1", "whatever"), Some(false));
    }

    #[test]
    fn unqueue_unknown_session_reports_not_found() {
        let engine = test_engine_with(test_session());
        let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(apply_unqueue(&mut map, "nope", "b1"), None);
    }

    // ---------- pi-turn-controls FR-8: a compaction marks the session busy ----------

    /// HIGH (review): the Pi compaction marked nothing, so everything that
    /// gates on the session being settled let work through while it ran.
    ///
    /// This proves the mark and the SECOND-compaction refusal. The other two
    /// refusals the mark buys are covered where those gates live, against the
    /// very status asserted here: a Normal submit in
    /// `admission::deliver`'s `the_delivery_mode_matrix_survives_the_gate_extraction`,
    /// a model/effort switch in `lifecycle`'s
    /// `pi_settled_gate_rejects_a_busy_session_as_session_busy`.
    #[test]
    fn a_pi_compaction_marks_the_session_busy_and_refuses_a_second_one() {
        let engine = test_engine_with(test_session());
        let statuses = std::cell::RefCell::new(Vec::new());
        let on_status = |s: &str| statuses.borrow_mut().push(s.to_string());
        {
            let _claim = CompactingClaim::claim(&engine, "s1", &on_status)
                .expect("an idle session accepts a compaction");
            assert_eq!(
                engine.with_session("s1", |s| s.status.clone()).unwrap(),
                status::RUNNING,
                "every settled-gate in the codebase reads this status"
            );
            let second = CompactingClaim::claim(&engine, "s1", &on_status)
                .err()
                .expect("a second compaction must be refused mid-compaction");
            assert_eq!(second.code, ErrorCode::SessionBusy);
        }
        assert_eq!(
            engine.with_session("s1", |s| s.status.clone()).unwrap(),
            status::IDLE,
            "the claim releases on scope exit, not only on the success path"
        );
        assert_eq!(*statuses.borrow(), vec![status::RUNNING, status::IDLE]);
    }

    /// The guard exists because `session_compact_pi` returns from four places.
    /// A panic is the one an explicit `s.status = idle` after the wire call
    /// could never have covered.
    #[test]
    fn a_panic_during_a_compaction_still_settles_the_session() {
        let engine = test_engine_with(test_session());
        let on_status = |_: &str| {};
        // The panic below prints, as any caught panic does — that is the
        // point of the test, not a failure.
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _claim = CompactingClaim::claim(&engine, "s1", &on_status).unwrap();
            panic!("the wire call blew up");
        }));
        assert!(panicked.is_err());
        assert_eq!(
            engine.with_session("s1", |s| s.status.clone()).unwrap(),
            status::IDLE
        );
    }

    #[test]
    fn a_terminal_session_is_never_resurrected_by_a_compaction_claim() {
        let on_status = |_: &str| {};
        for terminal in ["done", status::ERROR] {
            let mut s = test_session();
            s.status = terminal.into();
            let engine = test_engine_with(s);
            let err = CompactingClaim::claim(&engine, "s1", &on_status)
                .err()
                .expect("a terminal session accepts no compaction");
            assert_eq!(err.code, ErrorCode::SessionNotRunning, "{terminal}");
            assert_eq!(
                engine.with_session("s1", |s| s.status.clone()).unwrap(),
                terminal,
                "the refused claim must not have marked it running"
            );
        }
    }

    #[test]
    fn a_compaction_claim_on_an_unknown_session_is_not_found() {
        let engine = test_engine_with(test_session());
        let on_status = |_: &str| {};
        let err = CompactingClaim::claim(&engine, "nope", &on_status)
            .err()
            .expect("an unknown id has nothing to compact");
        assert_eq!(err.code, ErrorCode::SessionNotFound);
    }

    /// FR-8/`runtime.rs`: a `failure` envelope arriving mid-compaction owns
    /// the status. Releasing the claim must not stamp `idle` over the error
    /// the user needs to see.
    #[test]
    fn the_claim_never_overwrites_a_status_something_else_already_moved() {
        let engine = test_engine_with(test_session());
        let statuses = std::cell::RefCell::new(Vec::new());
        let on_status = |s: &str| statuses.borrow_mut().push(s.to_string());
        {
            let _claim = CompactingClaim::claim(&engine, "s1", &on_status).unwrap();
            engine.with_session_mut("s1", |s| s.status = status::ERROR.into());
        }
        assert_eq!(
            engine.with_session("s1", |s| s.status.clone()).unwrap(),
            status::ERROR
        );
        assert_eq!(*statuses.borrow(), vec![status::RUNNING]);
    }

    #[test]
    fn skill_sends_are_never_intercepted() {
        // Remediation R1 / spec §2 non-goal: a skill named like an intercepted
        // command passes through byte-for-byte; typed input keeps intercepting.
        for t in ["/usage", "/cost", "/model opus", "/status", "/help"] {
            assert!(
                send_intercept(t, SendSource::Skill).is_none(),
                "{t} from skills_run must pass through"
            );
            assert!(
                send_intercept(t, SendSource::Typed).is_some(),
                "{t} typed must intercept"
            );
        }
        // non-intercepted text is passthrough from both sources
        assert!(send_intercept("/spec something", SendSource::Typed).is_none());
        assert!(send_intercept("/spec something", SendSource::Skill).is_none());
    }
}
