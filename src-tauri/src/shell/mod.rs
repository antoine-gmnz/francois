// shell-terminal core — the `shell` domain: a session-keyed registry of real PTYs.
// `mod.rs` owns the shared data model (ShellEvent, Ring, Shared, ShellEntry,
// Registry, EnsureData) plus the two cross-module entry points other domains call
// into (`dispose_session_shell` from session::session_remove, `kill_all_shells`
// from main's exit handler). Spawn resolution lives in `spawn.rs`, the
// `#[tauri::command]` handlers in `commands.rs`.

// `commands` must stay a visible (not private) child: `tauri::generate_handler!`
// in main.rs needs the literal `shell::commands::shell_ensure` path — the
// `#[tauri::command]` macro generates hidden sibling items alongside each
// command fn IN THE MODULE WHERE IT'S DEFINED, so a flattened re-export here
// would leave those siblings unreachable from main.rs.
pub(crate) mod commands;
mod spawn;

pub(crate) use spawn::shell_spawn_target;

use portable_pty::{ChildKiller, MasterPty};
use serde::Serialize;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

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
        let added_bytes = chunk.len();
        let added_lines = chunk.bytes().filter(|&c| c == b'\n').count();
        self.chunks.push_back(chunk.to_string());
        self.bytes += added_bytes;
        self.lines += added_lines;
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
pub struct Registry(Mutex<HashMap<String, ShellEntry>>);

#[derive(Serialize)]
pub struct EnsureData {
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
                let mut state = entry.shared.lock().unwrap();
                state.disposed = true;
            }
            let _ = entry.killer.kill();
            true
        }
        None => false,
    }
}

pub fn kill_all_shells(app: &AppHandle) {
    if let Some(reg) = app.try_state::<Registry>() {
        let mut map = reg.0.lock().unwrap();
        for (_, mut entry) in map.drain() {
            {
                let mut state = entry.shared.lock().unwrap();
                state.disposed = true;
            }
            let _ = entry.killer.kill();
        }
    }
}
