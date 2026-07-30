//! turn-shaped commands: send (+ queueing/intercept), compact, clear.

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
pub(crate) enum SendSource {
    /// Typed input (francois:session:send): slash commands in the intercept set
    /// are answered locally (interactive-commands FR-2).
    Typed,
    /// francois:skills:run: custom skills pass through byte-for-byte
    /// (interactive-commands §2 non-goal) — never intercepted, always a real turn.
    Skill,
}

/// The intercept decision for a send (interactive-commands FR-1/2), honoring the
/// skills passthrough. Pure; unit-tested.
pub(crate) fn send_intercept(text: &str, source: SendSource) -> Option<(String, Option<String>)> {
    match source {
        SendSource::Typed => intercepted_command(text),
        SendSource::Skill => None,
    }
}

/// Shared send logic (used by session_send and skills_run): queue if a turn is
/// running, else start a new turn. Assumes `text` is already non-empty.
pub(crate) fn do_send(
    app: &AppHandle,
    session_id: &str,
    text: String,
    block_id: String,
    source: SendSource,
) -> IpcResult<SendOutput> {
    let engine = app.state::<Engine>();
    let mut map = engine.sessions.lock().unwrap();
    let Some(s) = map.get_mut(session_id) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    if s.status == "done" || s.status == "error" {
        return err("SESSION_NOT_RUNNING", "session has ended; create a new one");
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
    match s.status.as_str() {
        "running" => {
            if s.queue.len() >= QUEUE_CAP {
                return err("INVALID_INPUT", "send queue is full (20 pending)");
            }
            s.queue.push_back((block_id, text));
            let pos = s.queue.len();
            return ok(SendOutput {
                queued: true,
                queue_position: Some(pos),
            });
        }
        _ => {} // idle → start a turn
    }
    s.status = "running".into();
    s.last_activity_at = now_ms();
    drop(map);
    emit(
        app,
        SessionEvent::Status {
            session_id: session_id.into(),
            status: "running".into(),
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
        return err("INVALID_INPUT", "message is empty");
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

#[tauri::command(async)]
pub fn session_compact(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Option<()>> {
    // Snapshot cwd/model/resume/effort; enforce status.
    let (cwd, model_id, resume, effort, permission_mode, runtime) = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        match s.status.as_str() {
            "done" | "error" => return err("SESSION_NOT_RUNNING", "session has ended"),
            "running" => return err("SESSION_ALREADY_RUNNING", "a turn is already running"),
            _ => {}
        }
        s.status = "running".into();
        (
            s.cwd.clone(),
            s.model_id.clone(),
            s.claude_session_id.clone(),
            s.effort.clone(),
            s.permission_mode.clone(),
            s.runtime.clone(),
        )
    };
    emit(
        &app,
        SessionEvent::Status {
            session_id: session_id.clone(),
            status: "running".into(),
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
        let mut map = engine.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(&session_id) {
            if let Some(u) = used {
                s.context_used_tokens = u;
            }
            s.status = "idle".into();
        }
    }
    crate::usage::note_turn_ended(&app); // usage-bar FR-13: a /compact turn ended too
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
            status: "idle".into(),
        },
    );
    ok(None)
}

/// Outcome of the /clear full-reset mutation, applied under the sessions lock.
pub(crate) enum ClearOutcome {
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
pub(crate) fn apply_clear(map: &mut HashMap<String, Session>, session_id: &str) -> ClearOutcome {
    let Some(s) = map.get_mut(session_id) else {
        return ClearOutcome::NotFound;
    };
    if s.status == "running" {
        return ClearOutcome::Running;
    }
    s.block_buffer.clear();
    s.claude_session_id = None;
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
        let mut map = engine.sessions.lock().unwrap();
        match apply_clear(&mut map, &session_id) {
            ClearOutcome::NotFound => return err("SESSION_NOT_FOUND", "no such session"),
            ClearOutcome::Running => {
                return err(
                    "SESSION_ALREADY_RUNNING",
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
            let mut map = engine.sessions.lock().unwrap();
            apply_clear(&mut map, "s1")
        };
        assert!(matches!(outcome, ClearOutcome::Cleared { limit: 200_000 }));

        let map = engine.sessions.lock().unwrap();
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
            let mut map = engine.sessions.lock().unwrap();
            apply_clear(&mut map, "s1")
        };
        assert!(matches!(outcome, ClearOutcome::Running));

        let map = engine.sessions.lock().unwrap();
        let s = map.get("s1").unwrap();
        assert_eq!(s.block_buffer.len(), 1); // untouched
        assert_eq!(s.claude_session_id.as_deref(), Some("abc-resume"));
        assert_eq!(s.context_used_tokens, 42_000);
    }

    #[test]
    fn clear_missing_session_reports_not_found() {
        let engine = test_engine_with(test_session());
        let mut map = engine.sessions.lock().unwrap();
        assert!(matches!(
            apply_clear(&mut map, "nope"),
            ClearOutcome::NotFound
        ));
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
