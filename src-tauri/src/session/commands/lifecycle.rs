//! session lifecycle: create, remove, switch model, interrupt (specs/session-engine.md).

use crate::ipc::{err, err_detail, ok, IpcResult};
use crate::session::*;
use serde_json::Value;
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};

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

/// FR-7/13's cwd/model/permission_mode/runtime/wsl-gate validation ladder for
/// `session_create`. Pure aside from the FR-7 filesystem check. Returns the
/// normalized (model_id, permission_mode, runtime) or an (code, message) error.
///
/// `adopt` is session-worktree's `WorktreeCreateInput::adopt` (false when the
/// session carries no worktree input) — it only steers how the FR-7 check
/// resolves `cwd`, see below.
pub(crate) fn validate_create_input(
    cwd: &str,
    model_id: Option<String>,
    permission_mode: Option<String>,
    runtime: Option<String>,
    adopt: bool,
) -> Result<(String, String, String), (&'static str, &'static str)> {
    // FR-7: cwd must exist and be a directory.
    //
    // CRITICAL remediation: the FR-5 "already checked out" recovery flow calls
    // session_create with `cwd` = `probe.branchCheckedOutAt` — a path read back
    // from `git worktree list --porcelain`'s own stdout, which for a WSL repo is
    // a BARE Linux path (no `\\wsl$\<distro>\…` prefix). A plain
    // `std::fs::metadata` stat on Windows always fails INVALID_INPUT for that
    // path, even though the directory is perfectly real inside the distro.
    // Route the existence check the same way `resolve_worktree` will (via
    // `adopt_host`) instead of assuming every cwd is Windows-native.
    let precheck_host = adopt_host(cwd, adopt);
    let cwd_ok = match &precheck_host {
        crate::diff::GitHost::Native => matches!(std::fs::metadata(cwd), Ok(m) if m.is_dir()),
        crate::diff::GitHost::Wsl(_) => path_exists(&precheck_host, cwd),
    };
    if !cwd_ok {
        return Err((
            "INVALID_INPUT",
            "working directory does not exist or is not a directory",
        ));
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
        return Err(("INVALID_INPUT", "unknown permission mode"));
    }
    let runtime = runtime.unwrap_or_else(|| "native".to_string());
    if !valid_runtime(&runtime) {
        return Err(("INVALID_INPUT", "unknown runtime"));
    }
    if runtime == "wsl" && !cfg!(windows) {
        return Err((
            "INVALID_INPUT",
            "the WSL runtime is only available on Windows",
        ));
    }
    Ok((model_id, permission_mode, runtime))
}

/// FR-9: eager spawn check — verify the claude binary runs under the session's
/// runtime, before anything is created. Runs against the ORIGINAL cwd (the repo
/// path the modal probed), before session-worktree's `resolve_worktree`: a probe
/// failure here must not leave a worktree/branch behind (FR-11), and the probe
/// itself doesn't care which directory inside the repo it runs from.
pub(crate) fn probe_claude_binary(
    runtime: &str,
    cwd: &str,
) -> Result<(), (&'static str, &'static str)> {
    let (probe, probe_args) = claude_invocation(runtime, cwd, vec!["--version".to_string()], None);
    let mut probe_cmd = Command::new(&probe);
    probe_cmd
        .args(&probe_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(path) = claude_path_env() {
        probe_cmd.env("PATH", path);
    }
    crate::process_util::no_window(&mut probe_cmd);
    match probe_cmd.status() {
        Ok(s) if s.success() => Ok(()),
        Ok(_) if runtime == "wsl" => Err(("SPAWN_FAILED", "Claude Code CLI failed inside WSL. Run `claude` once in your WSL distro to install and authenticate it.")),
        Ok(_) => Err(("SPAWN_FAILED", "Claude Code CLI exited with an error. Run `claude` once in a terminal to authenticate.")),
        Err(_) if runtime == "wsl" => Err(("SPAWN_FAILED", "WSL not found. Install it (wsl --install) or use the native runtime.")),
        Err(_) => Err(("SPAWN_FAILED", "Claude Code CLI not found. Install it and ensure `claude` is on PATH.")),
    }
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
    worktree: Option<WorktreeCreateInput>,
) -> IpcResult<Value> {
    let adopt = worktree.as_ref().is_some_and(|w| w.adopt);
    let (model_id, permission_mode, runtime) =
        match validate_create_input(&cwd, model_id, permission_mode, runtime, adopt) {
            Ok(v) => v,
            Err((code, msg)) => return err(code, msg),
        };
    if let Err((code, msg)) = probe_claude_binary(&runtime, &cwd) {
        return err(code, msg);
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

    // session-worktree FR-5/FR-6/FR-11/FR-12: resolve LAST, only once every other
    // fallible validation (permission_mode, runtime, WSL availability, the FR-9
    // spawn probe, the project-link check) has passed. `resolve_worktree` is the
    // only step that mutates git state (a new worktree + branch); running it last
    // means a later validation failure never orphans that state (FR-11) — there
    // is nothing fallible left to run after it.
    let mut cwd = cwd;
    let mut session_worktree: Option<SessionWorktree> = None;
    let mut worktree_distro: Option<String> = None;
    if let Some(opts) = &worktree {
        match resolve_worktree(&cwd, opts) {
            Ok((actual_cwd, sw, distro)) => {
                cwd = actual_cwd;
                session_worktree = Some(sw);
                worktree_distro = distro;
            }
            Err((code, msg)) if code == "WORKTREE_BRANCH_IN_USE" => {
                return err_detail(
                    &code,
                    "that branch is already checked out at another path",
                    serde_json::json!({ "path": msg }),
                )
            }
            Err((code, msg)) => return err(&code, msg),
        }
    }

    let effort = effort.filter(|e| valid_effort(e));
    let now = now_ms();
    let id = uuid();
    let name = name.unwrap_or_else(|| basename(&cwd));
    let context_limit_tokens = context_limit(&model_id);
    let session = Session::new(
        id.clone(),
        name,
        cwd.clone(),
        model_id.clone(),
        0, // context_used_tokens
        context_limit_tokens,
        now, // started_at
        now, // last_activity_at
        effort,
        permission_mode,
        runtime,
        allow_git.unwrap_or(false),
        project_id.clone(),
        session_worktree,
        worktree_distro,
        None, // claude_session_id
        Vec::new(),
    );
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
        engine.with_session_mut(&id, |s| s.project_id = None);
    }
    let meta = engine
        .with_session(&id, |s| s.meta())
        .unwrap_or(meta_before);

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
    match engine.with_session(&session_id, |s| s.status != "done" && s.status != "error") {
        None => return err("SESSION_NOT_FOUND", "no such session"),
        Some(false) => return err("SESSION_NOT_RUNNING", "session has ended"),
        Some(true) => {}
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
    let meta = engine.with_session_mut(session_id, |s| {
        s.model_id = model_id.to_string();
        s.context_limit_tokens = context_limit(model_id);
        s.meta()
    })?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_input_rejects_missing_cwd() {
        let err = validate_create_input("/definitely/not/a/real/path/anywhere", None, None, None, false)
            .unwrap_err();
        assert_eq!(err.0, "INVALID_INPUT");
    }

    #[test]
    fn create_input_defaults_and_validates() {
        // A real directory every test runner has: the crate root.
        let cwd = env!("CARGO_MANIFEST_DIR");
        let (model_id, permission_mode, runtime) =
            validate_create_input(cwd, None, None, None, false).unwrap();
        assert_eq!(model_id, DEFAULT_MODEL);
        assert_eq!(permission_mode, "default");
        assert_eq!(runtime, "native");

        assert!(validate_create_input(cwd, None, Some("bogus".into()), None, false).is_err());
        assert!(validate_create_input(cwd, None, None, Some("bogus".into()), false).is_err());
    }
}
