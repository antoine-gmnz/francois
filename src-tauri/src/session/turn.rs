//! turn lifecycle: argv, spawn, begin/finish, and session failure.

use super::*;

use crate::ipc::AppError;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

// ---------- turn execution ----------

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum TurnMode {
    Normal,
    #[allow(dead_code)]
    Compact,
    /// Re-run of a turn whose `--resume` was rejected: skip re-buffering the user
    /// message; the caller has already cleared claude_session_id so it runs fresh (FR-9).
    ResumeRetry,
}

/// The claude argv for a session turn. session-questions FR-1: `-p` with NO
/// positional prompt (the turn text rides stdin), plus the stdio control channel
/// (`--input-format stream-json --permission-prompt-tool stdio`). Pure; unit-tested.
pub(crate) fn turn_args(
    model_id: &str,
    resume: Option<&str>,
    effort: Option<&str>,
    permission_mode: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--permission-prompt-tool".into(),
        "stdio".into(),
        "--include-partial-messages".into(),
        "--verbose".into(),
        "--model".into(),
        model_id.into(),
    ];
    args.extend(permission_args(permission_mode)); // per-invocation; --resume does not carry it
    if let Some(e) = effort {
        args.extend(["--effort".into(), e.into()]);
    }
    if let Some(r) = resume {
        args.extend(["--resume".into(), r.into()]);
    }
    args
}

/// The §5.5 NDJSON user line carrying a turn's text over stdin (FR-1).
pub(crate) fn user_line(text: &str) -> String {
    let mut line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    })
    .to_string();
    line.push('\n');
    line
}

pub(crate) fn spawn_claude(
    cwd: &str,
    model_id: &str,
    resume: Option<&str>,
    text: &str,
    effort: Option<&str>,
    permission_mode: &str,
    runtime: &str,
) -> std::io::Result<Child> {
    let args = turn_args(model_id, resume, effort, permission_mode);
    let (program, argv) = claude_invocation(runtime, cwd, args);
    let mut cmd = Command::new(program);
    cmd.args(argv);
    if runtime != "wsl" {
        cmd.current_dir(cwd); // wsl turns get their cwd via `--cd` inside the distro
    }
    no_window(&mut cmd);
    // session-questions FR-1: stdin is piped — the turn text goes down it as one
    // NDJSON user line, and the stdio control channel (question answers /
    // permission denies) rides the same pipe for the rest of the turn.
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    let wrote = {
        use std::io::Write as _;
        match child.stdin.as_mut() {
            Some(w) => w
                .write_all(user_line(text).as_bytes())
                .and_then(|_| w.flush()),
            None => Ok(()),
        }
    };
    if let Err(e) = wrote {
        // The child died before reading its prompt — surface it as a spawn failure.
        let _ = child.kill();
        return Err(e);
    }
    Ok(child)
}

pub(crate) fn child_stdout_lines(mut child: Child) -> Option<Vec<String>> {
    let stdout = child.stdout.take()?;
    let reader = BufReader::new(stdout);
    let mut lines = Vec::new();
    for line in reader.lines() {
        match line {
            Ok(l) => lines.push(l),
            Err(_) => break,
        }
    }
    let _ = child.wait();
    Some(lines)
}

pub(crate) fn compute_used(usage: &Value) -> u64 {
    let g = |k: &str| usage.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    g("input_tokens") + g("cache_read_input_tokens") + g("output_tokens")
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

pub(crate) fn begin_turn(
    app: &AppHandle,
    session_id: &str,
    block_id: String,
    text: String,
    mode: TurnMode,
) {
    let (cwd, model_id, resume, effort, permission_mode, runtime) = {
        let engine = app.state::<Engine>();
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else {
            return;
        };
        // ResumeRetry forces resume off regardless of the stored id, so a still-good id
        // is never dropped preemptively — a fresh init overwrites it only on success.
        let resume = if mode == TurnMode::ResumeRetry {
            None
        } else {
            s.claude_session_id.clone()
        };
        (
            s.cwd.clone(),
            s.model_id.clone(),
            resume,
            s.effort.clone(),
            s.permission_mode.clone(),
            s.runtime.clone(),
        )
    };

    let resume_used = resume.is_some();

    if mode == TurnMode::Normal {
        let block = {
            let engine = app.state::<Engine>();
            let mut map = engine.sessions.lock().unwrap();
            match map.get_mut(session_id) {
                Some(s) => {
                    s.buf_user(&block_id, text.clone());
                    s.last_activity_at = now_ms();
                    s.block_buffer.last().cloned()
                }
                None => None,
            }
        };
        if let Some(b) = &block {
            append_transcript(app, session_id, b); // durable-sessions FR-2
        }
        emit(
            app,
            SessionEvent::MessageUser {
                session_id: session_id.into(),
                block_id: block_id.clone(),
                text: text.clone(),
            },
        );
    }

    let mut child = match spawn_claude(
        &cwd,
        &model_id,
        resume.as_deref(),
        &text,
        effort.as_deref(),
        &permission_mode,
        &runtime,
    ) {
        Ok(c) => c,
        Err(e) => {
            fail_session(
                app,
                session_id,
                "SPAWN_FAILED",
                &format!("could not start claude: {e}"),
            );
            return;
        }
    };
    // session-questions FR-2: the stdin writer joins the turn state for the whole
    // turn — the reader thread (denies) and session_answer_question (answers)
    // share it; it closes only when the turn ends.
    let stdin = Arc::new(Mutex::new(child.stdin.take()));
    let pending_questions: Arc<Mutex<HashMap<String, PendingQuestion>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let child = Arc::new(Mutex::new(child));
    let interrupted = Arc::new(AtomicBool::new(false));
    {
        let engine = app.state::<Engine>();
        let mut map = engine.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(session_id) {
            s.current = Some(TurnHandle {
                child: child.clone(),
                interrupted: interrupted.clone(),
                stdin: stdin.clone(),
                pending_questions: pending_questions.clone(),
                pending_permissions: pending_permissions.clone(),
            });
        }
    }

    let app2 = app.clone();
    let sid = session_id.to_string();
    // block_id/text carried into the reader so a resume-fail can re-run this turn fresh (FR-9).
    std::thread::spawn(move || {
        run_reader(
            app2,
            sid,
            child,
            interrupted,
            stdin,
            pending_questions,
            pending_permissions,
            model_id,
            resume_used,
            block_id,
            text,
        );
    });
}

/// Route turn completion (FR-20): drain the queue or go idle; or mark error.
pub(crate) fn finish_turn(
    app: &AppHandle,
    session_id: &str,
    errored: bool,
    error_msg: Option<String>,
) {
    let engine = app.state::<Engine>();
    // async-agents FR-16: every agent of this session still `running` is finalized
    // at turn end — 'error' when the turn errored (session-engine FR-40), else
    // 'done' — with endedAt and an `ended with the turn` notice step. This is the
    // backstop that keeps the elapsed clock correct when FR-13's notice never came.
    let (next, agent_ems): (Option<(String, String)>, Vec<AgentEmission>) = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else {
            return;
        };
        s.current = None;
        let agent_ems = finalize_agents(s, errored, now_ms());
        let next = if errored {
            s.status = "error".into();
            s.error_message = error_msg.clone();
            s.queue.clear();
            None
        } else if let Some(entry) = s.queue.pop_front() {
            Some(entry)
        } else {
            s.status = "idle".into();
            None
        };
        (next, agent_ems)
    };
    // Emitted BEFORE the turn's terminal session.status (FR-16), with no lock held.
    emit_agent_emissions(app, session_id, agent_ems);

    // Persist updated usage/activity/thread-id at turn boundary (durable-sessions FR-3).
    persist(app, &engine);

    // usage-bar FR-13: this session just left `running` (idle or error), so plan
    // usage moved — schedule the debounced app-scoped probe. Called with NO engine
    // lock held; usage state is a leaf that never reaches back into the engine.
    if errored || next.is_none() {
        crate::usage::note_turn_ended(app);
    }

    if errored {
        let msg = error_msg.unwrap_or_else(|| "session error".into());
        // (The agent.update for every agent just errored was emitted above by the
        // FR-16 finalization — one update per agent, carrying its notice step.)
        emit(
            app,
            SessionEvent::Error {
                session_id: session_id.into(),
                error: AppError {
                    code: "INTERNAL".into(),
                    message: msg,
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
pub(crate) fn apply_fail_session(s: &mut Session, msg: &str, at: u64) -> Vec<AgentEmission> {
    s.status = "error".into();
    s.error_message = Some(msg.to_string());
    s.current = None;
    s.queue.clear();
    finalize_agents(s, true, at)
}

pub(crate) fn fail_session(app: &AppHandle, session_id: &str, code: &str, msg: &str) {
    let agent_ems = {
        let engine = app.state::<Engine>();
        let mut map = engine.sessions.lock().unwrap();
        match map.get_mut(session_id) {
            Some(s) => apply_fail_session(s, msg, now_ms()),
            None => Vec::new(),
        }
    };
    crate::usage::note_turn_ended(app); // usage-bar FR-13: running → error

    // async-agents FR-16 ordering rule: agent finalization is emitted BEFORE the
    // turn's terminal session.error / session.status (mirrors finish_turn).
    emit_agent_emissions(app, session_id, agent_ems);
    emit(
        app,
        SessionEvent::Error {
            session_id: session_id.into(),
            error: AppError {
                code: code.into(),
                message: msg.into(),
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
    let engine = app.state::<Engine>();
    let mut map = engine.sessions.lock().unwrap();
    if let Some(s) = map.get_mut(session_id) {
        s.context_used_tokens = used;
        s.last_activity_at = now_ms();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

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
    fn compute_used_sums_input_cacheread_output() {
        let u =
            json!({ "input_tokens": 10, "cache_read_input_tokens": 21213, "output_tokens": 47 });
        assert_eq!(compute_used(&u), 21270);
    }

    #[test]
    fn turn_args_enable_stdio_control_channel_without_positional_prompt() {
        // FR-1: -p with NO positional prompt, plus the two new flags; every
        // pre-existing flag intact; permission-mode/effort/resume still appended.
        let args = turn_args("sonnet", Some("thread-1"), Some("high"), "plan");
        assert_eq!(args[0], "-p");
        assert!(
            args[1].starts_with("--"),
            "no positional prompt after -p: {args:?}"
        );
        let has_pair = |a: &str, b: &str| args.windows(2).any(|w| w[0] == a && w[1] == b);
        assert!(has_pair("--output-format", "stream-json"));
        assert!(has_pair("--input-format", "stream-json"));
        assert!(has_pair("--permission-prompt-tool", "stdio"));
        assert!(args.iter().any(|a| a == "--include-partial-messages"));
        assert!(args.iter().any(|a| a == "--verbose"));
        assert!(has_pair("--model", "sonnet"));
        assert!(has_pair("--permission-mode", "plan"));
        assert!(has_pair("--effort", "high"));
        assert!(has_pair("--resume", "thread-1"));
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
        let ems = apply_fail_session(&mut s, "spawn crashed", 9_000);

        assert_eq!(s.status, "error");
        assert_eq!(s.error_message.as_deref(), Some("spawn crashed"));

        let a = s.agents.get("a1").unwrap();
        assert_eq!(a.status, "error");
        assert_eq!(a.ended_at, Some(9_000));
        assert_eq!(a.last_activity.as_deref(), Some("ended with the turn"));

        // ordering: the notice step precedes the agent.update that carries it —
        // both must land before fail_session's own SessionEvent::Error/Status.
        assert_eq!(ems.len(), 2);
        assert!(matches!(ems[0], AgentEmission::Step { .. }));
        assert!(matches!(ems[1], AgentEmission::Update { .. }));
    }

    #[test]
    fn user_line_matches_wire_shape() {
        // §5.5: the turn text rides stdin as ONE NDJSON user line.
        let line = user_line("fix the bug");
        assert!(line.ends_with('\n'));
        let v: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(
            v,
            json!({ "type": "user", "message": { "role": "user",
                "content": [{ "type": "text", "text": "fix the bug" }] } })
        );
    }
}
