#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Francois core. Two features live here:
//  * shell-terminal — a session-keyed registry of real PTYs (this file).
//  * session-engine  — Claude Code session lifecycle + event stream (session.rs).
// Every command resolves the `Result<T>` envelope from ipc.rs; none reject.

mod diff;
mod ipc;
mod session;

use crate::ipc::{err, ok, IpcResult};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

const EVENT_CHANNEL: &str = "francois://shell/event";
const RING_MAX_BYTES: usize = 1_048_576; // 1 MiB (FR-9)
const RING_MAX_LINES: usize = 2000; // FR-9

// ---------- shell event payload (contract/shell-terminal.ts ShellEvent) ----------

#[derive(Serialize, Clone)]
#[serde(tag = "type")]
enum ShellEvent {
    #[serde(rename = "shell.data")]
    Data {
        #[serde(rename = "sessionId")]
        session_id: String,
        data: String,
    },
    #[serde(rename = "shell.exit")]
    Exit {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "exitCode")]
        exit_code: i32,
    },
}

// ---------- ring buffer (FR-9) ----------

struct Ring {
    chunks: VecDeque<String>,
    bytes: usize,
    lines: usize,
}

impl Ring {
    fn new() -> Self {
        Ring { chunks: VecDeque::new(), bytes: 0, lines: 0 }
    }

    fn push(&mut self, chunk: &str) {
        let b = chunk.len();
        let l = chunk.bytes().filter(|&c| c == b'\n').count();
        self.chunks.push_back(chunk.to_string());
        self.bytes += b;
        self.lines += l;
        while self.bytes > RING_MAX_BYTES || self.lines > RING_MAX_LINES {
            if let Some(front) = self.chunks.pop_front() {
                self.bytes -= front.len();
                self.lines -= front.bytes().filter(|&c| c == b'\n').count();
            } else {
                break;
            }
        }
    }

    fn replay(&self) -> String {
        self.chunks.iter().fold(String::with_capacity(self.bytes), |mut acc, c| {
            acc.push_str(c);
            acc
        })
    }
}

struct Shared {
    alive: bool,
    exit_code: Option<i32>,
    disposed: bool,
    ring: Ring,
}

struct ShellEntry {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    shell_name: String,
    cwd: String,
    cols: u16,
    rows: u16,
    shared: Arc<Mutex<Shared>>,
}

#[derive(Default)]
struct Registry(Mutex<HashMap<String, ShellEntry>>);

#[derive(Serialize)]
struct EnsureData {
    cols: u16,
    rows: u16,
    #[serde(rename = "scrollbackReplay")]
    scrollback_replay: String,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(rename = "shellName")]
    shell_name: String,
    cwd: String,
}

// ---------- shell resolution (FR-6) ----------

fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

fn resolve_shell() -> (String, Vec<String>, String) {
    if cfg!(target_os = "windows") {
        let exe = if on_path("pwsh.exe") { "pwsh.exe" } else { "powershell.exe" };
        (exe.to_string(), vec![], basename_no_ext(exe))
    } else {
        let candidate = std::env::var("SHELL").ok().filter(|s| std::path::Path::new(s).exists());
        let exe = candidate
            .or_else(|| some_if_exists("/bin/zsh"))
            .or_else(|| some_if_exists("/bin/bash"))
            .unwrap_or_else(|| "/bin/sh".to_string());
        let name = basename_no_ext(&exe);
        (exe, vec!["-il".to_string()], name)
    }
}

fn some_if_exists(p: &str) -> Option<String> {
    if std::path::Path::new(p).exists() {
        Some(p.to_string())
    } else {
        None
    }
}

fn basename_no_ext(p: &str) -> String {
    std::path::Path::new(p).file_stem().and_then(|s| s.to_str()).unwrap_or(p).to_string()
}

fn session_cwd() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| ".".to_string())
}

// ---------- shell commands ----------

#[tauri::command(async)]
fn shell_ensure(app: AppHandle, reg: State<'_, Registry>, session_id: String) -> IpcResult<EnsureData> {
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

    let (cols, rows) = (80u16, 24u16);
    let (exe, args, shell_name) = resolve_shell();
    let cwd = session_cwd();

    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }) {
        Ok(p) => p,
        Err(e) => return err("PTY_ERROR", format!("could not open a pty: {e}")),
    };

    let mut cmd = CommandBuilder::new(&exe);
    for a in &args {
        cmd.arg(a);
    }
    cmd.cwd(&cwd);
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => return err("PTY_ERROR", format!("could not start {exe}: {e}")),
    };
    drop(pair.slave);

    let killer = child.clone_killer();
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => return err("PTY_ERROR", format!("could not open shell input: {e}")),
    };
    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => return err("PTY_ERROR", format!("could not open shell output: {e}")),
    };

    let shared = Arc::new(Mutex::new(Shared { alive: true, exit_code: None, disposed: false, ring: Ring::new() }));

    {
        let shared = shared.clone();
        let app = app.clone();
        let sid = session_id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        {
                            let mut s = shared.lock().unwrap();
                            if s.disposed {
                                break;
                            }
                            s.ring.push(&chunk);
                        }
                        let _ = app.emit(EVENT_CHANNEL, ShellEvent::Data { session_id: sid.clone(), data: chunk });
                    }
                }
            }
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            let mut s = shared.lock().unwrap();
            s.alive = false;
            s.exit_code = Some(code);
            if s.disposed {
                return;
            }
            drop(s);
            let _ = app.emit(EVENT_CHANNEL, ShellEvent::Exit { session_id: sid.clone(), exit_code: code });
        });
    }

    map.insert(
        session_id,
        ShellEntry { master: pair.master, writer, killer, shell_name: shell_name.clone(), cwd: cwd.clone(), cols, rows, shared },
    );

    ok(EnsureData { cols, rows, scrollback_replay: String::new(), exit_code: None, shell_name, cwd })
}

#[tauri::command(async)]
fn shell_write(reg: State<'_, Registry>, session_id: String, data: String) -> IpcResult<()> {
    let mut map = reg.0.lock().unwrap();
    match map.get_mut(&session_id) {
        None => err("SESSION_NOT_FOUND", "no shell for this session"),
        Some(entry) => {
            let alive = entry.shared.lock().unwrap().alive;
            if !alive {
                return ok(());
            }
            match entry.writer.write_all(data.as_bytes()).and_then(|_| entry.writer.flush()) {
                Ok(()) => ok(()),
                Err(e) => err("SESSION_NOT_FOUND", format!("shell input closed: {e}")),
            }
        }
    }
}

#[tauri::command(async)]
fn shell_resize(reg: State<'_, Registry>, session_id: String, cols: u16, rows: u16) -> IpcResult<()> {
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
                let _ = entry.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
            }
            ok(())
        }
    }
}

#[tauri::command(async)]
fn shell_dispose(reg: State<'_, Registry>, session_id: String) -> IpcResult<()> {
    let mut map = reg.0.lock().unwrap();
    match map.remove(&session_id) {
        None => err("SESSION_NOT_FOUND", "no shell for this session"),
        Some(mut entry) => {
            {
                let mut s = entry.shared.lock().unwrap();
                s.disposed = true;
            }
            let _ = entry.killer.kill();
            ok(())
        }
    }
}

fn kill_all_shells(app: &AppHandle) {
    if let Some(reg) = app.try_state::<Registry>() {
        let mut map = reg.0.lock().unwrap();
        for (_, mut entry) in map.drain() {
            {
                let mut s = entry.shared.lock().unwrap();
                s.disposed = true;
            }
            let _ = entry.killer.kill();
        }
    }
}

/// Any panic, on any thread, appends one line to `<app_data>/panic.log` before the
/// default handler runs. A main-thread panic aborts the whole app (the "it just
/// closed" report) and this file is the only trace it leaves; a background-thread
/// panic is otherwise completely silent. Best-effort — never panics itself.
fn install_panic_log(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("panic.log");
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let thread = std::thread::current().name().unwrap_or("<unnamed>").to_string();
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "[{ts}] panic on thread '{thread}': {info}");
        }
        default_hook(info);
    }));
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Registry::default())
        .manage(session::Engine::default())
        .setup(|app| {
            install_panic_log(app.handle());
            session::load_persisted(app.handle());
            session::warm_model_cache(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            shell_ensure,
            shell_write,
            shell_resize,
            shell_dispose,
            session::session_list,
            session::session_create,
            session::session_remove,
            session::session_send,
            session::session_interrupt,
            session::session_switch_model,
            session::session_compact,
            session::session_models,
            session::session_pick_directory,
            session::conversation_get_transcript,
            session::agents_list,
            session::agents_dispatch,
            session::agents_kill,
            session::mcp_registry,
            session::mcp_list,
            session::mcp_detail,
            session::mcp_reconnect,
            session::mcp_detach,
            session::mcp_attach,
            session::skills_list,
            session::skills_install,
            session::skills_run,
            diff::diff_get_summary,
            diff::diff_get_file_diff,
            diff::diff_stage_all,
            diff::diff_commit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building francois")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                kill_all_shells(app);
                session::kill_all(app);
            }
        });
}
