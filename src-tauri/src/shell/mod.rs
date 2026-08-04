// shell-terminal / multiple-shells core — the `shell` domain: a ShellId-keyed
// registry of real PTYs, up to 6 per session. `mod.rs` owns the shared data
// model (ShellEvent, Ring, Shared, PtyHandles, ShellEntry, Registry, ShellInfo,
// ShellEnsureData, ShellRestartData) plus the two cross-module entry points
// other domains call into (`dispose_session_shells` from session::session_remove,
// `kill_all_shells` from main's exit handler). Spawn resolution lives in
// `spawn.rs`, the `#[tauri::command]` handlers in `commands.rs`.

// `commands` must stay a visible (not private) child: `tauri::generate_handler!`
// in main.rs needs the literal `shell::commands::shell_ensure` path — the
// `#[tauri::command]` macro generates hidden sibling items alongside each
// command fn IN THE MODULE WHERE IT'S DEFINED, so a flattened re-export here
// would leave those siblings unreachable from main.rs.
pub(crate) mod commands;
mod spawn;

pub(crate) use spawn::shell_spawn_target;

use portable_pty::{ChildKiller, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

const EVENT_CHANNEL: &str = "francois://shell/event";
const RING_MAX_BYTES: usize = 1_048_576; // 1 MiB (shell-terminal FR-9)
const RING_MAX_LINES: usize = 2000; // shell-terminal FR-9
const SHELL_CAP: usize = 6; // FR-2
const MAX_NAME_LEN: usize = 40; // FR-4

// ---------- shell event payload (contract/shell-terminal.ts ShellEvent) ----------

#[derive(Serialize, Clone)]
#[serde(tag = "type")]
enum ShellEvent {
    #[serde(rename = "shell.data")]
    Data {
        #[serde(rename = "shellId")]
        shell_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        data: String,
    },
    #[serde(rename = "shell.exit")]
    Exit {
        #[serde(rename = "shellId")]
        shell_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "exitCode")]
        exit_code: i32,
    },
}

// ---------- ring buffer (shell-terminal FR-9) ----------

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

pub(crate) struct Shared {
    alive: bool,
    exit_code: Option<i32>,
    disposed: bool,
    ring: Ring,
}

// ---------- ShellInfo (contract/shell-terminal.ts) ----------

#[derive(Serialize, Clone)]
pub struct ShellInfo {
    id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    name: String,
    #[serde(rename = "shellName")]
    shell_name: String,
    cwd: String,
    alive: bool,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
}

#[derive(Serialize)]
pub struct ShellEnsureData {
    #[serde(rename = "shellId")]
    shell_id: String,
    shells: Vec<ShellInfo>,
    cols: u16,
    rows: u16,
    #[serde(rename = "scrollbackReplay")]
    scrollback_replay: String,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
}

#[derive(Serialize)]
pub struct ShellRestartData {
    cols: u16,
    rows: u16,
}

// ---------- PTY handles a freshly opened/spawned PTY hands to the registry ----------
// (open + spawn is commands.rs's concern; the registry only ever takes the
// resulting handles, so it stays free of portable-pty spawn logic.)

pub(crate) struct PtyHandles {
    pub(crate) master: Box<dyn MasterPty + Send>,
    pub(crate) writer: Box<dyn Write + Send>,
    pub(crate) killer: Box<dyn ChildKiller + Send + Sync>,
    pub(crate) shell_name: String,
    pub(crate) cwd: String,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

struct ShellEntry {
    id: String,
    session_id: String,
    /// Registry-wide monotonic counter — yields per-session creation order
    /// (FR-1), stable across renames and closes.
    seq: u64,
    /// Meaningful only while `custom_name` is None: the ordinal in `<shellName>
    /// <n>` (FR-3). Recomputed by `Registry::rename`'s reset path (FR-4).
    ordinal: u32,
    /// Some(_) once the user renames the shell (FR-4); None while it wears its
    /// auto name.
    custom_name: Option<String>,
    shell_name: String,
    cwd: String,
    cols: u16,
    rows: u16,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    shared: Arc<Mutex<Shared>>,
}

impl ShellEntry {
    fn display_name(&self) -> String {
        match &self.custom_name {
            Some(n) => n.clone(),
            None => format!("{} {}", self.shell_name, self.ordinal),
        }
    }

    fn info(&self) -> ShellInfo {
        let shared = self.shared.lock().unwrap();
        ShellInfo {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            name: self.display_name(),
            shell_name: self.shell_name.clone(),
            cwd: self.cwd.clone(),
            alive: shared.alive,
            exit_code: if shared.alive { None } else { shared.exit_code },
        }
    }
}

/// The smallest positive integer not present in `used` (FR-3): closing `zsh 2`
/// of three and adding one yields `zsh 2` again, not `zsh 4`. Pure so it's
/// trivially unit-testable without a registry or any PTY handle at all.
fn smallest_unused_ordinal(used: impl IntoIterator<Item = u32>) -> u32 {
    let used: std::collections::HashSet<u32> = used.into_iter().collect();
    let mut n = 1u32;
    while used.contains(&n) {
        n += 1;
    }
    n
}

enum RenameOutcome {
    Custom(String),
    Reset,
}

/// FR-4: trim, cap at 40 chars (truncated, not refused); empty/whitespace-only
/// resets to the auto name. Truncates on a char boundary, never a byte one.
fn normalize_rename(input: &str) -> RenameOutcome {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        RenameOutcome::Reset
    } else {
        RenameOutcome::Custom(trimmed.chars().take(MAX_NAME_LEN).collect())
    }
}

// ---------- registry ----------

#[derive(Default)]
struct RegistryState {
    shells: HashMap<String, ShellEntry>,
    next_seq: u64,
}

#[derive(Default)]
pub struct Registry {
    state: Mutex<RegistryState>,
    /// Per-session locks serializing `shell_ensure`'s create-if-none path
    /// (FR-5): `ensure_first` holds a session's lock across its
    /// check-first/spawn/insert so concurrent `shell_ensure({sessionId})`
    /// calls for a session with no shells yet attach to the first call's
    /// result instead of each spawning a shell. Entries are never removed —
    /// one `Arc<Mutex<()>>` per session id seen is cheap for the app's
    /// lifetime, and that's simpler than reclaiming them on session removal.
    creation_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

/// What `Registry::write` found — mirrors the pre-multiple-shells `shell_write`
/// handling verbatim, just renamed off `SESSION_NOT_FOUND` (shell-terminal) onto
/// `SHELL_NOT_FOUND` (this domain's own vocabulary, §5).
pub(crate) enum WriteOutcome {
    Ok,
    /// Not alive: bytes are silently dropped, `ok: true` (edge cases §7).
    Dropped,
    NotFound,
    Failed(String),
}

impl Registry {
    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        self.state.lock().unwrap()
    }

    /// The `Arc<Mutex<()>>` guarding `session_id`'s create-if-none slot,
    /// creating it on first use.
    fn creation_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.creation_locks.lock().unwrap();
        locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// `shell_ensure`'s create-if-none path (FR-5), race-free: if the session
    /// already has a first shell, returns its id immediately. Otherwise
    /// acquires the session's creation lock, re-checks (another caller may
    /// have won the race while this one waited for the lock), and only then
    /// runs `spawn` — so at most one shell is ever spawned per genuinely-empty
    /// session no matter how many `shell_ensure` calls for it arrive
    /// concurrently; the rest attach to what the winner created instead of
    /// each spawning their own.
    pub(crate) fn ensure_first(
        &self,
        session_id: &str,
        spawn: impl FnOnce() -> Result<(String, PtyHandles, Arc<Mutex<Shared>>), String>,
    ) -> Result<String, String> {
        if let Some(first) = self.first_of_session(session_id) {
            return Ok(first);
        }
        let lock = self.creation_lock(session_id);
        let _guard = lock.lock().unwrap();
        if let Some(first) = self.first_of_session(session_id) {
            return Ok(first);
        }
        let (id, pty, shared) = spawn()?;
        Ok(self.insert(id, session_id.to_string(), pty, shared).id)
    }

    /// A session's shells in creation order (FR-1).
    pub(crate) fn shells_of_session(&self, session_id: &str) -> Vec<ShellInfo> {
        let state = self.lock();
        let mut entries: Vec<&ShellEntry> = state
            .shells
            .values()
            .filter(|e| e.session_id == session_id)
            .collect();
        entries.sort_by_key(|e| e.seq);
        entries.into_iter().map(|e| e.info()).collect()
    }

    pub(crate) fn count_of_session(&self, session_id: &str) -> usize {
        self.lock()
            .shells
            .values()
            .filter(|e| e.session_id == session_id)
            .count()
    }

    pub(crate) fn at_cap(&self, session_id: &str) -> bool {
        self.count_of_session(session_id) >= SHELL_CAP
    }

    /// The id of the session's first shell in creation order (FR-5), None if it
    /// has none.
    pub(crate) fn first_of_session(&self, session_id: &str) -> Option<String> {
        let state = self.lock();
        state
            .shells
            .values()
            .filter(|e| e.session_id == session_id)
            .min_by_key(|e| e.seq)
            .map(|e| e.id.clone())
    }

    pub(crate) fn get_info(&self, shell_id: &str) -> Option<ShellInfo> {
        self.lock().shells.get(shell_id).map(|e| e.info())
    }

    /// None: unknown id. Some(false): known but belongs to another session.
    /// Some(true): known and matches — both non-true cases are `SHELL_NOT_FOUND`
    /// at the API boundary (FR-5).
    pub(crate) fn belongs_to_session(&self, shell_id: &str, session_id: &str) -> Option<bool> {
        self.lock()
            .shells
            .get(shell_id)
            .map(|e| e.session_id == session_id)
    }

    pub(crate) fn size(&self, shell_id: &str) -> Option<(u16, u16)> {
        self.lock().shells.get(shell_id).map(|e| (e.cols, e.rows))
    }

    /// The ring replay plus the exit code, present only once the shell has
    /// exited (drives FR-17 across an `ensure`, shell-terminal FR-9's caps
    /// bounding what's returned).
    pub(crate) fn replay(&self, shell_id: &str) -> Option<(String, Option<i32>)> {
        let state = self.lock();
        let entry = state.shells.get(shell_id)?;
        let shared = entry.shared.lock().unwrap();
        Some((
            shared.ring.replay(),
            if shared.alive { None } else { shared.exit_code },
        ))
    }

    /// FR-3/FR-6: register a freshly spawned shell under `id`, computing its
    /// creation-order `seq` and its auto-name ordinal (the smallest one not
    /// currently held by another auto-named shell of the same session).
    pub(crate) fn insert(
        &self,
        id: String,
        session_id: String,
        pty: PtyHandles,
        shared: Arc<Mutex<Shared>>,
    ) -> ShellInfo {
        let mut state = self.lock();
        let seq = state.next_seq;
        state.next_seq += 1;
        let used = state
            .shells
            .values()
            .filter(|e| e.session_id == session_id && e.custom_name.is_none())
            .map(|e| e.ordinal);
        let ordinal = smallest_unused_ordinal(used);
        let entry = ShellEntry {
            id: id.clone(),
            session_id,
            seq,
            ordinal,
            custom_name: None,
            shell_name: pty.shell_name,
            cwd: pty.cwd,
            cols: pty.cols,
            rows: pty.rows,
            master: pty.master,
            writer: pty.writer,
            killer: pty.killer,
            shared,
        };
        let info = entry.info();
        state.shells.insert(id, entry);
        info
    }

    /// FR-4: rename, or reset to the auto name on an empty/whitespace value.
    /// None if the shell doesn't exist.
    pub(crate) fn rename(&self, shell_id: &str, name: &str) -> Option<ShellInfo> {
        let mut state = self.lock();
        let session_id = state.shells.get(shell_id)?.session_id.clone();
        match normalize_rename(name) {
            RenameOutcome::Custom(custom) => {
                let entry = state.shells.get_mut(shell_id)?;
                entry.custom_name = Some(custom);
                Some(entry.info())
            }
            RenameOutcome::Reset => {
                let used = state
                    .shells
                    .values()
                    .filter(|e| {
                        e.session_id == session_id && e.id != shell_id && e.custom_name.is_none()
                    })
                    .map(|e| e.ordinal)
                    .collect::<Vec<_>>();
                let ordinal = smallest_unused_ordinal(used);
                let entry = state.shells.get_mut(shell_id)?;
                entry.custom_name = None;
                entry.ordinal = ordinal;
                Some(entry.info())
            }
        }
    }

    /// FR-7: swap in a fresh PTY/ring under the same id, keeping name/position.
    /// Returns the entry's size (== `pty`'s, the caller opens it at the last
    /// known size) so the caller can build `ShellRestartData`. None if disposed
    /// out from under a racing restart.
    pub(crate) fn restart(
        &self,
        shell_id: &str,
        pty: PtyHandles,
        shared: Arc<Mutex<Shared>>,
    ) -> Option<(u16, u16)> {
        let mut state = self.lock();
        let entry = state.shells.get_mut(shell_id)?;
        let _ = entry.killer.kill(); // in case it's somehow still alive (FR-7)
                                     // Suppress the outgoing reader thread's terminal `shell.exit` emit —
                                     // same as `dispose`/`dispose_session`/`kill_all` — so the swap below
                                     // doesn't leave a stray reader racing to report on a `Shared` nothing
                                     // else references anymore.
        entry.shared.lock().unwrap().disposed = true;
        entry.master = pty.master;
        entry.writer = pty.writer;
        entry.killer = pty.killer;
        entry.cols = pty.cols;
        entry.rows = pty.rows;
        entry.shared = shared;
        Some((entry.cols, entry.rows))
    }

    pub(crate) fn write(&self, shell_id: &str, data: &str) -> WriteOutcome {
        let mut state = self.lock();
        let Some(entry) = state.shells.get_mut(shell_id) else {
            return WriteOutcome::NotFound;
        };
        let alive = entry.shared.lock().unwrap().alive;
        if !alive {
            return WriteOutcome::Dropped;
        }
        match entry
            .writer
            .write_all(data.as_bytes())
            .and_then(|_| entry.writer.flush())
        {
            Ok(()) => WriteOutcome::Ok,
            Err(e) => WriteOutcome::Failed(e.to_string()),
        }
    }

    /// True if the shell exists (and was resized), false on `SHELL_NOT_FOUND`.
    pub(crate) fn resize(&self, shell_id: &str, cols: u16, rows: u16) -> bool {
        let mut state = self.lock();
        let Some(entry) = state.shells.get_mut(shell_id) else {
            return false;
        };
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
        true
    }

    /// FR-8: kill (if alive) and drop the entry + its ring. False if unknown.
    pub(crate) fn dispose(&self, shell_id: &str) -> bool {
        let mut state = self.lock();
        match state.shells.remove(shell_id) {
            Some(mut entry) => {
                entry.shared.lock().unwrap().disposed = true;
                let _ = entry.killer.kill();
                true
            }
            None => false,
        }
    }

    /// FR-9: kill + drop every shell of one session. Returns how many existed.
    fn dispose_session(&self, session_id: &str) -> usize {
        let mut state = self.lock();
        let ids: Vec<String> = state
            .shells
            .values()
            .filter(|e| e.session_id == session_id)
            .map(|e| e.id.clone())
            .collect();
        for id in &ids {
            if let Some(mut entry) = state.shells.remove(id) {
                entry.shared.lock().unwrap().disposed = true;
                let _ = entry.killer.kill();
            }
        }
        ids.len()
    }

    fn kill_all(&self) {
        let mut state = self.lock();
        for (_, mut entry) in state.shells.drain() {
            entry.shared.lock().unwrap().disposed = true;
            let _ = entry.killer.kill();
        }
    }
}

/// Kill + drop every shell belonging to `session_id` (FR-9). What
/// `session::session_remove` and `wsl-filesystem`'s runtime switch call — a
/// removed session, or one switching runtime, must never leave an orphan PTY
/// running. Replaces the pre-multiple-shells single-shell `dispose_session_shell`.
pub fn dispose_session_shells(app: &AppHandle, session_id: &str) -> usize {
    match app.try_state::<Registry>() {
        Some(reg) => reg.dispose_session(session_id),
        None => 0,
    }
}

pub fn kill_all_shells(app: &AppHandle) {
    if let Some(reg) = app.try_state::<Registry>() {
        reg.kill_all();
    }
}

// ---------- shared test fixtures ----------

#[cfg(test)]
mod testutil {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder};

    /// Opens a real PTY and spawns a short-lived, always-available command
    /// (`cmd.exe /c exit` on Windows, `/bin/sh -c exit` elsewhere) — registry
    /// tests exercise real portable-pty handles without depending on `claude`
    /// or a real login shell being on PATH. Mirrors this project's
    /// throwaway-temp-repo pattern for git tests: a disposable real resource
    /// instead of a hand-rolled trait double (portable-pty's traits are too
    /// wide to fake cheaply).
    pub(crate) fn spawn_test_pty(shell_name: &str, cwd: &str) -> (PtyHandles, Arc<Mutex<Shared>>) {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/c");
            c.arg("exit");
            c
        } else {
            let mut c = CommandBuilder::new("/bin/sh");
            c.arg("-c");
            c.arg("exit 0");
            c
        };
        cmd.cwd(cwd);
        let child = pair.slave.spawn_command(cmd).expect("spawn test pty");
        drop(pair.slave);
        let killer = child.clone_killer();
        let writer = pair.master.take_writer().expect("writer");
        drop(child); // no reader thread here — tests don't care about output
        (
            PtyHandles {
                master: pair.master,
                writer,
                killer,
                shell_name: shell_name.to_string(),
                cwd: cwd.to_string(),
                cols: 80,
                rows: 24,
            },
            Arc::new(Mutex::new(Shared {
                alive: true,
                exit_code: None,
                disposed: false,
                ring: Ring::new(),
            })),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;
    use serde_json::json;

    // ---------- pure helpers ----------

    #[test]
    fn smallest_unused_ordinal_fills_gaps_before_extending() {
        assert_eq!(smallest_unused_ordinal([]), 1);
        assert_eq!(smallest_unused_ordinal([1, 2, 3]), 4);
        assert_eq!(smallest_unused_ordinal([1, 3]), 2); // the FR-3 example
        assert_eq!(smallest_unused_ordinal([2, 3]), 1);
    }

    #[test]
    fn normalize_rename_trims_and_caps_at_40_chars() {
        match normalize_rename("  build  ") {
            RenameOutcome::Custom(n) => assert_eq!(n, "build"),
            RenameOutcome::Reset => panic!("expected Custom"),
        }
        let long = "x".repeat(50);
        match normalize_rename(&long) {
            RenameOutcome::Custom(n) => assert_eq!(n.chars().count(), 40),
            RenameOutcome::Reset => panic!("expected Custom"),
        }
    }

    #[test]
    fn normalize_rename_empty_or_whitespace_resets() {
        assert!(matches!(normalize_rename(""), RenameOutcome::Reset));
        assert!(matches!(normalize_rename("   "), RenameOutcome::Reset));
    }

    // ---------- serde shapes (contract/shell-terminal.ts) ----------

    #[test]
    fn shell_data_event_serializes_to_contract_shape() {
        let ev = serde_json::to_value(ShellEvent::Data {
            shell_id: "sh1".into(),
            session_id: "s1".into(),
            data: "hello".into(),
        })
        .unwrap();
        assert_eq!(
            ev,
            json!({ "type": "shell.data", "shellId": "sh1", "sessionId": "s1", "data": "hello" })
        );
    }

    #[test]
    fn shell_exit_event_serializes_to_contract_shape() {
        let ev = serde_json::to_value(ShellEvent::Exit {
            shell_id: "sh1".into(),
            session_id: "s1".into(),
            exit_code: 2,
        })
        .unwrap();
        assert_eq!(
            ev,
            json!({ "type": "shell.exit", "shellId": "sh1", "sessionId": "s1", "exitCode": 2 })
        );
    }

    #[test]
    fn shell_ensure_data_serializes_to_contract_shape() {
        let data = ShellEnsureData {
            shell_id: "sh1".into(),
            shells: vec![],
            cols: 80,
            rows: 24,
            scrollback_replay: "hi".into(),
            exit_code: Some(2),
        };
        let v = serde_json::to_value(&data).unwrap();
        assert_eq!(
            v,
            json!({
                "shellId": "sh1",
                "shells": [],
                "cols": 80,
                "rows": 24,
                "scrollbackReplay": "hi",
                "exitCode": 2
            })
        );
    }

    #[test]
    fn shell_ensure_data_omits_exit_code_when_none() {
        let data = ShellEnsureData {
            shell_id: "sh1".into(),
            shells: vec![],
            cols: 80,
            rows: 24,
            scrollback_replay: String::new(),
            exit_code: None,
        };
        let v = serde_json::to_value(&data).unwrap();
        assert!(v.get("exitCode").is_none());
    }

    #[test]
    fn shell_restart_data_serializes_to_contract_shape() {
        let data = ShellRestartData {
            cols: 120,
            rows: 40,
        };
        let v = serde_json::to_value(&data).unwrap();
        assert_eq!(v, json!({ "cols": 120, "rows": 40 }));
    }

    #[test]
    fn shell_info_omits_exit_code_while_alive() {
        let reg = Registry::default();
        let (pty, shared) = spawn_test_pty("sh", "/tmp");
        let info = reg.insert("sh1".into(), "s1".into(), pty, shared);
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(v["id"], "sh1");
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["name"], "sh 1");
        assert_eq!(v["shellName"], "sh");
        assert_eq!(v["alive"], true);
        assert!(v.get("exitCode").is_none());
    }

    // ---------- registry behaviour ----------

    #[test]
    fn insert_orders_by_creation_and_names_by_smallest_unused_ordinal() {
        let reg = Registry::default();
        let (p1, s1) = spawn_test_pty("zsh", "/tmp");
        let (p2, s2) = spawn_test_pty("zsh", "/tmp");
        let (p3, s3) = spawn_test_pty("zsh", "/tmp");
        reg.insert("a".into(), "sess".into(), p1, s1);
        reg.insert("b".into(), "sess".into(), p2, s2);
        reg.insert("c".into(), "sess".into(), p3, s3);

        let shells = reg.shells_of_session("sess");
        assert_eq!(
            shells.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
        assert_eq!(
            shells.iter().map(|s| s.name.clone()).collect::<Vec<_>>(),
            vec!["zsh 1", "zsh 2", "zsh 3"]
        );

        // FR-3: disposing the middle one and creating a new one reuses ordinal 2,
        // not 4 — and the new shell lands last in creation order (FR-1), not in
        // the freed slot's old position.
        assert!(reg.dispose("b"));
        let (p4, s4) = spawn_test_pty("zsh", "/tmp");
        reg.insert("d".into(), "sess".into(), p4, s4);
        let shells = reg.shells_of_session("sess");
        assert_eq!(
            shells.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
            vec!["a", "c", "d"]
        );
        assert_eq!(
            shells.iter().map(|s| s.name.clone()).collect::<Vec<_>>(),
            vec!["zsh 1", "zsh 3", "zsh 2"]
        );
    }

    #[test]
    fn cap_is_per_session_at_six() {
        let reg = Registry::default();
        for i in 0..6 {
            let (p, s) = spawn_test_pty("zsh", "/tmp");
            reg.insert(format!("s{i}"), "sess".into(), p, s);
        }
        assert!(reg.at_cap("sess"));
        assert_eq!(reg.count_of_session("sess"), 6);
        // A different session is unaffected (per-session cap, FR-2).
        assert!(!reg.at_cap("other"));
    }

    #[test]
    fn rename_sets_a_custom_name_and_frees_its_ordinal() {
        let reg = Registry::default();
        let (p1, s1) = spawn_test_pty("zsh", "/tmp");
        let (p2, s2) = spawn_test_pty("zsh", "/tmp");
        reg.insert("a".into(), "sess".into(), p1, s1);
        reg.insert("b".into(), "sess".into(), p2, s2);

        let renamed = reg.rename("b", "  build  ").unwrap();
        assert_eq!(renamed.name, "build");

        // "b"'s ordinal (2) is now free — a new shell claims it, not 3.
        let (p3, s3) = spawn_test_pty("zsh", "/tmp");
        let info = reg.insert("c".into(), "sess".into(), p3, s3);
        assert_eq!(info.name, "zsh 2");
    }

    #[test]
    fn rename_to_empty_resets_to_the_auto_name() {
        let reg = Registry::default();
        let (p1, s1) = spawn_test_pty("zsh", "/tmp");
        reg.insert("a".into(), "sess".into(), p1, s1);
        let renamed = reg.rename("a", "custom").unwrap();
        assert_eq!(renamed.name, "custom");
        let reset = reg.rename("a", "   ").unwrap();
        assert_eq!(reset.name, "zsh 1");
    }

    #[test]
    fn rename_unknown_shell_returns_none() {
        let reg = Registry::default();
        assert!(reg.rename("nope", "x").is_none());
    }

    #[test]
    fn restart_keeps_id_name_and_position_and_clears_the_ring() {
        let reg = Registry::default();
        let (p1, s1) = spawn_test_pty("zsh", "/tmp");
        let (p2, s2) = spawn_test_pty("zsh", "/tmp");
        reg.insert("a".into(), "sess".into(), p1, s1.clone());
        reg.insert("b".into(), "sess".into(), p2, s2);
        reg.rename("a", "keep-me").unwrap();
        s1.lock().unwrap().ring.push("stale output");

        let (fresh_pty, fresh_shared) = spawn_test_pty("zsh", "/tmp");
        let size = reg.restart("a", fresh_pty, fresh_shared).unwrap();
        assert_eq!(size, (80, 24));

        let shells = reg.shells_of_session("sess");
        assert_eq!(
            shells.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
            vec!["a", "b"]
        ); // same position
        assert_eq!(shells[0].name, "keep-me"); // same name
        assert_eq!(reg.replay("a").unwrap().0, ""); // fresh ring
    }

    #[test]
    fn restart_unknown_shell_returns_none() {
        let reg = Registry::default();
        let (pty, shared) = spawn_test_pty("zsh", "/tmp");
        assert!(reg.restart("nope", pty, shared).is_none());
    }

    #[test]
    fn restart_marks_the_outgoing_shared_disposed() {
        // Same as dispose()/dispose_session()/kill_all(): the old reader
        // thread checks `disposed` before emitting `shell.exit` — restart
        // must flip it on the outgoing `Shared` or that thread's terminal
        // emit races the fresh PTY's own events.
        let reg = Registry::default();
        let (p1, s1) = spawn_test_pty("zsh", "/tmp");
        reg.insert("a".into(), "sess".into(), p1, s1.clone());
        assert!(!s1.lock().unwrap().disposed);

        let (fresh_pty, fresh_shared) = spawn_test_pty("zsh", "/tmp");
        reg.restart("a", fresh_pty, fresh_shared).unwrap();

        assert!(s1.lock().unwrap().disposed);
    }

    #[test]
    fn ensure_first_serializes_concurrent_create_if_none_calls() {
        // multiple-shells FR-5: N concurrent `shell_ensure({sessionId})` calls
        // against a session with no shells yet must spawn exactly one shell —
        // the rest attach to what the winner created.
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Barrier;

        const CALLERS: usize = 8;
        let reg = Arc::new(Registry::default());
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(CALLERS));

        let handles: Vec<_> = (0..CALLERS)
            .map(|_| {
                let reg = reg.clone();
                let spawn_count = spawn_count.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    reg.ensure_first("sess", || {
                        spawn_count.fetch_add(1, Ordering::SeqCst);
                        let (pty, shared) = spawn_test_pty("zsh", "/tmp");
                        Ok(("only".to_string(), pty, shared))
                    })
                })
            })
            .collect();

        let ids: Vec<String> = handles
            .into_iter()
            .map(|h| h.join().unwrap().unwrap())
            .collect();

        assert_eq!(spawn_count.load(Ordering::SeqCst), 1);
        assert!(ids.iter().all(|id| id == "only"));
        assert_eq!(reg.count_of_session("sess"), 1);
    }

    #[test]
    fn ensure_first_attaches_immediately_when_a_shell_already_exists() {
        let reg = Registry::default();
        let (p1, s1) = spawn_test_pty("zsh", "/tmp");
        reg.insert("a".into(), "sess".into(), p1, s1);

        let id = reg
            .ensure_first("sess", || {
                panic!("must not spawn when a shell already exists")
            })
            .unwrap();
        assert_eq!(id, "a");
    }

    #[test]
    fn dispose_removes_the_entry_and_leaves_others_untouched() {
        let reg = Registry::default();
        let (p1, s1) = spawn_test_pty("zsh", "/tmp");
        let (p2, s2) = spawn_test_pty("zsh", "/tmp");
        reg.insert("a".into(), "sess".into(), p1, s1);
        reg.insert("b".into(), "sess".into(), p2, s2);

        assert!(reg.dispose("a"));
        assert!(!reg.dispose("a")); // already gone
        assert_eq!(reg.count_of_session("sess"), 1);
        assert_eq!(reg.first_of_session("sess"), Some("b".to_string()));
    }

    #[test]
    fn dispose_session_kills_every_shell_of_that_session_only() {
        let reg = Registry::default();
        let (p1, s1) = spawn_test_pty("zsh", "/tmp");
        let (p2, s2) = spawn_test_pty("zsh", "/tmp");
        let (p3, s3) = spawn_test_pty("zsh", "/tmp");
        reg.insert("a".into(), "sess1".into(), p1, s1);
        reg.insert("b".into(), "sess1".into(), p2, s2);
        reg.insert("c".into(), "sess2".into(), p3, s3);

        assert_eq!(reg.dispose_session("sess1"), 2);
        assert_eq!(reg.count_of_session("sess1"), 0);
        assert_eq!(reg.count_of_session("sess2"), 1); // untouched
    }

    #[test]
    fn kill_all_drains_every_session() {
        let reg = Registry::default();
        let (p1, s1) = spawn_test_pty("zsh", "/tmp");
        let (p2, s2) = spawn_test_pty("zsh", "/tmp");
        reg.insert("a".into(), "sess1".into(), p1, s1);
        reg.insert("b".into(), "sess2".into(), p2, s2);
        reg.kill_all();
        assert_eq!(reg.count_of_session("sess1"), 0);
        assert_eq!(reg.count_of_session("sess2"), 0);
    }

    #[test]
    fn belongs_to_session_distinguishes_unknown_from_wrong_session() {
        let reg = Registry::default();
        let (p1, s1) = spawn_test_pty("zsh", "/tmp");
        reg.insert("a".into(), "sess1".into(), p1, s1);
        assert_eq!(reg.belongs_to_session("a", "sess1"), Some(true));
        assert_eq!(reg.belongs_to_session("a", "sess2"), Some(false));
        assert_eq!(reg.belongs_to_session("nope", "sess1"), None);
    }

    #[test]
    fn write_drops_bytes_silently_once_not_alive() {
        let reg = Registry::default();
        let (pty, shared) = spawn_test_pty("zsh", "/tmp");
        reg.insert("a".into(), "sess".into(), pty, shared.clone());
        shared.lock().unwrap().alive = false;
        assert!(matches!(reg.write("a", "x"), WriteOutcome::Dropped));
    }

    #[test]
    fn write_unknown_shell_is_not_found() {
        let reg = Registry::default();
        assert!(matches!(reg.write("nope", "x"), WriteOutcome::NotFound));
    }

    #[test]
    fn resize_updates_size_and_reports_unknown_shells() {
        let reg = Registry::default();
        let (pty, shared) = spawn_test_pty("zsh", "/tmp");
        reg.insert("a".into(), "sess".into(), pty, shared);
        assert!(reg.resize("a", 120, 40));
        assert_eq!(reg.size("a"), Some((120, 40)));
        assert!(!reg.resize("nope", 10, 10));
    }

    #[test]
    fn first_of_session_is_none_when_empty() {
        let reg = Registry::default();
        assert_eq!(reg.first_of_session("sess"), None);
    }
}
