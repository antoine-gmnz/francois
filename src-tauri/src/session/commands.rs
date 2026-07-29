//! the session_* / conversation_* Tauri command surface.

use super::*;

use crate::ipc::{err, ok, IpcResult};
use crate::permissions::PermissionRule;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};

/// francois:conversation:getTranscript — owned by conversation-view (spec §5).
/// Returns the session's in-memory transcript buffer as ConversationBlock[].
#[tauri::command(async)]
pub fn conversation_get_transcript(
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Vec<Value>> {
    let map = engine.sessions.lock().unwrap();
    match map.get(&session_id) {
        None => err("SESSION_NOT_FOUND", "no such session"),
        Some(s) => ok(s.block_buffer.iter().map(classify_block).collect()),
    }
}

/// francois:session:pickDirectory — owned by sessions-sidebar (spec §5).
/// Opens the native OS directory dialog. `data: null` = user cancelled. A picked
/// item WITHOUT a filesystem path (shell-namespace nodes — e.g. the "Linux"
/// entry itself in Explorer's sidebar) is an ERROR, not a cancel: silently doing
/// nothing after a successful pick reads as a dead Browse button.
#[tauri::command(async)]
pub fn session_pick_directory(app: AppHandle) -> IpcResult<Option<Value>> {
    use tauri_plugin_dialog::DialogExt;
    match app.dialog().file().blocking_pick_folder() {
        Some(fp) => match fp.as_path().map(|p| p.to_string_lossy().to_string()) {
            Some(path) => ok(Some(serde_json::json!({ "path": path }))),
            None => err(
                "INVALID_INPUT",
                "that location has no filesystem path — pick a folder inside it, or paste its path (e.g. \\\\wsl$\\<distro>\\…) into the directory field",
            ),
        },
        None => ok(None),
    }
}

#[tauri::command(async)]
pub fn session_list(app: AppHandle, engine: State<'_, Engine>) -> IpcResult<Vec<Value>> {
    // FR-12: re-emit one session.meta per entry (registry order) before resolving.
    let metas: Vec<SessionMeta> = {
        let map = engine.sessions.lock().unwrap();
        map.values().map(|s| s.meta()).collect()
    };
    for m in &metas {
        emit(&app, SessionEvent::Meta { meta: m.clone() });
    }
    ok(metas
        .into_iter()
        .map(|m| serde_json::to_value(m).unwrap())
        .collect())
}

/// projects: the decision half of `session_create`'s post-insert TOCTOU re-check.
///
/// `project_remove` can commit and run its unlink between the pre-create link check
/// and the engine insert, which would leave a brand-new session pointing at a
/// project that no longer exists — self-healing only at the next launch (FR-18's
/// drop-on-load), so the live board would carry a dangling link all run.
///
/// Pure so the branching is testable: the handler owns the two lock acquisitions,
/// this owns the decision. Returns the project id to KEEP, or `None` to unlink.
pub(crate) fn toctou_outcome(project_id: Option<String>, still_linked: bool) -> Option<String> {
    project_id.filter(|_| still_linked)
}

#[tauri::command(async)]
pub fn session_create(
    app: AppHandle,
    engine: State<'_, Engine>,
    cwd: String,
    name: Option<String>,
    model_id: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    runtime: Option<String>,
    allow_git: Option<bool>,
    project_id: Option<String>,
) -> IpcResult<Value> {
    // FR-7: cwd must exist and be a directory.
    let meta = std::fs::metadata(&cwd);
    match meta {
        Ok(m) if m.is_dir() => {}
        _ => {
            return err(
                "INVALID_INPUT",
                "working directory does not exist or is not a directory",
            )
        }
    }
    // Model is chosen from the live list (session_models); accept any non-empty
    // id and let the CLI reject a truly invalid one at turn time. Being
    // permissive here is what keeps newly released models usable without a
    // redeploy.
    let model_id = model_id
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let permission_mode = permission_mode.unwrap_or_else(|| "default".to_string());
    if !valid_permission_mode(&permission_mode) {
        return err("INVALID_INPUT", "unknown permission mode");
    }
    let runtime = runtime.unwrap_or_else(|| "native".to_string());
    if !valid_runtime(&runtime) {
        return err("INVALID_INPUT", "unknown runtime");
    }
    if runtime == "wsl" && !cfg!(windows) {
        return err(
            "INVALID_INPUT",
            "the WSL runtime is only available on Windows",
        );
    }
    // FR-9: eager spawn check — verify the claude binary runs under the session's runtime.
    let (probe, probe_args) = claude_invocation(&runtime, &cwd, vec!["--version".to_string()]);
    let mut probe_cmd = Command::new(&probe);
    probe_cmd
        .args(&probe_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(path) = claude_path_env() {
        probe_cmd.env("PATH", path);
    }
    no_window(&mut probe_cmd);
    match probe_cmd.status() {
        Ok(s) if s.success() => {}
        Ok(_) if runtime == "wsl" => {
            return err("SPAWN_FAILED", "Claude Code CLI failed inside WSL. Run `claude` once in your WSL distro to install and authenticate it.")
        }
        Ok(_) => return err("SPAWN_FAILED", "Claude Code CLI exited with an error. Run `claude` once in a terminal to authenticate."),
        Err(_) if runtime == "wsl" => return err("SPAWN_FAILED", "WSL not found. Install it (wsl --install) or use the native runtime."),
        Err(_) => return err("SPAWN_FAILED", "Claude Code CLI not found. Install it and ensure `claude` is on PATH."),
    }

    // projects FR-19: a link must resolve to a live registry entry. The core does
    // NO auto-adoption and NO default merging — the frontend resolved the project
    // and applied its defaults, so what the modal showed is exactly what is created.
    // A blank string is treated as "unlinked" rather than as a bad id.
    let project_id = project_id.filter(|p| !p.trim().is_empty());
    if let Some(pid) = &project_id {
        if let Err((code, msg)) = crate::project::check_session_link(&app, pid) {
            return err(code, msg);
        }
    }

    let effort = effort.filter(|e| valid_effort(e));
    let now = now_ms();
    let id = uuid();
    let name = name.unwrap_or_else(|| basename(&cwd));
    let session = Session {
        id: id.clone(),
        name,
        cwd: cwd.clone(),
        model_id: model_id.clone(),
        status: "idle".into(),
        context_used_tokens: 0,
        context_limit_tokens: context_limit(&model_id),
        started_at: now,
        last_activity_at: now,
        error_message: None,
        effort,
        permission_mode,
        runtime,
        allow_git: allow_git.unwrap_or(false),
        project_id: project_id.clone(),
        queue: VecDeque::new(),
        claude_session_id: None,
        current: None,
        pending_probe: None,
        agents: HashMap::new(),
        agent_order: Vec::new(),
        agent_by_tool: HashMap::new(),
        agent_steps: HashMap::new(),
        agent_step_seq: HashMap::new(),
        agent_inner_tools: HashMap::new(),
        agent_backend_ref: HashMap::new(),
        agent_blocks: HashMap::new(),
        agent_block_seq: HashMap::new(),
        agent_blocks_dropped: HashMap::new(),
        block_buffer: Vec::new(),
        mcp: HashMap::new(),
        cli_commands: Vec::new(),
    };
    let meta_before = session.meta();
    engine.sessions.lock().unwrap().insert(id.clone(), session);

    // projects: close the TOCTOU window. `project_remove` can commit and run its
    // unlink between the link check above and this insert, leaving a session
    // pointing at a project that no longer exists. That self-heals only at the next
    // launch (FR-18's drop-on-load), so the live board would carry a dangling link
    // for the whole run. Re-check now that the session is visible and unlink it
    // here if the project went away. One registry read; the two locks never overlap.
    let still_linked = match &project_id {
        Some(pid) => crate::project::check_session_link(&app, pid).is_ok(),
        None => true, // an unlinked session has nothing to lose
    };
    let linked = toctou_outcome(project_id.clone(), still_linked);
    if linked.is_none() && project_id.is_some() {
        let mut map = engine.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(&id) {
            s.project_id = None;
        }
    }
    let meta = {
        let map = engine.sessions.lock().unwrap();
        map.get(&id).map(|s| s.meta()).unwrap_or(meta_before)
    };

    persist(&app, &engine);
    // projects FR-20: the project just backed a session. A persist failure here is
    // logged inside touch_last_used and IGNORED — it must never fail creation.
    if let Some(pid) = &linked {
        crate::project::touch_last_used(&app, pid);
    }
    emit(&app, SessionEvent::Meta { meta: meta.clone() });
    crate::diff::watch_session(&app, &id, &cwd); // FR-15: watch the session's cwd
    ok(serde_json::to_value(meta).unwrap())
}

#[tauri::command(async)]
pub fn session_remove(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Option<()>> {
    let removed = {
        let mut map = engine.sessions.lock().unwrap();
        map.remove(&session_id)
    };
    match removed {
        None => err("SESSION_NOT_FOUND", "no such session"),
        Some(session) => {
            if let Some(turn) = session.current {
                turn.interrupted.store(true, Ordering::SeqCst);
                let _ = turn.child.lock().unwrap().kill();
            }
            if let Some(p) = &session.pending_probe {
                p.kill(); // interactive-commands: the probe dies with the session (§7)
            }
            persist(&app, &engine);
            if let Some(path) = transcript_path(&app, &session_id) {
                let _ = std::fs::remove_file(path); // durable-sessions FR-11 (best-effort)
            }
            crate::diff::unwatch_session(&session_id); // FR-15: dispose the watcher
            crate::dispose_session_shell(&app, &session_id); // wsl-filesystem FR-13: dispose the shell
            emit(&app, SessionEvent::Removed { session_id });
            ok(None)
        }
    }
}

#[tauri::command(async)]
pub fn session_switch_model(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    model_id: String,
) -> IpcResult<Value> {
    if model_id.trim().is_empty() {
        return err("INVALID_INPUT", "model is empty");
    }
    {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        if s.status == "done" || s.status == "error" {
            return err("SESSION_NOT_RUNNING", "session has ended");
        }
    }
    match apply_model_switch(&app, &session_id, &model_id) {
        Some(meta) => ok(serde_json::to_value(meta).unwrap()),
        None => err("SESSION_NOT_FOUND", "no such session"),
    }
}

/// Shared switch semantics (francois:session:switchModel and `/model <arg>` —
/// interactive-commands FR-13): update the model + context limit, persist, emit
/// session.meta. The in-flight turn is unaffected. None if the session is gone.
pub(crate) fn apply_model_switch(
    app: &AppHandle,
    session_id: &str,
    model_id: &str,
) -> Option<SessionMeta> {
    let engine = app.state::<Engine>();
    let meta = {
        let mut map = engine.sessions.lock().unwrap();
        let s = map.get_mut(session_id)?;
        s.model_id = model_id.to_string();
        s.context_limit_tokens = context_limit(model_id);
        s.meta()
    };
    persist(app, &engine);
    emit(app, SessionEvent::Meta { meta: meta.clone() });
    Some(meta)
}

#[tauri::command(async)]
pub fn session_interrupt(engine: State<'_, Engine>, session_id: String) -> IpcResult<Option<()>> {
    let mut map = engine.sessions.lock().unwrap();
    let Some(s) = map.get_mut(&session_id) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    if s.status != "running" {
        return ok(None); // FR-23 no-op
    }
    if let Some(turn) = &s.current {
        turn.interrupted.store(true, Ordering::SeqCst);
        let _ = turn.child.lock().unwrap().kill();
    }
    // The turn's reader thread observes the kill, closes the open block, and
    // routes completion (drain queue or go idle) — FR-24. A pending question is
    // cancelled by the same reader-thread teardown (session-questions FR-13).
    ok(None)
}

/// francois:session:answerQuestion (session-questions FR-11/FR-12, §5.4).
/// Writes the §5.5 allow control_response (verbatim input + answers) to the
/// parked turn's stdin, then resolves the block as answered. Never resolves `ok`
/// unless the response reached the child's stdin.
#[tauri::command(async)]
pub fn session_answer_question(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    block_id: String,
    answers: HashMap<String, String>,
) -> IpcResult<Option<()>> {
    if answers.is_empty() {
        return err("INVALID_INPUT", "answers is empty");
    }
    // Snapshot the turn's shared handles, then RELEASE the sessions lock — the
    // stdin write below can block and must never stall every other command.
    let handles = {
        let map = engine.sessions.lock().unwrap();
        match map.get(&session_id) {
            None => return err("SESSION_NOT_FOUND", "no such session"),
            Some(s) => s
                .current
                .as_ref()
                .map(|t| (t.stdin.clone(), t.pending_questions.clone())),
        }
    };
    let Some((stdin, pending)) = handles else {
        // No turn in flight ⇒ nothing can be pending (turn over).
        return err("QUESTION_NOT_PENDING", "that question is no longer pending");
    };
    // Claim the entry — removal is the exactly-once guarantee (FR-13): a concurrent
    // cancel / turn-end that got there first already resolved this question.
    let claimed = {
        let mut p = pending.lock().unwrap();
        p.remove(&block_id)
    };
    let Some(q) = claimed else {
        return err("QUESTION_NOT_PENDING", "that question is no longer pending");
    };
    let answers_value = serde_json::to_value(&answers).unwrap_or_else(|_| serde_json::json!({}));
    let payload = allow_response(&q.request_id, &q.input, &answers_value);
    if !write_control_line(&stdin, &payload) {
        // §5.4: the child died between park and answer — FR-13 cancels the
        // question, and the caller learns it is no longer pending.
        resolve_question(&app, &session_id, &block_id, "cancelled", None);
        return err("QUESTION_NOT_PENDING", "that question is no longer pending");
    }
    resolve_question(
        &app,
        &session_id,
        &block_id,
        "answered",
        Some(&answers_value),
    );
    ok(None)
}

/// francois:permissions:decide (permission-guardrails FR-6..FR-9, §5.4).
///
/// Ordering matters and is spec'd (FR-7): an `*Always` decision writes the RULE
/// FIRST, and a write failure claims nothing, decides nothing and writes no
/// control_response — the card stays pending so the user can retry or fall back
/// to a once-decision. Nothing half-applies.
#[tauri::command(async)]
pub fn permissions_decide(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    block_id: String,
    decision: String,
    tier: Option<String>,
) -> IpcResult<Option<()>> {
    let Some((allow, remember)) = crate::permissions::decide_outcome(&decision) else {
        return err("INVALID_INPUT", "unknown decision");
    };
    // Snapshot the turn's shared handles, then RELEASE the sessions lock — the
    // stdin write below can block and must never stall every other command.
    let handles = {
        let map = engine.sessions.lock().unwrap();
        match map.get(&session_id) {
            None => return err("SESSION_NOT_FOUND", "no such session"),
            Some(s) => s
                .current
                .as_ref()
                .map(|t| (t.stdin.clone(), t.pending_permissions.clone())),
        }
    };
    let Some((stdin, pending)) = handles else {
        // No turn in flight ⇒ nothing can be pending (§7 #16).
        return err(
            "PERMISSION_NOT_PENDING",
            "that request is no longer pending",
        );
    };

    // FR-7: PEEK (don't claim) to learn the pattern, write the rule, and only
    // then claim. A concurrent decide could write the same rule twice — the merge
    // is idempotent (§7 #1) — but only one of them can claim the entry.
    let mut rule: Option<PermissionRule> = None;
    if remember {
        let pattern = {
            let p = pending.lock().unwrap();
            match p.get(&block_id) {
                Some(q) => q.ask.pattern.clone(),
                None => {
                    return err(
                        "PERMISSION_NOT_PENDING",
                        "that request is no longer pending",
                    )
                }
            }
        };
        // FR-6: local by default. VALIDATED — `tier_path` treats anything ≠
        // "global" as local, so an unvalidated string used to flow on into the
        // emitted PermissionRule's `tier`/`id`, violating the PermissionTier
        // union and minting an id `permissions_list` can never produce (so the
        // editor could never act on that rule).
        let tier = tier.unwrap_or_else(|| "local".into());
        if !crate::permissions::is_valid_tier(&tier) {
            return err("INVALID_INPUT", "unknown tier");
        }
        let path = match crate::permissions::tier_path(&engine, &session_id, &tier) {
            Ok(p) => p,
            Err((code, msg)) => return err(code, msg),
        };
        let effect = if allow { "allow" } else { "deny" };
        match crate::permissions::write_rule(&path, &tier, effect, &pattern) {
            Ok(r) => rule = Some(r),
            Err(msg) => return err("SETTINGS_WRITE_FAILED", msg),
        }
    }

    // FR-8: claim the entry — removal is the exactly-once guarantee (FR-10). A
    // concurrent cancel / turn-end that got there first already resolved this ask.
    let Some(q) = claim_pending(&pending, &block_id) else {
        // Lost the race after the rule was already written (the peek→claim gap).
        // The rule IS on disk and the card is about to render `cancelled`, so say
        // where it went rather than leaving it invisible until the editor is opened.
        if let Some(r) = &rule {
            eprintln!(
                "permission-guardrails: wrote rule {} but the request was cancelled first",
                r.id
            );
        }
        return err(
            "PERMISSION_NOT_PENDING",
            "that request is no longer pending",
        );
    };
    let payload = if allow {
        allow_tool_response(&q.request_id, &q.input) // FR-3: verbatim updatedInput
    } else {
        deny_response(&q.request_id, PERMISSION_DENY_MSG) // FR-12
    };
    if !write_control_line(&stdin, &payload) {
        // FR-9: the child died between park and decision. The rule (if any) was
        // already written, so it rides along on the cancelled resolution — FR-22's
        // "rule written: …" line must still render, or an "always allow" would
        // take effect on disk with no trace anywhere in the transcript.
        resolve_permission(&app, &session_id, &block_id, "cancelled", rule.as_ref());
        return err(
            "PERMISSION_NOT_PENDING",
            "that request is no longer pending",
        );
    }
    let state = if allow { "allowed" } else { "denied" };
    resolve_permission(&app, &session_id, &block_id, state, rule.as_ref());
    ok(None)
}

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
