// ---------- shell commands ----------

use super::{
    dispose_session_shell, shell_spawn_target, EnsureData, Registry, Ring, Shared, ShellEntry,
    ShellEvent, EVENT_CHANNEL,
};
use crate::ipc::{err, ok, IpcResult};
use crate::session;
use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// Open a PTY pair sized `cols`x`rows`. Split out of `shell_ensure` (FR: keep the
/// happy-path readable) — the only thing that can fail here is the OS PTY
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

/// A freshly spawned shell child plus the handles `shell_ensure` needs to keep
/// (registry entry) or hand to the reader thread.
struct SpawnedShell {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    reader: Box<dyn Read + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Build the command for (exe, args, spawn_cwd, runtime) and spawn it on `pair`'s
/// slave side, then take the master-side writer/reader. Mirrors the previous
/// inline body of `shell_ensure` verbatim — only named and given an early-return
/// `Result` instead of the original per-step `match { ... return err(...) }`.
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
    // multi-account FR-21: the SHELL tab belongs to a session, so a hand-typed
    // `claude` in it must match that session's account. FR-14 (unchanged):
    // forward TERM into the distro — `account_env` merges both entries into the
    // one WSLENV list (multi-account FR-24).
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

/// The shell reader thread's body: pump PTY output into the ring buffer + emit
/// `shell.data` events until the child's side closes, then emit `shell.exit`.
/// Extracted from the `std::thread::spawn` closure in `shell_ensure` to flatten
/// what used to be 5-6 levels of nesting (thread::spawn -> loop -> match read ->
/// Ok(n) -> lock -> if disposed).
fn run_shell_reader(
    app: AppHandle,
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
            session_id,
            exit_code: code,
        },
    );
}

#[tauri::command(async)]
pub fn shell_ensure(
    app: AppHandle,
    reg: State<'_, Registry>,
    engine: State<'_, session::Engine>,
    session_id: String,
) -> IpcResult<EnsureData> {
    let mut map = reg.0.lock().unwrap();

    if let Some(entry) = map.get(&session_id) {
        let shared = entry.shared.lock().unwrap();
        return ok(EnsureData {
            cols: entry.cols,
            rows: entry.rows,
            scrollback_replay: shared.ring.replay(),
            exit_code: if shared.alive { None } else { shared.exit_code },
            shell_name: entry.shell_name.clone(),
            cwd: entry.cwd.clone(),
        });
    }

    // FR-10: resolve the session's own (cwd, runtime) from the engine — replaces
    // the old global home-dir shell. An unknown session id can no longer fall back
    // to $HOME; it's a hard SESSION_NOT_FOUND (the Registry stays keyed by session
    // id, unchanged).
    let Some(cwd) = engine.cwd_of(&session_id) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    let runtime = engine
        .runtime_of(&session_id)
        .unwrap_or_else(|| "native".to_string());
    // multi-account FR-21: the session's account, resolved to its config dir
    // (None for the built-in `default` account — no override, as before).
    let account_config_dir = engine
        .account_of(&session_id)
        .and_then(|id| crate::account::config_dir_of(&app, &id));

    let (cols, rows) = (80u16, 24u16);
    let (exe, args, shell_name, spawn_cwd) = shell_spawn_target(&runtime, &cwd);

    let pair = match open_session_pty(cols, rows) {
        Ok(p) => p,
        Err(msg) => return err("PTY_ERROR", msg),
    };

    let spawned = match spawn_shell_child(
        pair,
        &exe,
        &args,
        spawn_cwd.as_deref(),
        &runtime,
        account_config_dir.as_deref(),
    ) {
        Ok(s) => s,
        Err(msg) => return err("PTY_ERROR", msg),
    };

    let shared = Arc::new(Mutex::new(Shared {
        alive: true,
        exit_code: None,
        disposed: false,
        ring: Ring::new(),
    }));

    {
        let app = app.clone();
        let sid = session_id.clone();
        let shared = shared.clone();
        let reader = spawned.reader;
        let child = spawned.child;
        std::thread::spawn(move || run_shell_reader(app, sid, reader, child, shared));
    }

    map.insert(
        session_id,
        ShellEntry {
            master: spawned.master,
            writer: spawned.writer,
            killer: spawned.killer,
            shell_name: shell_name.clone(),
            cwd: cwd.clone(),
            cols,
            rows,
            shared,
        },
    );

    ok(EnsureData {
        cols,
        rows,
        scrollback_replay: String::new(),
        exit_code: None,
        shell_name,
        cwd,
    })
}

#[tauri::command(async)]
pub fn shell_write(reg: State<'_, Registry>, session_id: String, data: String) -> IpcResult<()> {
    let mut map = reg.0.lock().unwrap();
    match map.get_mut(&session_id) {
        None => err("SESSION_NOT_FOUND", "no shell for this session"),
        Some(entry) => {
            let alive = entry.shared.lock().unwrap().alive;
            if !alive {
                return ok(());
            }
            match entry
                .writer
                .write_all(data.as_bytes())
                .and_then(|_| entry.writer.flush())
            {
                Ok(()) => ok(()),
                Err(e) => err("SESSION_NOT_FOUND", format!("shell input closed: {e}")),
            }
        }
    }
}

#[tauri::command(async)]
pub fn shell_resize(
    reg: State<'_, Registry>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> IpcResult<()> {
    if cols == 0 || rows == 0 {
        return err("INVALID_INPUT", "cols and rows must be positive");
    }
    let mut map = reg.0.lock().unwrap();
    match map.get_mut(&session_id) {
        None => err("SESSION_NOT_FOUND", "no shell for this session"),
        Some(entry) => {
            entry.cols = cols;
            entry.rows = rows;
            let alive = entry.shared.lock().unwrap().alive;
            if alive {
                let _ = entry.master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
            ok(())
        }
    }
}

#[tauri::command(async)]
pub fn shell_dispose(app: AppHandle, session_id: String) -> IpcResult<()> {
    if dispose_session_shell(&app, &session_id) {
        ok(())
    } else {
        err("SESSION_NOT_FOUND", "no shell for this session")
    }
}
