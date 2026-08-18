// shell-terminal / multiple-shells / unbound-panes core — the `shell` domain: a
// ShellId-keyed registry of real PTYs, up to 6 per OWNER (unbound-panes §5). A
// shell's owner is a `ShellOwner` union — a session, or (unbound-panes FR-6) a
// registered project rooted at its `root`. `mod.rs` owns the shared data model
// (ShellOwner, ShellEvent, Ring, Shared, PtyHandles, ShellEntry, Registry,
// ShellInfo, ShellEnsureData, ShellRestartData) plus the two cross-module entry
// points other domains call into (`dispose_session_shells` from
// session::session_remove — SESSION-owned shells only, project shells are
// untouched — and `kill_all_shells` from main's exit handler). Spawn
// resolution lives in `spawn.rs`, the `#[tauri::command]` handlers in
// `commands.rs`.

// `commands` must stay a visible (not private) child: `tauri::generate_handler!`
// in main.rs needs the literal `shell::commands::shell_ensure` path — the
// `#[tauri::command]` macro generates hidden sibling items alongside each
// command fn IN THE MODULE WHERE IT'S DEFINED, so a flattened re-export here
// would leave those siblings unreachable from main.rs.
pub(crate) mod commands;
mod spawn;

pub(crate) use spawn::shell_spawn_target;

use portable_pty::{ChildKiller, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

const EVENT_CHANNEL: &str = "francois://shell/event";
const RING_MAX_BYTES: usize = 1_048_576; // 1 MiB (shell-terminal FR-9)
const RING_MAX_LINES: usize = 2000; // shell-terminal FR-9
const SHELL_CAP: usize = 6; // FR-2, per OWNER (unbound-panes §5)
const MAX_NAME_LEN: usize = 40; // FR-4

// ---------- ShellOwner (contract/shell-terminal.ts, unbound-panes FR-6/§5) ----------

/// Who a shell belongs to for its whole life. A project-owned shell is rooted
/// at that project's `root` and has no session. `rename_all = "camelCase"`
/// lowercases the variant names too, so `Session`/`Project` serialize as the
/// contract's `kind: 'session' | 'project'` tags.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShellOwner {
    Session {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Project {
        #[serde(rename = "projectId")]
        project_id: String,
    },
}

impl ShellOwner {
    /// `Some(id)` for a session owner, `None` for a project owner — what
    /// `dispose_session_shells` filters on.
    fn as_session_id(&self) -> Option<&str> {
        match self {
            ShellOwner::Session { session_id } => Some(session_id),
            ShellOwner::Project { .. } => None,
        }
    }
}

// ---------- shell event payload (contract/shell-terminal.ts ShellEvent) ----------

#[derive(Serialize, Clone)]
#[serde(tag = "type")]
enum ShellEvent {
    #[serde(rename = "shell.data")]
    Data {
        #[serde(rename = "shellId")]
        shell_id: String,
        owner: ShellOwner,
        data: String,
    },
    #[serde(rename = "shell.exit")]
    Exit {
        #[serde(rename = "shellId")]
        shell_id: String,
        owner: ShellOwner,
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
    pub(crate) owner: ShellOwner,
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
    owner: ShellOwner,
    /// Registry-wide monotonic counter — yields per-owner creation order
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
            owner: self.owner.clone(),
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
    /// Per-owner locks serializing `shell_ensure`'s create-if-none path
    /// (FR-5, unbound-panes §5): `ensure_first` holds an owner's lock across
    /// its check-first/spawn/insert so concurrent `shell_ensure({owner})`
    /// calls for an owner with no shells yet attach to the first call's
    /// result instead of each spawning a shell. Entries are never removed —
    /// one `Arc<Mutex<()>>` per owner seen is cheap for the app's lifetime,
    /// and that's simpler than reclaiming them on session/pane removal.
    creation_locks: Mutex<HashMap<ShellOwner, Arc<Mutex<()>>>>,
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

    /// The `Arc<Mutex<()>>` guarding `owner`'s create-if-none slot, creating it
    /// on first use.
    fn creation_lock(&self, owner: &ShellOwner) -> Arc<Mutex<()>> {
        let mut locks = self.creation_locks.lock().unwrap();
        locks
            .entry(owner.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// `shell_ensure`'s create-if-none path (FR-5), race-free: if the owner
    /// already has a first shell, returns its id immediately. Otherwise
    /// acquires the owner's creation lock, re-checks (another caller may have
    /// won the race while this one waited for the lock), and only then runs
    /// `spawn` — so at most one shell is ever spawned per genuinely-empty
    /// owner no matter how many `shell_ensure` calls for it arrive
    /// concurrently; the rest attach to what the winner created instead of
    /// each spawning their own.
    pub(crate) fn ensure_first(
        &self,
        owner: &ShellOwner,
        spawn: impl FnOnce() -> Result<(String, PtyHandles, Arc<Mutex<Shared>>), String>,
    ) -> Result<String, String> {
        if let Some(first) = self.first_of_owner(owner) {
            return Ok(first);
        }
        let lock = self.creation_lock(owner);
        let _guard = lock.lock().unwrap();
        if let Some(first) = self.first_of_owner(owner) {
            return Ok(first);
        }
        let (id, pty, shared) = spawn()?;
        Ok(self.insert(id, owner.clone(), pty, shared).id)
    }

    /// An owner's shells in creation order (FR-1) — a project owner's strip is
    /// its own project-owned shells only, never a session's (unbound-panes §5).
    pub(crate) fn shells_of_owner(&self, owner: &ShellOwner) -> Vec<ShellInfo> {
        let state = self.lock();
        let mut entries: Vec<&ShellEntry> = state
            .shells
            .values()
            .filter(|e| &e.owner == owner)
            .collect();
        entries.sort_by_key(|e| e.seq);
        entries.into_iter().map(|e| e.info()).collect()
    }

    pub(crate) fn count_of_owner(&self, owner: &ShellOwner) -> usize {
        self.lock()
            .shells
            .values()
            .filter(|e| &e.owner == owner)
            .count()
    }

    pub(crate) fn at_cap(&self, owner: &ShellOwner) -> bool {
        self.count_of_owner(owner) >= SHELL_CAP
    }

    /// The id of the owner's first shell in creation order (FR-5), None if it
    /// has none.
    pub(crate) fn first_of_owner(&self, owner: &ShellOwner) -> Option<String> {
        let state = self.lock();
        state
            .shells
            .values()
            .filter(|e| &e.owner == owner)
            .min_by_key(|e| e.seq)
            .map(|e| e.id.clone())
    }

    pub(crate) fn get_info(&self, shell_id: &str) -> Option<ShellInfo> {
        self.lock().shells.get(shell_id).map(|e| e.info())
    }

    /// None: unknown id. Some(false): known but belongs to a different owner.
    /// Some(true): known and matches — both non-true cases are `SHELL_NOT_FOUND`
    /// at the API boundary (FR-5).
    pub(crate) fn belongs_to(&self, shell_id: &str, owner: &ShellOwner) -> Option<bool> {
        self.lock().shells.get(shell_id).map(|e| &e.owner == owner)
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
        owner: ShellOwner,
        pty: PtyHandles,
        shared: Arc<Mutex<Shared>>,
    ) -> ShellInfo {
        let mut state = self.lock();
        let seq = state.next_seq;
        state.next_seq += 1;
        let used = state
            .shells
            .values()
            .filter(|e| e.owner == owner && e.custom_name.is_none())
            .map(|e| e.ordinal);
        let ordinal = smallest_unused_ordinal(used);
        let entry = ShellEntry {
            id: id.clone(),
            owner,
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
        let owner = state.shells.get(shell_id)?.owner.clone();
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
                    .filter(|e| e.owner == owner && e.id != shell_id && e.custom_name.is_none())
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
    /// FR-9/unbound-panes §5: only `kind: 'session'` entries for `session_id` —
    /// a project-owned shell is never touched by this, even one rooted at that
    /// session's project.
    fn dispose_session(&self, session_id: &str) -> usize {
        let mut state = self.lock();
        let ids: Vec<String> = state
            .shells
            .values()
            .filter(|e| e.owner.as_session_id() == Some(session_id))
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
#[path = "registry_tests.rs"]
mod tests;
