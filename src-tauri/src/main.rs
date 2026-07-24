#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Francois core. Two features live here:
//  * shell-terminal — a session-keyed registry of real PTYs (this file).
//  * session-engine  — Claude Code session lifecycle + event stream (session.rs).
// Every command resolves the `Result<T>` envelope from ipc.rs; none reject.

mod diff;
mod ipc;
mod session;
mod usage;
mod wsl;

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
        Ring {
            chunks: VecDeque::new(),
            bytes: 0,
            lines: 0,
        }
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
        self.chunks
            .iter()
            .fold(String::with_capacity(self.bytes), |mut acc, c| {
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
        let exe = if on_path("pwsh.exe") {
            "pwsh.exe"
        } else {
            "powershell.exe"
        };
        (exe.to_string(), vec![], basename_no_ext(exe))
    } else {
        let candidate = std::env::var("SHELL")
            .ok()
            .filter(|s| std::path::Path::new(s).exists());
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
    std::path::Path::new(p)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(p)
        .to_string()
}

// ---------- per-session spawn matrix (wsl-filesystem FR-10..12) ----------

/// (program, args, shellName, spawnCwd) for a session's shell under its runtime
/// (FR-11/FR-12 — the claude runtime, not the diff domain's FR-5). native: the
/// existing `resolve_shell()` (pwsh/PowerShell/zsh/bash per platform), spawned with
/// the session cwd verbatim — a WSL UNC cwd is legal here (pwsh supports a UNC
/// cwd); it's the user's explicit mismatch choice (spec story C), never blocked.
/// wsl: `wsl.exe [-d <distro>] --cd <dir>` (wsl_base_args — a WSL UNC cwd targets
/// the distro named in the path, not the machine's default) launching that
/// distro's default shell with NO process cwd set — `--cd` alone positions it,
/// and the raw cwd string (UNC or Linux) is meaningless as wsl.exe's own
/// Windows-side working directory. `shellName` is the cwd's distro when the path
/// names one, else the default distro (FR-3), else the literal "wsl" (spec §7).
fn shell_spawn_target(runtime: &str, cwd: &str) -> (String, Vec<String>, String, Option<String>) {
    if runtime == "wsl" {
        let args = crate::wsl::wsl_base_args(cwd);
        let shell_name = crate::wsl::wsl_distro_name(cwd).unwrap_or_else(|| "wsl".to_string());
        ("wsl.exe".to_string(), args, shell_name, None)
    } else {
        let (exe, args, shell_name) = resolve_shell();
        (exe, args, shell_name, Some(cwd.to_string()))
    }
}

// ---------- shell commands ----------

#[tauri::command(async)]
fn shell_ensure(
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

    let (cols, rows) = (80u16, 24u16);
    let (exe, args, shell_name, spawn_cwd) = shell_spawn_target(&runtime, &cwd);

    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => return err("PTY_ERROR", format!("could not open a pty: {e}")),
    };

    let mut cmd = CommandBuilder::new(&exe);
    for a in &args {
        cmd.arg(a);
    }
    if let Some(dir) = &spawn_cwd {
        cmd.cwd(dir); // native only — wsl positions itself via `--cd` above (FR-11)
    }
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    if runtime == "wsl" {
        // FR-14: forward TERM into the distro. Setting it on this (Windows-side)
        // process env alone doesn't cross the wsl.exe boundary; WSLENV with the
        // `/u` flag does. Append (':'-joined) rather than overwrite — the inherited
        // environment may already carry a WSLENV list.
        let wslenv = std::env::var("WSLENV").ok().filter(|v| !v.is_empty());
        let merged = match wslenv {
            // Already forwarded (any flag variant counts) → leave the list untouched;
            // otherwise trim a trailing ':' so we never emit an empty entry.
            Some(existing)
                if existing
                    .split(':')
                    .any(|e| e == "TERM/u" || e.starts_with("TERM/")) =>
            {
                existing
            }
            Some(existing) => format!("{}:TERM/u", existing.trim_end_matches(':')),
            None => "TERM/u".to_string(),
        };
        cmd.env("WSLENV", merged);
    }

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

    let shared = Arc::new(Mutex::new(Shared {
        alive: true,
        exit_code: None,
        disposed: false,
        ring: Ring::new(),
    }));

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
                        let _ = app.emit(
                            EVENT_CHANNEL,
                            ShellEvent::Data {
                                session_id: sid.clone(),
                                data: chunk,
                            },
                        );
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
            let _ = app.emit(
                EVENT_CHANNEL,
                ShellEvent::Exit {
                    session_id: sid.clone(),
                    exit_code: code,
                },
            );
        });
    }

    map.insert(
        session_id,
        ShellEntry {
            master: pair.master,
            writer,
            killer,
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
fn shell_write(reg: State<'_, Registry>, session_id: String, data: String) -> IpcResult<()> {
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
fn shell_resize(
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

/// Dispose a single session's shell: mark disposed + kill + drop the registry
/// entry. Returns whether a shell existed to dispose (FR-13, wsl-filesystem).
/// Shared by the `shell_dispose` command and `session_remove` (session.rs) — a
/// removed session must never leave an orphan PTY running.
pub fn dispose_session_shell(app: &AppHandle, session_id: &str) -> bool {
    let Some(reg) = app.try_state::<Registry>() else {
        return false;
    };
    let mut map = reg.0.lock().unwrap();
    match map.remove(session_id) {
        Some(mut entry) => {
            {
                let mut s = entry.shared.lock().unwrap();
                s.disposed = true;
            }
            let _ = entry.killer.kill();
            true
        }
        None => false,
    }
}

#[tauri::command(async)]
fn shell_dispose(app: AppHandle, session_id: String) -> IpcResult<()> {
    if dispose_session_shell(&app, &session_id) {
        ok(())
    } else {
        err("SESSION_NOT_FOUND", "no shell for this session")
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
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("panic.log");
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(f, "[{ts}] panic on thread '{thread}': {info}");
        }
        default_hook(info);
    }));
}

/// Paint the native caption bar with the app's own palette so the OS chrome reads as
/// part of the window instead of a grey strip sitting on top of it. The window keeps
/// its real minimize/maximize/close buttons — only their backdrop is recolored.
/// Windows 11 (build 22000+) only; older builds ignore the attributes and keep the
/// plain dark caption from `"theme": "Dark"`.
#[cfg(windows)]
fn tint_window_chrome(window: &tauri::WebviewWindow, theme: &str) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };

    // COLORREF is 0x00BBGGRR — byte order reversed from CSS hex.
    const fn colorref(rgb: u32) -> u32 {
        ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)
    }
    // Match the caption to --bg-app for the active theme so the OS chrome disappears
    // into the window instead of reading as a strip on top of it. The values mirror
    // styles.css: dark #0f1015 / light #f5f6f8, with the theme's secondary text hue.
    let (caption, text) = if theme == "light" {
        (colorref(0xf5_f6_f8), colorref(0x4e_52_5b)) // --bg-app / --text-hint (light)
    } else {
        (colorref(0x0f_10_15), colorref(0xa9_ad_b6)) // --bg-app / --text-hint (dark)
    };
    let border = caption; // no seam between the caption and the window edge

    let Ok(hwnd) = window.hwnd() else { return };
    for (attr, color) in [
        (DWMWA_CAPTION_COLOR, caption),
        (DWMWA_TEXT_COLOR, text),
        (DWMWA_BORDER_COLOR, border),
    ] {
        // SAFETY: hwnd is live (we hold the window), and the attribute payload is the
        // COLORREF u32 the DWM docs specify for these three attributes.
        unsafe {
            DwmSetWindowAttribute(
                hwnd.0 as _,
                attr as u32,
                std::ptr::addr_of!(color).cast(),
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

/// francois:app:setWindowTheme — repaint the native caption bar for the given theme
/// ("light" | "dark"). The webview calls this on mount and whenever the theme toggles
/// so the OS chrome tracks --bg-app. Best-effort: a no-op on non-Windows / older builds.
#[tauri::command(async)]
#[cfg_attr(not(windows), allow(unused_variables))]
fn app_set_window_theme(_app: AppHandle, theme: String) -> IpcResult<()> {
    #[cfg(windows)]
    if let Some(w) = _app.get_webview_window("main") {
        tint_window_chrome(&w, &theme);
    }
    ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Registry::default())
        .manage(session::Engine::default())
        // usage-bar §6: the app-scoped usage cache lives in its OWN mutex, never
        // inside session::Engine — a leaf lock the probe path can take freely.
        .manage(usage::UsageState::default())
        .setup(|app| {
            install_panic_log(app.handle());
            // Tint with the dark caption up front; the webview re-tints with the
            // persisted theme (app_set_window_theme) once it mounts. See §theme.
            #[cfg(windows)]
            if let Some(w) = app.get_webview_window("main") {
                tint_window_chrome(&w, "dark");
            }
            session::load_persisted(app.handle());
            session::warm_model_cache(app.handle().clone());
            // usage-bar FR-11/FR-12: probe once now, then every 5 minutes.
            usage::start_timers(app.handle().clone());
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
            session::session_answer_question,
            session::session_switch_model,
            session::session_compact,
            session::session_clear,
            session::session_list_commands,
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
            app_set_window_theme,
            usage::app_get_usage,
            usage::app_refresh_usage,
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
                usage::kill_probe(app); // usage-bar §7 #9 — no orphan `claude`
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_spawn_target_native_uses_resolve_shell_and_session_cwd() {
        // Regression pin (spec §9 last bullet): a native-runtime session's shell
        // spawn must stay byte-identical to the pre-wsl-filesystem resolve_shell()
        // output, now just spawned in the SESSION's cwd instead of always $HOME.
        let (exe, args, name) = resolve_shell();
        let (exe2, args2, name2, spawn_cwd) = shell_spawn_target("native", "D:\\infra");
        assert_eq!((exe2, args2, name2), (exe, args, name));
        assert_eq!(spawn_cwd, Some("D:\\infra".to_string()));
    }

    #[test]
    fn shell_spawn_target_wsl_targets_the_cwds_distro_and_sets_no_process_cwd() {
        // The distro comes from the UNC path itself (-d) — bare wsl.exe would hit
        // the machine's DEFAULT distro, wrong whenever the repo lives elsewhere
        // (docker-desktop-as-default being the canonical open-source-user case).
        let (exe, args, name, spawn_cwd) =
            shell_spawn_target("wsl", "\\\\wsl$\\Ubuntu\\home\\u\\api");
        assert_eq!(exe, "wsl.exe");
        assert_eq!(args, vec!["-d", "Ubuntu", "--cd", "/home/u/api"]);
        assert_eq!(name, "Ubuntu"); // FR-12: pure — from the path, no wsl.exe probe
        assert_eq!(spawn_cwd, None); // `--cd` alone positions it (FR-11)
    }

    #[test]
    fn shell_spawn_target_wsl_passes_drive_cwd_verbatim_for_wsl_exe_to_map() {
        let (exe, args, _name, spawn_cwd) = shell_spawn_target("wsl", "D:\\acme-api");
        assert_eq!(exe, "wsl.exe");
        assert_eq!(args, vec!["--cd", "D:\\acme-api"]); // wsl.exe maps this to /mnt/d/acme-api itself
        assert_eq!(spawn_cwd, None);
    }
}
