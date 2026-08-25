//! session lifecycle: create, remove, switch model, interrupt (specs/session-engine.md).

use crate::ipc::{err, err_detail, ok, IpcResult};
use crate::session::*;
use serde_json::Value;
use std::process::{Command, Stdio};
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

/// session-rename FR-2: the name half of `session_create`'s validation, kept pure
/// so the fallback branching is testable. `Ok(None)` means "no usable name was
/// given" — the caller falls back to `basename(cwd)`, which is why a blank name
/// never fails creation. A non-blank name is cleaned and capped like any rename.
pub(crate) fn create_name(
    name: Option<String>,
) -> Result<Option<String>, (&'static str, &'static str)> {
    match name.filter(|n| !clean_session_name(n).is_empty()) {
        Some(raw) => validate_session_name(&raw).map(Some),
        None => Ok(None),
    }
}

/// session-rename FR-3/FR-4: the engine half of `session_rename` — swap the name
/// under the lock and hand back the updated snapshot. `None` when the id is
/// unknown, in which case nothing was mutated. Persist + emit stay in the handler
/// (they need the AppHandle), mirroring `apply_model_switch`.
pub(crate) fn rename_in_engine(
    engine: &Engine,
    session_id: &str,
    name: String,
) -> Option<SessionMeta> {
    engine.with_session_mut(session_id, |s| {
        s.name = name;
        s.meta()
    })
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
/// `config_dir` (multi-account FR-21): the chosen account's `CLAUDE_CONFIG_DIR`,
/// so the create-time probe runs under the very configuration the session's
/// turns will use — `None` for the built-in `default` account (no override).
pub(crate) fn probe_claude_binary(
    runtime: &str,
    cwd: &str,
    config_dir: Option<&str>,
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
    for (k, v) in account_env(config_dir, runtime, &[]) {
        probe_cmd.env(k, v);
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

/// session-profiles FR-11/FR-15: the profile-resolution decision for
/// `session_create` — pure so the `PROFILE_ARG_DENIED`/`PROFILE_NOT_FOUND`
/// branches are testable without a Tauri `AppHandle`/`State`. `lookup` is
/// `crate::profiles::find` at the call site (injected here so a test can stub
/// the registry); it's asked only when a `profile_id` was actually given.
#[derive(Debug)]
pub(crate) enum ProfileResolveError {
    ArgDenied { flag: String, reason: &'static str },
    NotFound,
}

pub(crate) fn resolve_profile_ref(
    extra_args: &[String],
    profile_id: Option<&str>,
    system_prompt_present: bool,
    lookup: impl FnOnce(&str) -> Option<(String, String)>,
) -> Result<Option<crate::profiles::SessionProfileRef>, ProfileResolveError> {
    if let Some((flag, reason)) = crate::profiles::check_denied(extra_args) {
        return Err(ProfileResolveError::ArgDenied { flag, reason });
    }
    match profile_id {
        Some(pid) => match lookup(pid) {
            Some((id, name)) => Ok(Some(crate::profiles::SessionProfileRef {
                id,
                name,
                // FR-17/FR-18: computed from THIS session's resolved prompt,
                // never the profile's own — editing a pre-filled field still
                // snapshots the profile identity, but the resolved values
                // are the truth.
                replaces_system_prompt: system_prompt_present,
            })),
            None => Err(ProfileResolveError::NotFound),
        },
        None => Ok(None),
    }
}

/// session-profiles FR-6 defense-in-depth: `session_create` receives the
/// FRONTEND'S resolved `systemPrompt`, not the profile-editor path that
/// `profiles::registry::normalize_prompt` bounds at save time — a
/// non-standard caller (CLI, a future API) could hand this command an
/// oversized prompt directly. Re-applying the same char-count bound here
/// means that case surfaces as `INVALID_INPUT` at creation instead of a
/// confusing `SPAWN_FAILED` once the CLI itself balks at the argv.
pub(crate) fn check_system_prompt_bound(
    system_prompt: &str,
) -> Result<(), (&'static str, &'static str)> {
    if system_prompt.chars().count() > crate::profiles::MAX_SYSTEM_PROMPT {
        return Err(("INVALID_INPUT", crate::profiles::BAD_PROMPT_MSG));
    }
    Ok(())
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
    account_id: Option<String>,
    worktree: Option<WorktreeCreateInput>,
    // session-profiles FR-15: the frontend sends the RESOLVED (post-edit)
    // values plus the profile id; the core snapshots the profile's name from
    // the registry itself, never trusting the caller for it.
    system_prompt: Option<String>,
    extra_args: Option<Vec<String>>,
    profile_id: Option<String>,
    // response-mode FR-1/FR-17: absent ⇒ 'default'. Re-validated here for the
    // same reason the switch verb re-validates (FR-3) — the frontend's
    // narrowing is not the gate.
    response_mode: Option<String>,
) -> IpcResult<Value> {
    let adopt = worktree.as_ref().is_some_and(|w| w.adopt);
    let response_mode = match response_mode {
        Some(raw) => match ResponseMode::parse(&raw) {
            Some(mode) => mode,
            None => return err("INVALID_INPUT", "unknown response mode"),
        },
        None => ResponseMode::Default,
    };
    let (model_id, permission_mode, runtime) =
        match validate_create_input(&cwd, model_id, permission_mode, runtime, adopt) {
            Ok(v) => v,
            Err((code, msg)) => return err(code, msg),
        };
    // session-rename FR-2: validate the name here — pure, and BEFORE anything is
    // spawned or a worktree is created, so an over-cap name orphans no git state.
    // The basename(cwd) fallback is still applied below, against the post-worktree
    // cwd, which is why this only decides the "a name was given" case.
    let name = match create_name(name) {
        Ok(n) => n,
        Err((code, msg)) => return err(code, msg),
    };

    // multi-account FR-18: resolve the account BEFORE anything is spawned or
    // created — an unknown id creates no session at all, and the create-time
    // probe below must run under the very config dir the turns will use (FR-21).
    let account_id = match crate::account::resolve_new_session_account(&app, account_id.as_deref())
    {
        Ok(id) => id,
        Err((code, msg)) => return err(code, msg),
    };
    let account_config_dir = crate::account::config_dir_of(&app, &account_id);
    // FR-25: a WSL session reaches its config dir through `WSLENV`'s `/p` path
    // translation, which only works for a drive-letter path. Fail at creation,
    // NAMING the account, rather than spawning a claude that would silently use
    // a different configuration inside the distro.
    if runtime == "wsl" {
        if let Some(dir) = account_config_dir
            .as_deref()
            .filter(|d| !crate::account::wsl_translatable_config_dir(d))
        {
            let label =
                crate::account::label_of(&app, &account_id).unwrap_or_else(|| account_id.clone());
            return err(
                "INVALID_INPUT",
                format!(
                    "account {label} keeps its Claude Code configuration at {dir}, which WSL \
                     cannot translate — use the native runtime for this account"
                ),
            );
        }
    }

    // multi-provider-codex FR-5: this preflight runs `claude --version` with the
    // account's dir as CLAUDE_CONFIG_DIR. On a non-Claude account it checks the
    // WRONG BINARY — and worse, `claude` initializes whatever config dir it is
    // pointed at, so it seeds a Codex account's CODEX_HOME with a full Claude
    // profile (`.claude.json`, `projects/`, `sessions/`) the moment a session is
    // created. Each runtime's own preflight is its adapter's
    // (`SessionAdapter::preflight`), which is where the Codex auth check lives.
    if crate::account::kind_of(&app, &account_id) == crate::account::AccountKind::ClaudeCodeOauth {
        if let Err((code, msg)) = probe_claude_binary(&runtime, &cwd, account_config_dir.as_deref())
        {
            return err(code, msg);
        }
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

    // Edge case §7: a systemPrompt present but whitespace-only is treated as
    // absent — no `--system-prompt`, `replacesSystemPrompt: false` (FR-17).
    let system_prompt = system_prompt.filter(|s| !s.trim().is_empty());
    // session-profiles FR-6 defense-in-depth: re-bound a systemPrompt that
    // reached this command directly rather than through the profile editor
    // (see `check_system_prompt_bound`).
    if let Some(sp) = &system_prompt {
        if let Err((code, msg)) = check_system_prompt_bound(sp) {
            return err(code, msg);
        }
    }

    // session-profiles FR-11: re-run the FR-9 denylist over the RESOLVED
    // `extraArgs` this call received — the frontend is not trusted with the
    // parser contract. FR-15: a profileId must resolve to a live registry
    // entry; the core snapshots the NAME itself, never trusting the caller's
    // copy — a deleted-then-recreated id would otherwise mismatch (FR-22).
    let extra_args = extra_args.unwrap_or_default();
    let profile_id = profile_id.filter(|p| !p.trim().is_empty());
    let profile_ref = match resolve_profile_ref(
        &extra_args,
        profile_id.as_deref(),
        system_prompt.is_some(),
        |pid| crate::profiles::find(&app, pid).map(|p| (p.id, p.name)),
    ) {
        Ok(profile_ref) => profile_ref,
        Err(ProfileResolveError::ArgDenied { flag, reason }) => {
            return err_detail(
                "PROFILE_ARG_DENIED",
                format!("{flag} is not allowed in a session's extra args: {reason}"),
                serde_json::json!({ "flag": flag, "reason": reason }),
            )
        }
        Err(ProfileResolveError::NotFound) => return err("PROFILE_NOT_FOUND", "no such profile"),
    };

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
    // multi-provider-seam FR-13a: both axes derived from the resolved
    // account's kind — session_create gains no field and the new-session
    // modal gains no control.
    let (agent_runtime, protocol) =
        AgentRuntime::from_account_kind(crate::account::kind_of(&app, &account_id));
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
        account_id, // multi-account FR-19: stored VERBATIM, never re-derived
        agent_runtime,
        protocol,
        None, // claude_session_id
        Vec::new(),
        system_prompt,
        extra_args,
        profile_ref,
        response_mode,
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
                // multi-provider-seam FR-8: reached only through TurnControl.
                turn.interrupt();
                turn.kill();
            }
            if let Some(p) = &session.pending_probe {
                p.kill(); // interactive-commands: the probe dies with the session (§7)
            }
            // session-attachments FR-16: delete every file THIS session created
            // under its attachments dir, then the dir if that emptied it. Only
            // its own records are touched — a copied: false origin (and another
            // session sharing the short-id folder) is left alone.
            // Coverage: `purge_session` is unit-tested directly against a temp
            // dir (attachments::retention). This call site is not, matching the
            // rest of this file — no Tauri command here is, since the core wires
            // up no AppHandle test harness and adding one for a single line
            // would introduce a pattern nothing else in the module follows.
            purge_session(&session.cwd, &session_id, &session.attachments);
            persist(&app, &engine);
            if let Some(path) = transcript_path(&app, &session_id) {
                let _ = std::fs::remove_file(path); // durable-sessions FR-11 (best-effort)
            }
            crate::diff::unwatch_session(&session_id); // FR-15: dispose the watcher
                                                       // workflow-details FR-6: the run directories of a removed session are
                                                       // no longer watched, and the asks attributed to its runs go with it.
            unwatch_session_workflows(&engine, &session.workflow_order);
            crate::dispose_session_shells(&app, &session_id); // wsl-filesystem FR-13/multiple-shells FR-9: dispose every shell
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
    match engine.with_session(&session_id, |s| !status::is_terminal(&s.status)) {
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

/// session-permission-mode FR-2: `francois:session:switchPermissionMode`'s enum
/// re-validation. The core never trusts the frontend's narrowing — a value
/// outside `PermissionMode` (an older frontend, the CLI, an extension) yields
/// `None` so the command answers `INVALID_INPUT` rather than silently falling
/// back to `default`. Mirrors `valid_permission_mode` (session/spawn.rs), which
/// stays the create-time check; this one hands back the canonical `&'static
/// str` the switch stores, matching the shape the spec names.
pub(crate) fn parse_permission_mode(mode: &str) -> Option<&'static str> {
    match mode {
        "default" => Some("default"),
        "plan" => Some("plan"),
        "acceptEdits" => Some("acceptEdits"),
        "bypassPermissions" => Some("bypassPermissions"),
        _ => None,
    }
}

/// session-permission-mode FR-1/FR-2/FR-3: the engine half of
/// `session_switch_permission_mode` — the status-terminal guard (a session
/// that can take no further turn has nothing for a next-turn setting to act
/// on) plus the mutation, kept pure like `rename_in_engine` so both are
/// testable without an `AppHandle` (persist + emit stay in the handler).
/// Setting the mode the session already has is deliberately NOT special-cased
/// (FR-3): same mutation, same `Ok`.
pub(crate) fn switch_permission_mode_in_engine(
    engine: &Engine,
    session_id: &str,
    mode: &str,
) -> Result<SessionMeta, (&'static str, &'static str)> {
    match engine.with_session(session_id, |s| !status::is_terminal(&s.status)) {
        None => return Err(("SESSION_NOT_FOUND", "no such session")),
        Some(false) => return Err(("SESSION_NOT_RUNNING", "session has ended")),
        Some(true) => {}
    }
    engine
        .with_session_mut(session_id, |s| {
            // rework-top-bar (design 11c): stamped on EVERY write, including the
            // no-op re-pick FR-3 deliberately does not special-case. "On since"
            // means "since you last said so", not "since it last changed" — a
            // re-affirmed bypass is a fresh decision, and dating it from the
            // original one would understate how long it has been live.
            s.permission_mode = mode.to_string();
            s.permission_mode_since = now_ms();
            s.meta()
        })
        .ok_or(("SESSION_NOT_FOUND", "no such session"))
}

/// rework-top-bar (design 11c): the engine half of `session_switch_effort` — the
/// twin of `switch_permission_mode_in_engine`, and pure for the same reason
/// (testable without an `AppHandle`; persist + emit stay in the handler).
///
/// `None` clears the level, which is a real choice and not an error: it hands the
/// model back its own default, which is exactly what a model advertising no effort
/// levels runs at. The value is re-validated here rather than trusted from the
/// frontend, mirroring `parse_permission_mode` — the same argument applies (an
/// older frontend, the CLI, an extension), and an unknown level would otherwise
/// reach the CLI as `--effort <garbage>` and fail the whole turn instead of one
/// command.
pub(crate) fn switch_effort_in_engine(
    engine: &Engine,
    session_id: &str,
    effort: Option<&str>,
) -> Result<SessionMeta, (&'static str, &'static str)> {
    match engine.with_session(session_id, |s| !status::is_terminal(&s.status)) {
        None => return Err(("SESSION_NOT_FOUND", "no such session")),
        Some(false) => return Err(("SESSION_NOT_RUNNING", "session has ended")),
        Some(true) => {}
    }
    engine
        .with_session_mut(session_id, |s| {
            s.effort = effort.map(String::from);
            s.meta()
        })
        .ok_or(("SESSION_NOT_FOUND", "no such session"))
}

/// rework-top-bar (design 11c): `francois:session:switchEffort`. Same shape and
/// same error ladder as `session_switch_permission_mode` — set the field, persist,
/// emit one `session.meta`, resolve the snapshot that event carries. Like the
/// permission mode it reaches only the NEXT turn: the in-flight turn already
/// carries its own `effort` copy on its `TurnContext` snapshot (session/turn.rs),
/// so nothing is signalled and no stdin is written.
///
/// An absent/blank `effort` clears the level. A non-blank one outside
/// `valid_effort` is `INVALID_INPUT` — never a silent fall back to the default,
/// which would look like the pick simply did not take.
#[tauri::command(async)]
pub fn session_switch_effort(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    effort: Option<String>,
) -> IpcResult<Value> {
    let level = effort
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty());
    if let Some(e) = &level {
        if !valid_effort(e) {
            return err("INVALID_INPUT", "unknown effort level");
        }
    }
    let meta = match switch_effort_in_engine(&engine, &session_id, level.as_deref()) {
        Ok(meta) => meta,
        Err((code, msg)) => return err(code, msg),
    };
    persist(&app, &engine);
    emit(&app, SessionEvent::Meta { meta: meta.clone() });
    ok(serde_json::to_value(meta).unwrap())
}

/// session-permission-mode FR-1: `francois:session:switchPermissionMode`.
/// Semantics and code shape mirror `apply_model_switch` — set the field,
/// persist with the existing atomic write, emit one `session.meta`, resolve
/// the same snapshot the event carries. FR-2's error ladder: `INVALID_INPUT`
/// for a `mode` outside `PermissionMode`, `SESSION_NOT_FOUND` /
/// `SESSION_NOT_RUNNING` from `switch_permission_mode_in_engine`. FR-6: no
/// process is signalled and no stdin is written — a running turn already
/// carries its own `permission_mode` copy on its `TurnContext` snapshot
/// (session/turn.rs), so this mutation only ever reaches the NEXT turn.
#[tauri::command(async)]
pub fn session_switch_permission_mode(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    mode: String,
) -> IpcResult<Value> {
    let Some(mode) = parse_permission_mode(&mode) else {
        return err("INVALID_INPUT", "unknown permission mode");
    };
    let meta = match switch_permission_mode_in_engine(&engine, &session_id, mode) {
        Ok(meta) => meta,
        Err((code, msg)) => return err(code, msg),
    };
    persist(&app, &engine);
    emit(&app, SessionEvent::Meta { meta: meta.clone() });
    ok(serde_json::to_value(meta).unwrap())
}

/// response-mode FR-2/FR-3: the engine half of `session_switch_response_mode` —
/// the twin of `switch_permission_mode_in_engine` (same terminal-status guard,
/// same purity: persist + emit stay in the handler, which needs the AppHandle).
/// Re-picking the mode the session already has is deliberately NOT special-cased
/// (FR-3): same mutation, same `Ok`, same emission.
///
/// `response_mode_sent` is left alone here on purpose. It records what the
/// CURRENT codex/grok thread has been told, and a switch tells the thread
/// nothing — the next turn's prefix decision (FR-10/FR-11) is exactly the
/// comparison between the two.
pub(crate) fn switch_response_mode_in_engine(
    engine: &Engine,
    session_id: &str,
    mode: ResponseMode,
) -> Result<SessionMeta, (&'static str, &'static str)> {
    match engine.with_session(session_id, |s| !status::is_terminal(&s.status)) {
        None => return Err(("SESSION_NOT_FOUND", "no such session")),
        Some(false) => return Err(("SESSION_NOT_RUNNING", "session has ended")),
        Some(true) => {}
    }
    engine
        .with_session_mut(session_id, |s| {
            s.response_mode = mode;
            s.meta()
        })
        .ok_or(("SESSION_NOT_FOUND", "no such session"))
}

/// response-mode FR-2: `francois:session:switchResponseMode`. Semantics and code
/// shape mirror `session_switch_permission_mode` — set the field, persist with
/// the existing atomic write, emit one `session.meta`, resolve the same snapshot
/// that event carries. FR-3's error ladder: `INVALID_INPUT` for a `mode` outside
/// `ResponseMode` (re-validated here, never trusted from the frontend's
/// narrowing), `SESSION_NOT_FOUND` / `SESSION_NOT_RUNNING` from the engine half.
///
/// FR-4: no process is signalled and nothing is written to a running child — a
/// turn keeps the mode it was spawned with, because `TurnContext` carries its
/// own snapshot (session/turn.rs). The switch only ever reaches the NEXT turn.
#[tauri::command(async)]
pub fn session_switch_response_mode(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    mode: String,
) -> IpcResult<Value> {
    let Some(mode) = ResponseMode::parse(&mode) else {
        return err("INVALID_INPUT", "unknown response mode");
    };
    let meta = match switch_response_mode_in_engine(&engine, &session_id, mode) {
        Ok(meta) => meta,
        Err((code, msg)) => return err(code, msg),
    };
    persist(&app, &engine);
    emit(&app, SessionEvent::Meta { meta: meta.clone() });
    ok(serde_json::to_value(meta).unwrap())
}

/// session-rename FR-3/FR-4/FR-5: `francois:session:rename`. Validates the raw
/// input (FR-1), swaps the name, persists with the existing atomic write and emits
/// `session.meta` — the frontend's single update path. Accepted in EVERY status:
/// the name touches no process, no PTY, no claude session id and no worktree
/// branch (§2 non-goals), so there is no `SESSION_NOT_RUNNING` path here.
#[tauri::command(async)]
pub fn session_rename(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    name: String,
) -> IpcResult<Value> {
    let name = match validate_session_name(&name) {
        Ok(n) => n,
        Err((code, msg)) => return err(code, msg),
    };
    let Some(meta) = rename_in_engine(&engine, &session_id, name) else {
        return err("SESSION_NOT_FOUND", "session not found");
    };
    // FR-6: renaming to the identical name takes this same path — persisting and
    // emitting is idempotent, and a divergent no-op branch would only add states.
    persist(&app, &engine);
    emit(&app, SessionEvent::Meta { meta: meta.clone() });
    ok(serde_json::to_value(meta).unwrap())
}

#[tauri::command(async)]
pub fn session_interrupt(engine: State<'_, Engine>, session_id: String) -> IpcResult<Option<()>> {
    let mut map = engine.sessions.lock().unwrap();
    let Some(s) = map.get_mut(&session_id) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    // is_busy, not `== running`: interrupting a turn parked on an approval or a
    // question is exactly when the brake matters most — the user has decided they
    // want out rather than to answer. The reader-thread teardown cancels the
    // pending ask (session-questions FR-13).
    if !status::is_busy(&s.status) {
        return ok(None); // FR-23 no-op
    }
    if let Some(turn) = &s.current {
        // multi-provider-seam FR-8: reached only through TurnControl.
        turn.interrupt();
        turn.kill();
    }
    // The turn's reader thread observes the kill, closes the open block, and
    // routes completion (drain queue or go idle) — FR-24. A pending question is
    // cancelled by the same reader-thread teardown (session-questions FR-13).
    ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::{test_engine_with, test_session};

    #[test]
    fn create_input_rejects_missing_cwd() {
        let err = validate_create_input(
            "/definitely/not/a/real/path/anywhere",
            None,
            None,
            None,
            false,
        )
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

    // ---------- session-permission-mode ----------

    #[test]
    fn parse_permission_mode_accepts_all_four_members_and_rejects_the_rest() {
        for m in ["default", "plan", "acceptEdits", "bypassPermissions"] {
            assert_eq!(parse_permission_mode(m), Some(m));
        }
        // FR-2: an older frontend, the CLI or an extension sending a stale/bogus
        // string never falls back to 'default' silently.
        for bogus in ["auto", "dontAsk", "", "Default", "bypass"] {
            assert_eq!(parse_permission_mode(bogus), None);
        }
    }

    #[test]
    fn switch_permission_mode_in_engine_mutates_and_returns_the_updated_meta() {
        // FR-1: the returned SessionMeta is exactly what the accompanying
        // session.meta emission carries.
        let engine = test_engine_with(test_session());
        let meta = switch_permission_mode_in_engine(&engine, "s1", "bypassPermissions").unwrap();
        assert_eq!(meta.permission_mode, "bypassPermissions");
        assert_eq!(
            engine.with_session("s1", |s| s.permission_mode.clone()),
            Some("bypassPermissions".to_string())
        );
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(json["permissionMode"], "bypassPermissions");
    }

    #[test]
    fn switch_permission_mode_in_engine_is_a_no_op_success_for_the_current_mode() {
        // FR-3: picking the mode already set is a success, no special-casing.
        let engine = test_engine_with(test_session()); // starts "default"
        let meta = switch_permission_mode_in_engine(&engine, "s1", "default").unwrap();
        assert_eq!(meta.permission_mode, "default");
    }

    #[test]
    fn switch_permission_mode_in_engine_rejects_an_unknown_session() {
        // FR-2: SESSION_NOT_FOUND.
        let engine = test_engine_with(test_session());
        let Err(err) = switch_permission_mode_in_engine(&engine, "nope", "plan") else {
            panic!("expected an error");
        };
        assert_eq!(err.0, "SESSION_NOT_FOUND");
        assert_eq!(
            engine.with_session("s1", |s| s.permission_mode.clone()),
            Some("default".to_string())
        );
    }

    #[test]
    fn switch_permission_mode_in_engine_rejects_a_terminal_session() {
        // FR-2: a session that can take no further turn has nothing for a
        // next-turn setting to act on — same rule session_send already applies.
        let mut session = test_session();
        session.status = status::DONE.into();
        let engine = test_engine_with(session);
        let Err(err) = switch_permission_mode_in_engine(&engine, "s1", "plan") else {
            panic!("expected an error");
        };
        assert_eq!(err.0, "SESSION_NOT_RUNNING");
        // Nothing was mutated.
        assert_eq!(
            engine.with_session("s1", |s| s.permission_mode.clone()),
            Some("default".to_string())
        );
    }

    #[test]
    fn switch_permission_mode_in_engine_stamps_the_since_clock() {
        // rework-top-bar (design 11c): the `on since` line under `bypass` reads
        // this. It moves forward on every write, including the FR-3 no-op re-pick.
        let mut session = test_session();
        session.permission_mode_since = 1;
        let engine = test_engine_with(session);

        let meta = switch_permission_mode_in_engine(&engine, "s1", "bypassPermissions").unwrap();
        assert!(meta.permission_mode_since > 1);
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(json["permissionModeSince"], meta.permission_mode_since);

        let first = meta.permission_mode_since;
        engine.with_session_mut("s1", |s| s.permission_mode_since = first - 5_000);
        let again = switch_permission_mode_in_engine(&engine, "s1", "bypassPermissions").unwrap();
        assert!(again.permission_mode_since >= first);
    }

    // ---------- response-mode: the response-mode switch (FR-2/FR-3) ----------

    #[test]
    fn switch_response_mode_in_engine_mutates_and_returns_the_updated_meta() {
        let engine = test_engine_with(test_session());

        let meta = switch_response_mode_in_engine(&engine, "s1", ResponseMode::Concise).unwrap();
        assert_eq!(meta.response_mode, ResponseMode::Concise);
        assert_eq!(
            engine.with_session("s1", |s| s.response_mode),
            Some(ResponseMode::Concise)
        );
        // FR-2: the resolved snapshot is the very one `session.meta` carries.
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(json["responseMode"], "concise");
    }

    #[test]
    fn switch_response_mode_in_engine_is_a_no_op_success_for_the_current_mode() {
        // FR-3: re-picking the current mode is a no-op SUCCESS — not special-cased.
        let engine = test_engine_with(test_session());
        let meta = switch_response_mode_in_engine(&engine, "s1", ResponseMode::Default).unwrap();
        assert_eq!(meta.response_mode, ResponseMode::Default);
    }

    #[test]
    fn switch_response_mode_in_engine_never_touches_what_the_thread_was_told() {
        // FR-10: `response_mode_sent` records what reached the CHILD; a switch
        // reaches no child (FR-4), so it must leave the field alone — that
        // difference is exactly what the next turn's prefix decision reads.
        let mut session = test_session();
        session.response_mode_sent = Some(ResponseMode::Concise);
        let engine = test_engine_with(session);

        switch_response_mode_in_engine(&engine, "s1", ResponseMode::Default).unwrap();
        assert_eq!(
            engine.with_session("s1", |s| s.response_mode_sent),
            Some(Some(ResponseMode::Concise))
        );
    }

    #[test]
    fn switch_response_mode_in_engine_rejects_an_unknown_session() {
        let engine = test_engine_with(test_session());
        let Err(err) = switch_response_mode_in_engine(&engine, "nope", ResponseMode::Concise)
        else {
            panic!("expected an error");
        };
        assert_eq!(err.0, "SESSION_NOT_FOUND");
    }

    #[test]
    fn switch_response_mode_in_engine_rejects_a_terminal_session() {
        // FR-3: a session that can take no further turn has nothing for a
        // next-turn setting to act on.
        for status in ["done", "error"] {
            let mut session = test_session();
            session.status = status.into();
            let engine = test_engine_with(session);
            let Err(err) = switch_response_mode_in_engine(&engine, "s1", ResponseMode::Concise)
            else {
                panic!("expected an error");
            };
            assert_eq!(err.0, "SESSION_NOT_RUNNING");
            // The session is untouched.
            assert_eq!(
                engine.with_session("s1", |s| s.response_mode),
                Some(ResponseMode::Default)
            );
        }
    }

    // ---------- rework-top-bar: the effort switch (design 11c) ----------

    #[test]
    fn switch_effort_in_engine_sets_and_clears_the_level() {
        let engine = test_engine_with(test_session());

        let meta = switch_effort_in_engine(&engine, "s1", Some("high")).unwrap();
        assert_eq!(meta.effort.as_deref(), Some("high"));
        assert_eq!(
            engine.with_session("s1", |s| s.effort.clone()),
            Some(Some("high".to_string()))
        );
        // Absent (never null) on the wire when set, present when cleared — the
        // same omit-not-null convention projectId uses.
        assert_eq!(serde_json::to_value(&meta).unwrap()["effort"], "high");

        let cleared = switch_effort_in_engine(&engine, "s1", None).unwrap();
        assert_eq!(cleared.effort, None);
        assert!(serde_json::to_value(&cleared)
            .unwrap()
            .get("effort")
            .is_none());
    }

    #[test]
    fn switch_effort_in_engine_rejects_an_unknown_or_terminal_session() {
        let engine = test_engine_with(test_session());
        let Err(unknown) = switch_effort_in_engine(&engine, "nope", Some("high")) else {
            panic!("expected an error");
        };
        assert_eq!(unknown.0, "SESSION_NOT_FOUND");
        assert_eq!(engine.with_session("s1", |s| s.effort.clone()), Some(None));

        let mut done = test_session();
        done.status = status::DONE.into();
        let engine = test_engine_with(done);
        let Err(terminal) = switch_effort_in_engine(&engine, "s1", Some("high")) else {
            panic!("expected an error");
        };
        assert_eq!(terminal.0, "SESSION_NOT_RUNNING");
        assert_eq!(engine.with_session("s1", |s| s.effort.clone()), Some(None));
    }

    #[test]
    fn valid_effort_is_the_gate_the_switch_command_applies() {
        // The handler answers INVALID_INPUT for anything outside this set rather
        // than falling back to the model default — a silent fallback reads as
        // "the pick did not take".
        for level in ["low", "medium", "high", "xhigh", "max"] {
            assert!(valid_effort(level));
        }
        assert!(!valid_effort("HIGH"));
        assert!(!valid_effort("turbo"));
        assert!(!valid_effort(""));
    }

    // ---------- session-rename ----------

    #[test]
    fn create_name_falls_back_for_a_blank_or_absent_name() {
        // FR-2: None, whitespace-only and control-only all mean "use basename(cwd)",
        // which the caller applies when this returns None. Creation never fails here.
        assert_eq!(create_name(None).unwrap(), None);
        assert_eq!(create_name(Some("   ".into())).unwrap(), None);
        assert_eq!(create_name(Some("\n\t".into())).unwrap(), None);
    }

    #[test]
    fn create_name_cleans_and_caps() {
        assert_eq!(
            create_name(Some("  api\nrefactor ".into())).unwrap(),
            // Stripped, not replaced by a space — FR-1 step 1 is a filter.
            Some("apirefactor".to_string())
        );
        let (code, _) = create_name(Some("a".repeat(81))).unwrap_err();
        assert_eq!(code, "INVALID_INPUT");
        assert_eq!(
            create_name(Some("a".repeat(80))).unwrap(),
            Some("a".repeat(80))
        );
    }

    #[test]
    fn rename_in_engine_mutates_and_returns_the_updated_meta() {
        // FR-4: the returned SessionMeta is the post-rename snapshot, and it is
        // exactly what the accompanying session.meta emission carries.
        let engine = test_engine_with(test_session());
        let meta = rename_in_engine(&engine, "s1", "shipping lane".into()).unwrap();
        assert_eq!(meta.name, "shipping lane");
        assert_eq!(
            engine.with_session("s1", |s| s.name.clone()),
            Some("shipping lane".to_string())
        );
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(json["name"], "shipping lane");
        assert_eq!(json["id"], "s1");
    }

    #[test]
    fn rename_in_engine_is_none_for_an_unknown_id_and_mutates_nothing() {
        // FR-3.
        let engine = test_engine_with(test_session());
        assert!(rename_in_engine(&engine, "nope", "x".into()).is_none());
        assert_eq!(
            engine.with_session("s1", |s| s.name.clone()),
            Some("n".into())
        );
    }

    #[test]
    fn rename_touches_no_process_state_in_any_status() {
        // FR-5/FR-6: allowed while running, and renaming to the same name is a
        // normal success. Nothing but `name` changes.
        for status in ["idle", "running", "error"] {
            let mut s = test_session();
            s.status = status.into();
            s.claude_session_id = Some("claude-1".into());
            let engine = test_engine_with(s);
            let meta = rename_in_engine(&engine, "s1", "n".into()).unwrap();
            assert_eq!(meta.name, "n");
            assert_eq!(meta.status, status);
            assert_eq!(
                engine.with_session("s1", |s| s.claude_session_id.clone()),
                Some(Some("claude-1".into()))
            );
            assert_eq!(
                engine.with_session("s1", |s| s.worktree.is_none()),
                Some(true)
            );
        }
    }

    // ---------- session-profiles: session_create's profile resolution ----------

    #[test]
    fn resolve_profile_ref_denies_a_flag_in_the_resolved_extra_args() {
        // FR-11: re-run the denylist over what `session_create` actually
        // received, regardless of any profile_id.
        let err = resolve_profile_ref(
            &["--model".to_string(), "opus".to_string()],
            None,
            false,
            |_| panic!("lookup must not run once the denylist has already failed"),
        )
        .expect_err("denied");
        match err {
            ProfileResolveError::ArgDenied { flag, reason } => {
                assert_eq!(flag, "--model");
                assert!(!reason.is_empty());
            }
            ProfileResolveError::NotFound => panic!("expected ArgDenied"),
        }
    }

    #[test]
    fn resolve_profile_ref_reports_not_found_for_an_unresolved_profile_id() {
        // FR-15: an unresolved profileId refuses creation entirely.
        let err = resolve_profile_ref(&[], Some("ghost"), false, |_| None).expect_err("not found");
        assert!(matches!(err, ProfileResolveError::NotFound));
    }

    #[test]
    fn resolve_profile_ref_snapshots_the_looked_up_identity() {
        // FR-15/FR-17: the id/name come from the registry lookup, never the
        // caller; replaces_system_prompt mirrors THIS session's resolved prompt.
        let profile_ref = resolve_profile_ref(&[], Some("p1"), true, |pid| {
            assert_eq!(pid, "p1");
            Some(("p1".to_string(), "role-architect".to_string()))
        })
        .unwrap()
        .expect("resolved");
        assert_eq!(profile_ref.id, "p1");
        assert_eq!(profile_ref.name, "role-architect");
        assert!(profile_ref.replaces_system_prompt);
    }

    #[test]
    fn resolve_profile_ref_is_none_without_a_profile_id() {
        let profile_ref = resolve_profile_ref(&[], None, false, |_| {
            panic!("lookup must not run without a profile_id")
        })
        .unwrap();
        assert!(profile_ref.is_none());
    }

    #[test]
    fn check_system_prompt_bound_rejects_an_oversized_prompt() {
        // session-profiles FR-6 defense-in-depth: session_create bounds a
        // systemPrompt directly, matching profiles::registry::normalize_prompt.
        assert!(check_system_prompt_bound(&"x".repeat(crate::profiles::MAX_SYSTEM_PROMPT)).is_ok());
        let err = check_system_prompt_bound(&"x".repeat(crate::profiles::MAX_SYSTEM_PROMPT + 1))
            .unwrap_err();
        assert_eq!(err.0, "INVALID_INPUT");
    }

    #[test]
    fn a_wsl_session_refuses_an_account_dir_wsl_cannot_translate() {
        // multi-account FR-25: the gate `session_create` applies before spawning
        // anything. A drive-letter dir is reachable (wsl.exe maps it to /mnt/…);
        // a UNC one is not, and the failure must name the account.
        assert!(crate::account::wsl_translatable_config_dir(
            "D:\\francois\\accounts\\a1"
        ));
        assert!(!crate::account::wsl_translatable_config_dir(
            "\\\\server\\share\\accounts\\a1"
        ));
    }
}
