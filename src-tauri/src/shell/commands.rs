// ---------- shell commands (contract/shell-terminal.ts, multiple-shells §5,
// unbound-panes FR-6..FR-11/§5) ----------

use super::{
    shell_spawn_target, PtyHandles, Registry, Ring, Shared, ShellEnsureData, ShellEvent, ShellInfo,
    ShellOwner, ShellRestartData, WriteOutcome, EVENT_CHANNEL,
};
use crate::ipc::{err, ok, IpcResult};
use crate::ipc::{AppError, ErrorCode};
use crate::session;
use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// Open a PTY pair sized `cols`x`rows`. Split out of the spawn path (FR: keep
/// the happy-path readable) — the only thing that can fail here is the OS PTY
/// allocation itself.
fn open_session_pty(cols: u16, rows: u16) -> Result<PtyPair, AppError> {
    native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| pty_error(format!("could not open a pty: {e}")))
}

/// core-architecture-wave3 FR-6: PTY_ERROR is the one code the four command
/// sites in this file stamped on every failure the spawn chain produced —
/// raised at the failure now, so the chain carries `Result<T, AppError>` end to
/// end and the commands convert with `.into()` instead of re-coding.
fn pty_error(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::PtyError, message)
}

/// A freshly spawned shell child plus the handles the caller needs to keep
/// (registry entry) or hand to the reader thread.
struct SpawnedShell {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    reader: Box<dyn Read + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Build the command for (exe, args, spawn_cwd, runtime) and spawn it on `pair`'s
/// slave side, then take the master-side writer/reader.
fn spawn_shell_child(
    pair: PtyPair,
    exe: &str,
    args: &[String],
    spawn_cwd: Option<&str>,
    runtime: &str,
    account_config_dir: Option<&str>,
) -> Result<SpawnedShell, AppError> {
    let mut cmd = CommandBuilder::new(exe);
    for a in args {
        cmd.arg(a);
    }
    if let Some(dir) = spawn_cwd {
        cmd.cwd(dir); // native only — wsl positions itself via `--cd` above (FR-11)
    }
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    // multi-account FR-21: every shell of a session must match that session's
    // account. FR-14 (unchanged): forward TERM into the distro — `account_env`
    // merges both entries into the one WSLENV list (multi-account FR-24). A
    // project-owned shell (unbound-panes FR-6) has no account of its own, so
    // `account_config_dir` is None and this runs on the default account.
    for (k, v) in session::account_env(account_config_dir, runtime, &["TERM/u"]) {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| pty_error(format!("could not start {exe}: {e}")))?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| pty_error(format!("could not open shell input: {e}")))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| pty_error(format!("could not open shell output: {e}")))?;

    Ok(SpawnedShell {
        master: pair.master,
        writer,
        reader,
        killer,
        child,
    })
}

/// Open + spawn a shell at (cols, rows) in `cwd`, via the same `shell_spawn_target`
/// resolution every shell uses (FR-6, wsl-filesystem). Returns the handles the
/// registry keeps plus the reader/child the caller hands to `run_shell_reader`.
#[allow(clippy::type_complexity)]
fn open_and_spawn(
    cwd: &str,
    runtime: &str,
    account_config_dir: Option<&str>,
    cols: u16,
    rows: u16,
) -> Result<
    (
        PtyHandles,
        Box<dyn Read + Send>,
        Box<dyn portable_pty::Child + Send + Sync>,
    ),
    AppError,
> {
    let (exe, args, shell_name, spawn_cwd) = shell_spawn_target(runtime, cwd);
    let pair = open_session_pty(cols, rows)?;
    let spawned = spawn_shell_child(
        pair,
        &exe,
        &args,
        spawn_cwd.as_deref(),
        runtime,
        account_config_dir,
    )?;
    Ok((
        PtyHandles {
            master: spawned.master,
            writer: spawned.writer,
            killer: spawned.killer,
            shell_name,
            cwd: cwd.to_string(),
            cols,
            rows,
        },
        spawned.reader,
        spawned.child,
    ))
}

fn fresh_shared() -> Arc<Mutex<Shared>> {
    Arc::new(Mutex::new(Shared {
        alive: true,
        exit_code: None,
        disposed: false,
        ring: Ring::new(),
    }))
}

/// How long the flusher waits after output first arrives before emitting it —
/// long enough to fold a flood (a build, a `git log`) from one event per 8 KiB
/// `read()` into a handful of events per second, short enough that interactive
/// echo stays imperceptible.
const SHELL_EMIT_COALESCE: std::time::Duration = std::time::Duration::from_millis(8);

/// The pending output shared between the PTY read loop and the flusher thread.
struct PendingOutput {
    data: String,
    reader_done: bool,
    /// Set when the read loop stopped because the shell was disposed: whatever
    /// is still buffered is dropped instead of emitted, so a disposed shell
    /// never gets a late `shell.data` — its `shell.exit` is suppressed too.
    discarded: bool,
}

/// Lock `PendingOutput` without caring about poisoning. It guards a string and
/// two flags that are only ever swapped wholesale, so a panic elsewhere cannot
/// leave it half-written — and unwrapping here would turn one panic into a
/// flusher thread stranded on the condvar.
fn lock_pending(lock: &Mutex<PendingOutput>) -> std::sync::MutexGuard<'_, PendingOutput> {
    lock.lock().unwrap_or_else(|e| e.into_inner())
}

/// Sets `reader_done` and wakes the flusher when the read loop is left — on the
/// normal path *and* on an unwind. Without it a panic inside the loop (a
/// poisoned `shared.lock().unwrap()`, say) would skip the hand-off below and
/// leave the flusher waiting on the condvar forever: one leaked thread per
/// affected shell.
struct ReaderDone(Arc<(Mutex<PendingOutput>, std::sync::Condvar)>);

impl Drop for ReaderDone {
    fn drop(&mut self) {
        let (lock, cvar) = &*self.0;
        lock_pending(lock).reader_done = true;
        cvar.notify_one();
    }
}

/// The shell reader thread's body: pump PTY output into the ring buffer + emit
/// `shell.data` events until the child's side closes, then emit `shell.exit`.
/// Both events carry `shellId` and `owner` (FR-10, FR-14, unbound-panes §5).
///
/// Emission is COALESCED: the read loop appends into `PendingOutput` and a
/// flusher thread drains it at most once per `SHELL_EMIT_COALESCE` window.
/// Emitting straight from the read loop (the previous shape) meant one webview
/// event per `read()` return — a flood from any single shell (multiplied by
/// every mounted terminal's listener) starved the renderer enough to lag
/// typing once a few sessions were open. The ring is still fed per chunk, so
/// scrollback replay is unchanged; only the live event stream is batched.
fn run_shell_reader(
    app: AppHandle,
    shell_id: String,
    owner: ShellOwner,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    shared: Arc<Mutex<Shared>>,
) {
    let pending = Arc::new((
        Mutex::new(PendingOutput {
            data: String::new(),
            reader_done: false,
            discarded: false,
        }),
        std::sync::Condvar::new(),
    ));

    let flusher = {
        let pending = Arc::clone(&pending);
        let app = app.clone();
        let shell_id = shell_id.clone();
        let owner = owner.clone();
        std::thread::spawn(move || {
            let (lock, cvar) = &*pending;
            loop {
                let mut guard = lock_pending(lock);
                while guard.data.is_empty() && !guard.reader_done {
                    guard = cvar.wait(guard).unwrap_or_else(|e| e.into_inner());
                }
                if guard.discarded || guard.data.is_empty() {
                    return; // disposed, or reader done and everything flushed
                }
                drop(guard);
                // Accumulate window: whatever else the PTY produces in the next
                // few ms rides in the same event.
                std::thread::sleep(SHELL_EMIT_COALESCE);
                let data = {
                    let mut guard = lock_pending(lock);
                    if guard.discarded {
                        return;
                    }
                    std::mem::take(&mut guard.data)
                };
                let _ = app.emit(
                    EVENT_CHANNEL,
                    ShellEvent::Data {
                        shell_id: shell_id.clone(),
                        owner: owner.clone(),
                        data,
                    },
                );
            }
        })
    };
    let reader_done = ReaderDone(Arc::clone(&pending));

    let mut disposed = false;
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&buf[..n]);
                {
                    let mut state = shared.lock().unwrap();
                    if state.disposed {
                        disposed = true;
                        break;
                    }
                    state.ring.push(&chunk);
                }
                let (lock, cvar) = &*pending;
                lock_pending(lock).data.push_str(&chunk);
                cvar.notify_one();
            }
        }
    }
    // Wake the flusher for a final drain and wait for it, so the last
    // `shell.data` is on the wire before `shell.exit` follows it. A disposed
    // shell drops that drain instead — `shell.exit` is suppressed for it below,
    // so one more `shell.data` after teardown would contradict that guard.
    if disposed {
        lock_pending(&pending.0).discarded = true;
    }
    drop(reader_done);
    let _ = flusher.join();

    let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
    let mut state = shared.lock().unwrap();
    state.alive = false;
    state.exit_code = Some(code);
    if state.disposed {
        return;
    }
    drop(state);
    let _ = app.emit(
        EVENT_CHANNEL,
        ShellEvent::Exit {
            shell_id,
            owner,
            exit_code: code,
        },
    );
}

/// What a shell owner resolves to before it can spawn: the cwd, the claude
/// runtime, and (for a session owner) its account's config dir override.
#[cfg_attr(test, derive(Debug))]
struct OwnerTarget {
    cwd: String,
    runtime: String,
    account_config_dir: Option<String>,
}

/// Pure decision logic for a project owner once its root lookup is known
/// (success or failure) — split out of `resolve_owner_target` so the
/// `PROJECT_NOT_FOUND`/`PROJECT_ROOT_MISSING` precedence (owned by
/// `project::root_of`, surfaced here via `root_for_shell`) and the
/// WSL-vs-native runtime pick are unit-testable without an `AppHandle` or a
/// `ProjectRegistry` fixture.
fn project_owner_target(root_lookup: Result<String, AppError>) -> Result<OwnerTarget, AppError> {
    let root = root_lookup?;
    let runtime = if crate::wsl::is_wsl_unc_path(&root) {
        "wsl".to_string()
    } else {
        "native".to_string()
    };
    Ok(OwnerTarget {
        cwd: root,
        runtime,
        account_config_dir: None,
    })
}

/// unbound-panes §5: resolve `owner` to where/how its shell spawns. A session
/// owner reads its live cwd/runtime/account off the engine exactly as before
/// (`SESSION_NOT_FOUND` if unknown). A project owner resolves to the
/// project's `root` (`PROJECT_NOT_FOUND`/`PROJECT_ROOT_MISSING`, checked
/// BEFORE spawning) with no account override, and a runtime derived from the
/// root's own shape — a WSL UNC root resolves to `"wsl"`, exactly how a
/// session's runtime reads off a WSL UNC cwd (wsl-filesystem).
fn resolve_owner_target(
    app: &AppHandle,
    engine: &session::Engine,
    owner: &ShellOwner,
) -> Result<OwnerTarget, AppError> {
    match owner {
        ShellOwner::Session { session_id } => {
            let cwd = engine.cwd_of(session_id).ok_or(AppError::new(
                ErrorCode::SessionNotFound,
                "no such session".to_string(),
            ))?;
            let runtime = engine
                .runtime_of(session_id)
                .unwrap_or_else(|| "native".to_string());
            // multi-account FR-21 / multi-provider-codex FR-18: the session's
            // account, resolved to its *Claude* config dir — `None` for the
            // built-in `default` account AND for a codex/openai one, since this
            // becomes `CLAUDE_CONFIG_DIR` and `claude` initializes whatever
            // directory it is handed.
            let account_config_dir = engine
                .account_of(session_id)
                .and_then(|id| crate::account::claude_config_dir_of(app, &id));
            Ok(OwnerTarget {
                cwd,
                runtime,
                account_config_dir,
            })
        }
        ShellOwner::Project { project_id } => {
            project_owner_target(crate::project::root_for_shell(app, project_id))
        }
    }
}

/// Open + spawn + start the reader thread for a brand-new shell of `owner`, at
/// the fixed 80x24 initial size every freshly created shell gets. Returns
/// what the registry needs to install it — doesn't touch the registry itself,
/// so callers control exactly when/how the entry lands (`shell_create` inserts
/// directly; `shell_ensure`'s create-if-none path hands this to
/// `Registry::ensure_first` so a racing concurrent `shell_ensure` attaches
/// instead of spawning a duplicate, §multiple-shells FR-5).
fn spawn_shell(
    app: &AppHandle,
    owner: ShellOwner,
    cwd: &str,
    runtime: &str,
    account_config_dir: Option<&str>,
) -> Result<(String, PtyHandles, Arc<Mutex<Shared>>), AppError> {
    let (cols, rows) = (80u16, 24u16);
    let (pty, reader, child) = open_and_spawn(cwd, runtime, account_config_dir, cols, rows)?;

    let shell_id = uuid::Uuid::new_v4().to_string();
    let shared = fresh_shared();
    {
        let app = app.clone();
        let sid = shell_id.clone();
        let owner = owner.clone();
        let shared = shared.clone();
        std::thread::spawn(move || run_shell_reader(app, sid, owner, reader, child, shared));
    }
    Ok((shell_id, pty, shared))
}

/// Spawn a brand-new shell for `owner` and register it under a fresh
/// `ShellId`. Used by `shell_create` (the cap check runs first, in the
/// caller); `shell_ensure`'s create-if-none path goes through `spawn_shell` +
/// `Registry::ensure_first` instead, never this.
fn spawn_and_register(
    app: &AppHandle,
    reg: &Registry,
    owner: ShellOwner,
    cwd: &str,
    runtime: &str,
    account_config_dir: Option<&str>,
) -> Result<ShellInfo, AppError> {
    let (shell_id, pty, shared) =
        spawn_shell(app, owner.clone(), cwd, runtime, account_config_dir)?;
    Ok(reg.insert(shell_id, owner, pty, shared))
}

#[tauri::command(async)]
pub fn shell_ensure(
    app: AppHandle,
    reg: State<'_, Registry>,
    engine: State<'_, session::Engine>,
    owner: ShellOwner,
    shell_id: Option<String>,
) -> IpcResult<ShellEnsureData> {
    // FR-5: an explicit shellId attaches, never spawns.
    if let Some(sid) = &shell_id {
        return match reg.belongs_to(sid, &owner) {
            Some(true) => {
                let Some((cols, rows)) = reg.size(sid) else {
                    return err(ErrorCode::ShellNotFound, "no such shell");
                };
                let (replay, exit_code) = reg.replay(sid).unwrap_or_default();
                ok(ShellEnsureData {
                    shell_id: sid.clone(),
                    shells: reg.shells_of_owner(&owner),
                    cols,
                    rows,
                    scrollback_replay: replay,
                    exit_code,
                })
            }
            _ => err(ErrorCode::ShellNotFound, "no such shell"),
        };
    }

    // No shellId: attach to the owner's first shell, in creation order.
    if let Some(first) = reg.first_of_owner(&owner) {
        let Some((cols, rows)) = reg.size(&first) else {
            return err(ErrorCode::ShellNotFound, "no such shell");
        };
        let (replay, exit_code) = reg.replay(&first).unwrap_or_default();
        return ok(ShellEnsureData {
            shell_id: first,
            shells: reg.shells_of_owner(&owner),
            cols,
            rows,
            scrollback_replay: replay,
            exit_code,
        });
    }

    // The owner has none (yet, as far as we've seen): create-if-none (FR-5),
    // never capped — it only ever goes 0 -> 1 (FR-2). `Registry::ensure_first`
    // reserves the owner's creation slot across the check+spawn+insert so a
    // concurrent `shell_ensure({owner})` racing this one attaches to
    // whichever call wins instead of both spawning a shell.
    let target = match resolve_owner_target(&app, &engine, &owner) {
        Ok(t) => t,
        Err(e) => return e.into(),
    };
    let shell_id = match reg.ensure_first(&owner, || {
        spawn_shell(
            &app,
            owner.clone(),
            &target.cwd,
            &target.runtime,
            target.account_config_dir.as_deref(),
        )
    }) {
        Ok(id) => id,
        Err(e) => return e.into(),
    };
    let Some((cols, rows)) = reg.size(&shell_id) else {
        return err(ErrorCode::ShellNotFound, "no such shell");
    };
    let (replay, exit_code) = reg.replay(&shell_id).unwrap_or_default();
    ok(ShellEnsureData {
        shell_id,
        shells: reg.shells_of_owner(&owner),
        cols,
        rows,
        scrollback_replay: replay,
        exit_code,
    })
}

#[tauri::command(async)]
pub fn shell_create(
    app: AppHandle,
    reg: State<'_, Registry>,
    engine: State<'_, session::Engine>,
    owner: ShellOwner,
) -> IpcResult<ShellInfo> {
    let target = match resolve_owner_target(&app, &engine, &owner) {
        Ok(t) => t,
        Err(e) => return e.into(),
    };
    // FR-2: checked BEFORE spawning — a refused create spawns nothing.
    if reg.at_cap(&owner) {
        return err(
            ErrorCode::ShellLimitReached,
            "at most 6 shells per session or project",
        );
    }
    spawn_and_register(
        &app,
        &reg,
        owner,
        &target.cwd,
        &target.runtime,
        target.account_config_dir.as_deref(),
    )
    .into()
}

#[tauri::command(async)]
pub fn shell_restart(
    app: AppHandle,
    reg: State<'_, Registry>,
    engine: State<'_, session::Engine>,
    shell_id: String,
) -> IpcResult<ShellRestartData> {
    let Some(info) = reg.get_info(&shell_id) else {
        return err(ErrorCode::ShellNotFound, "no such shell");
    };
    let Some((cols, rows)) = reg.size(&shell_id) else {
        return err(ErrorCode::ShellNotFound, "no such shell");
    };
    // The owner may have moved on (a project's root, an account) since this
    // shell was first spawned — re-resolve rather than reuse stale values,
    // same as the original spawn path.
    let (runtime, account_config_dir) = match &info.owner {
        ShellOwner::Session { session_id } => (
            engine
                .runtime_of(session_id)
                .unwrap_or_else(|| "native".to_string()),
            engine
                .account_of(session_id)
                .and_then(|id| crate::account::claude_config_dir_of(&app, &id)),
        ),
        ShellOwner::Project { .. } => (
            if crate::wsl::is_wsl_unc_path(&info.cwd) {
                "wsl".to_string()
            } else {
                "native".to_string()
            },
            None,
        ),
    };
    let (pty, reader, mut child) = match open_and_spawn(
        &info.cwd,
        &runtime,
        account_config_dir.as_deref(),
        cols,
        rows,
    ) {
        Ok(v) => v,
        Err(e) => return e.into(),
    };

    // FR-7: fresh ring for the restarted PTY.
    let shared = fresh_shared();
    // Commit to the registry BEFORE starting the reader thread: if
    // `shell_dispose` raced us and the entry is already gone, `reg.restart`
    // returns None and nothing else has a reference to this child yet — kill
    // it ourselves rather than leaking an orphaned process.
    let (cols, rows) = match reg.restart(&shell_id, pty, shared.clone()) {
        Some(size) => size,
        None => {
            let _ = child.kill();
            return err(ErrorCode::ShellNotFound, "no such shell"); // disposed racing the restart
        }
    };
    {
        let app = app.clone();
        let sid = shell_id.clone();
        let owner = info.owner.clone();
        std::thread::spawn(move || run_shell_reader(app, sid, owner, reader, child, shared));
    }
    ok(ShellRestartData { cols, rows })
}

#[tauri::command(async)]
pub fn shell_rename(
    reg: State<'_, Registry>,
    shell_id: String,
    name: String,
) -> IpcResult<ShellInfo> {
    match reg.rename(&shell_id, &name) {
        Some(info) => ok(info),
        None => err(ErrorCode::ShellNotFound, "no such shell"),
    }
}

#[tauri::command(async)]
pub fn shell_dispose(reg: State<'_, Registry>, shell_id: String) -> IpcResult<()> {
    if reg.dispose(&shell_id) {
        ok(())
    } else {
        err(ErrorCode::ShellNotFound, "no such shell")
    }
}

#[tauri::command(async)]
pub fn shell_write(reg: State<'_, Registry>, shell_id: String, data: String) -> IpcResult<()> {
    match reg.write(&shell_id, &data) {
        WriteOutcome::Ok | WriteOutcome::Dropped => ok(()),
        WriteOutcome::NotFound => err(ErrorCode::ShellNotFound, "no such shell"),
        WriteOutcome::Failed(e) => {
            err(ErrorCode::ShellNotFound, format!("shell input closed: {e}"))
        }
    }
}

#[tauri::command(async)]
pub fn shell_resize(
    reg: State<'_, Registry>,
    shell_id: String,
    cols: u16,
    rows: u16,
) -> IpcResult<()> {
    if cols == 0 || rows == 0 {
        return err(ErrorCode::InvalidInput, "cols and rows must be positive");
    }
    if reg.resize(&shell_id, cols, rows) {
        ok(())
    } else {
        err(ErrorCode::ShellNotFound, "no such shell")
    }
}

// ---------- project owner target resolution (unbound-panes FR-6/§5) ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_owner_target_resolves_native_root_and_no_account_override() {
        let target = project_owner_target(Ok("/repo/acme".to_string())).unwrap();
        assert_eq!(target.cwd, "/repo/acme");
        assert_eq!(target.runtime, "native");
        assert_eq!(target.account_config_dir, None);
    }

    #[test]
    fn project_owner_target_resolves_wsl_unc_root_to_the_wsl_runtime() {
        let target =
            project_owner_target(Ok("\\\\wsl$\\Ubuntu\\home\\u\\api".to_string())).unwrap();
        assert_eq!(target.cwd, "\\\\wsl$\\Ubuntu\\home\\u\\api");
        assert_eq!(target.runtime, "wsl");
        assert_eq!(target.account_config_dir, None);
    }

    #[test]
    fn project_owner_target_propagates_project_not_found_before_any_spawn() {
        let err = project_owner_target(Err(AppError::new(
            ErrorCode::ProjectNotFound,
            "no such project",
        )))
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::ProjectNotFound);
        assert_eq!(err.message, "no such project");
    }

    #[test]
    fn project_owner_target_propagates_project_root_missing_before_any_spawn() {
        let err = project_owner_target(Err(AppError::new(
            ErrorCode::ProjectRootMissing,
            "root not set",
        )))
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::ProjectRootMissing);
        assert_eq!(err.message, "root not set");
    }
}
