// ---------- shell commands (contract/shell-terminal.ts, multiple-shells §5) ----------

use super::{
    shell_spawn_target, PtyHandles, Registry, Ring, Shared, ShellEnsureData, ShellEvent, ShellInfo,
    ShellRestartData, WriteOutcome, EVENT_CHANNEL,
};
use crate::ipc::{err, ok, IpcResult};
use crate::session;
use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// Open a PTY pair sized `cols`x`rows`. Split out of the spawn path (FR: keep
/// the happy-path readable) — the only thing that can fail here is the OS PTY
/// allocation itself.
fn open_session_pty(cols: u16, rows: u16) -> Result<PtyPair, String> {
    native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("could not open a pty: {e}"))
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
) -> Result<SpawnedShell, String> {
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
    // merges both entries into the one WSLENV list (multi-account FR-24).
    for (k, v) in session::account_env(account_config_dir, runtime, &["TERM/u"]) {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not start {exe}: {e}"))?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("could not open shell input: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("could not open shell output: {e}"))?;

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
    String,
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

/// The shell reader thread's body: pump PTY output into the ring buffer + emit
/// `shell.data` events until the child's side closes, then emit `shell.exit`.
/// Both events carry `shellId` and `sessionId` (FR-10, FR-14).
fn run_shell_reader(
    app: AppHandle,
    shell_id: String,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    shared: Arc<Mutex<Shared>>,
) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                {
                    let mut state = shared.lock().unwrap();
                    if state.disposed {
                        break;
                    }
                    state.ring.push(&chunk);
                }
                let _ = app.emit(
                    EVENT_CHANNEL,
                    ShellEvent::Data {
                        shell_id: shell_id.clone(),
                        session_id: session_id.clone(),
                        data: chunk,
                    },
                );
            }
        }
    }
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
            session_id,
            exit_code: code,
        },
    );
}

/// Open + spawn + start the reader thread for a brand-new shell of
/// `session_id`, at the fixed 80x24 initial size every freshly created shell
/// gets. Returns what the registry needs to install it — doesn't touch the
/// registry itself, so callers control exactly when/how the entry lands
/// (`shell_create` inserts directly; `shell_ensure`'s create-if-none path
/// hands this to `Registry::ensure_first` so a racing concurrent
/// `shell_ensure` attaches instead of spawning a duplicate, §multiple-shells
/// FR-5).
fn spawn_shell(
    app: &AppHandle,
    engine: &session::Engine,
    session_id: &str,
    cwd: &str,
) -> Result<(String, PtyHandles, Arc<Mutex<Shared>>), String> {
    let runtime = engine
        .runtime_of(session_id)
        .unwrap_or_else(|| "native".to_string());
    // multi-account FR-21: the session's account, resolved to its config dir
    // (None for the built-in `default` account — no override).
    let account_config_dir = engine
        .account_of(session_id)
        .and_then(|id| crate::account::claude_config_dir_of(app, &id));
    let (cols, rows) = (80u16, 24u16);
    let (pty, reader, child) =
        open_and_spawn(cwd, &runtime, account_config_dir.as_deref(), cols, rows)?;

    let shell_id = uuid::Uuid::new_v4().to_string();
    let shared = fresh_shared();
    {
        let app = app.clone();
        let sid = shell_id.clone();
        let session_id = session_id.to_string();
        let shared = shared.clone();
        std::thread::spawn(move || run_shell_reader(app, sid, session_id, reader, child, shared));
    }
    Ok((shell_id, pty, shared))
}

/// Spawn a brand-new shell for `session_id` and register it under a fresh
/// `ShellId`. Used by `shell_create` (the cap check runs first, in the
/// caller); `shell_ensure`'s create-if-none path goes through `spawn_shell` +
/// `Registry::ensure_first` instead, never this.
fn spawn_and_register(
    app: &AppHandle,
    reg: &Registry,
    engine: &session::Engine,
    session_id: &str,
    cwd: &str,
) -> Result<ShellInfo, String> {
    let (shell_id, pty, shared) = spawn_shell(app, engine, session_id, cwd)?;
    Ok(reg.insert(shell_id, session_id.to_string(), pty, shared))
}

#[tauri::command(async)]
pub fn shell_ensure(
    app: AppHandle,
    reg: State<'_, Registry>,
    engine: State<'_, session::Engine>,
    session_id: String,
    shell_id: Option<String>,
) -> IpcResult<ShellEnsureData> {
    // FR-5: an explicit shellId attaches, never spawns.
    if let Some(sid) = &shell_id {
        return match reg.belongs_to_session(sid, &session_id) {
            Some(true) => {
                let Some((cols, rows)) = reg.size(sid) else {
                    return err("SHELL_NOT_FOUND", "no such shell");
                };
                let (replay, exit_code) = reg.replay(sid).unwrap_or_default();
                ok(ShellEnsureData {
                    shell_id: sid.clone(),
                    shells: reg.shells_of_session(&session_id),
                    cols,
                    rows,
                    scrollback_replay: replay,
                    exit_code,
                })
            }
            _ => err("SHELL_NOT_FOUND", "no such shell"),
        };
    }

    // No shellId: attach to the session's first shell, in creation order.
    if let Some(first) = reg.first_of_session(&session_id) {
        let Some((cols, rows)) = reg.size(&first) else {
            return err("SHELL_NOT_FOUND", "no such shell");
        };
        let (replay, exit_code) = reg.replay(&first).unwrap_or_default();
        return ok(ShellEnsureData {
            shell_id: first,
            shells: reg.shells_of_session(&session_id),
            cols,
            rows,
            scrollback_replay: replay,
            exit_code,
        });
    }

    // The session has none (yet, as far as we've seen): create-if-none (FR-5),
    // never capped — it only ever goes 0 -> 1 (FR-2). `Registry::ensure_first`
    // reserves the session's creation slot across the check+spawn+insert so a
    // concurrent `shell_ensure({sessionId})` racing this one attaches to
    // whichever call wins instead of both spawning a shell.
    let Some(cwd) = engine.cwd_of(&session_id) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    let shell_id = match reg.ensure_first(&session_id, || {
        spawn_shell(&app, &engine, &session_id, &cwd)
    }) {
        Ok(id) => id,
        Err(msg) => return err("PTY_ERROR", msg),
    };
    let Some((cols, rows)) = reg.size(&shell_id) else {
        return err("SHELL_NOT_FOUND", "no such shell");
    };
    let (replay, exit_code) = reg.replay(&shell_id).unwrap_or_default();
    ok(ShellEnsureData {
        shell_id,
        shells: reg.shells_of_session(&session_id),
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
    session_id: String,
) -> IpcResult<ShellInfo> {
    let Some(cwd) = engine.cwd_of(&session_id) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    // FR-2: checked BEFORE spawning — a refused create spawns nothing.
    if reg.at_cap(&session_id) {
        return err("SHELL_LIMIT_REACHED", "a session holds at most 6 shells");
    }
    match spawn_and_register(&app, &reg, &engine, &session_id, &cwd) {
        Ok(info) => ok(info),
        Err(msg) => err("PTY_ERROR", msg),
    }
}

#[tauri::command(async)]
pub fn shell_restart(
    app: AppHandle,
    reg: State<'_, Registry>,
    engine: State<'_, session::Engine>,
    shell_id: String,
) -> IpcResult<ShellRestartData> {
    let Some(info) = reg.get_info(&shell_id) else {
        return err("SHELL_NOT_FOUND", "no such shell");
    };
    let Some((cols, rows)) = reg.size(&shell_id) else {
        return err("SHELL_NOT_FOUND", "no such shell");
    };
    let runtime = engine
        .runtime_of(&info.session_id)
        .unwrap_or_else(|| "native".to_string());
    let account_config_dir = engine
        .account_of(&info.session_id)
        .and_then(|id| crate::account::claude_config_dir_of(&app, &id));
    let (pty, reader, mut child) = match open_and_spawn(
        &info.cwd,
        &runtime,
        account_config_dir.as_deref(),
        cols,
        rows,
    ) {
        Ok(v) => v,
        Err(msg) => return err("PTY_ERROR", msg),
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
            return err("SHELL_NOT_FOUND", "no such shell"); // disposed racing the restart
        }
    };
    {
        let app = app.clone();
        let sid = shell_id.clone();
        let session_id = info.session_id.clone();
        std::thread::spawn(move || run_shell_reader(app, sid, session_id, reader, child, shared));
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
        None => err("SHELL_NOT_FOUND", "no such shell"),
    }
}

#[tauri::command(async)]
pub fn shell_dispose(reg: State<'_, Registry>, shell_id: String) -> IpcResult<()> {
    if reg.dispose(&shell_id) {
        ok(())
    } else {
        err("SHELL_NOT_FOUND", "no such shell")
    }
}

#[tauri::command(async)]
pub fn shell_write(reg: State<'_, Registry>, shell_id: String, data: String) -> IpcResult<()> {
    match reg.write(&shell_id, &data) {
        WriteOutcome::Ok | WriteOutcome::Dropped => ok(()),
        WriteOutcome::NotFound => err("SHELL_NOT_FOUND", "no such shell"),
        WriteOutcome::Failed(e) => err("SHELL_NOT_FOUND", format!("shell input closed: {e}")),
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
        return err("INVALID_INPUT", "cols and rows must be positive");
    }
    if reg.resize(&shell_id, cols, rows) {
        ok(())
    } else {
        err("SHELL_NOT_FOUND", "no such shell")
    }
}
