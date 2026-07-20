// diff-view core — the `diff` domain (specs/diff-view.md). Drives the system `git`
// CLI against a session's cwd to compute change summaries, per-file unified diffs,
// stage-all and commit; watches the cwd + reacts to Edit/Write tool.done to keep
// the DIFF badge / chip strip live via `francois://diff/event`.
//
// Caching: only the per-cwd (root, base) pair is cached (REPO_CACHE — git.exe spawn
// overhead on Windows); summaries/diffs themselves are recomputed fresh. Per-session
// git ops are serialized (FR-14). Paths are always forward-slash (git emits '/').

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ipc::{err, ok, IpcResult};
use crate::session::Engine;

/// git's well-known empty-tree object — the diff base for a repo with no commits (FR-2).
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const NOT_A_REPO_MSG: &str = "not a git repository — initialize with `git init` in the shell";

// ---------- serialized public shapes (contract/diff-view.ts) ----------

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum DiffFileStatus {
    Modified,
    Added,
    Deleted,
    Untracked,
    Renamed,
}

#[derive(Serialize)]
struct DiffFileSummary {
    path: String,
    dir: String,
    name: String,
    additions: u64,
    deletions: u64,
    status: DiffFileStatus,
}

#[derive(Serialize)]
pub struct DiffSummary {
    files: Vec<DiffFileSummary>,
    #[serde(rename = "totalAdd")]
    total_add: u64,
    #[serde(rename = "totalDel")]
    total_del: u64,
}

#[derive(Serialize)]
struct DiffLine {
    kind: &'static str, // add | del | ctx (hunk headers live on DiffHunk.header)
    #[serde(rename = "oldNo", skip_serializing_if = "Option::is_none")]
    old_no: Option<u64>,
    #[serde(rename = "newNo", skip_serializing_if = "Option::is_none")]
    new_no: Option<u64>,
    text: String,
}

#[derive(Serialize)]
struct DiffHunk {
    header: String,
    lines: Vec<DiffLine>,
}

#[derive(Serialize)]
pub struct FileDiff {
    hunks: Vec<DiffHunk>,
    binary: bool,
}

#[derive(Serialize)]
pub struct CommitResult {
    #[serde(rename = "commitHash")]
    commit_hash: String,
}

// ---------- git runner ----------

struct GitOut {
    code: i32,
    stdout: Vec<u8>,
    stderr: String,
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash per git call
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

/// Run `git <args>` in cwd with an argv array (never a shell string — FR-13).
fn git(cwd: &str, args: &[&str]) -> std::io::Result<GitOut> {
    let mut c = Command::new("git");
    c.args(args).current_dir(cwd).stdin(Stdio::null());
    no_window(&mut c);
    let out = c.output()?;
    Ok(GitOut {
        code: out.status.code().unwrap_or(-1),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

type GitErr = (String, String); // (ErrorCode, message)

fn is_git_repo(cwd: &str) -> bool {
    matches!(git(cwd, &["rev-parse", "--is-inside-work-tree"]), Ok(o) if o.code == 0 && String::from_utf8_lossy(&o.stdout).trim() == "true")
}

/// HEAD when the repo has a commit, else the empty-tree object (FR-2).
fn diff_base(cwd: &str) -> String {
    match git(cwd, &["rev-parse", "--verify", "-q", "HEAD"]) {
        Ok(o) if o.code == 0 => "HEAD".into(),
        _ => EMPTY_TREE.into(),
    }
}

/// The worktree top level for a cwd, so all git commands run from the same base and
/// their repo-root-relative paths agree even when the session cwd is a subdirectory.
/// Falls back to cwd if resolution fails.
fn repo_root(cwd: &str) -> String {
    match git(cwd, &["rev-parse", "--show-toplevel"]) {
        Ok(o) if o.code == 0 => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                cwd.to_string()
            } else {
                s
            }
        }
        _ => cwd.to_string(),
    }
}

/// Cache of `cwd -> (worktree_root, stable_base)`. `git.exe` spawn overhead is ~100ms+
/// on Windows, and every diff op needs the root + base; without caching, each
/// `getFileDiff` fires 3 separate rev-parse probes before it even runs the diff. The
/// root of a cwd never changes. `stable_base` holds `Some("HEAD")` once a commit
/// exists (HEAD never reverts to no-commits in practice, so it's safe to pin); for a
/// commit-less repo it stays `None` and the base is recomputed each call (cheap, rare,
/// and self-corrects to `HEAD` on the first commit).
static REPO_CACHE: OnceLock<Mutex<HashMap<String, (String, Option<String>)>>> = OnceLock::new();

/// `(root, base)` for a cwd, or `None` if it isn't a git worktree. Serves the common
/// case (a repo with commits) entirely from cache after the first call — zero git spawns.
fn repo_info(cwd: &str) -> Option<(String, String)> {
    let cache = REPO_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((root, stable_base)) = cache.lock().unwrap().get(cwd).cloned() {
        return Some((root.clone(), stable_base.unwrap_or_else(|| diff_base(&root))));
    }
    if !is_git_repo(cwd) {
        return None;
    }
    let root = repo_root(cwd);
    let base = diff_base(&root);
    let stable = (base == "HEAD").then(|| "HEAD".to_string());
    cache.lock().unwrap().insert(cwd.to_string(), (root.clone(), stable));
    Some((root, base))
}

// ---------- parsers (pure — unit tested) ----------

fn num(s: &str) -> u64 {
    if s == "-" {
        0
    } else {
        s.trim().parse().unwrap_or(0)
    }
}

fn split_path(p: &str) -> (String, String) {
    match p.rfind('/') {
        Some(i) => (p[..i].to_string(), p[i + 1..].to_string()),
        None => (String::new(), p.to_string()),
    }
}

fn map_status(xy: &str) -> DiffFileStatus {
    if xy == "??" {
        return DiffFileStatus::Untracked;
    }
    // identity status wins: added > renamed > deleted > modified (FR-3).
    if xy.contains('A') {
        DiffFileStatus::Added
    } else if xy.starts_with('R') {
        DiffFileStatus::Renamed
    } else if xy.contains('D') {
        DiffFileStatus::Deleted
    } else {
        DiffFileStatus::Modified
    }
}

/// Parse `git status --porcelain=v1 -z` into (xy, path). Each record is
/// `XY<space>PATH\0`; a rename/copy (`R`/`C`) is followed by an extra NUL field
/// carrying the origin path (the new path comes first — we keep it, discard origin).
fn parse_porcelain_z(data: &[u8]) -> Vec<(String, String)> {
    let s = String::from_utf8_lossy(data);
    let tokens: Vec<&str> = s.split('\0').collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        i += 1;
        if tok.len() < 3 {
            continue; // trailing empty / malformed
        }
        let xy = tok[..2].to_string();
        let path = tok[3..].to_string(); // skip 2-char code + 1 space
        if xy.starts_with('R') || xy.starts_with('C') {
            i += 1; // consume + discard the origin-path field
        }
        out.push((xy, path));
    }
    out
}

/// Parse `git diff -z --numstat` into path -> (additions, deletions). Normal record
/// is `add\tdel\tpath\0`; a rename is `add\tdel\t\0oldpath\0newpath\0` (empty path
/// field signals rename; the new path is the second field). Binary is `-\t-`.
fn parse_numstat_z(data: &[u8]) -> HashMap<String, (u64, u64)> {
    let s = String::from_utf8_lossy(data);
    let tokens: Vec<&str> = s.split('\0').collect();
    let mut map = HashMap::new();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        i += 1;
        if tok.is_empty() {
            continue;
        }
        let mut parts = tok.splitn(3, '\t');
        let add = parts.next().unwrap_or("");
        let del = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        if del.is_empty() {
            continue; // not a numstat header — skip defensively
        }
        let counts = (num(add), num(del));
        let path = if rest.is_empty() {
            // rename: next two tokens are old, new
            i += 1; // old (discard)
            let new = tokens.get(i).copied().unwrap_or("");
            i += 1;
            new.to_string()
        } else {
            rest.to_string()
        };
        if !path.is_empty() {
            map.insert(path, counts);
        }
    }
    map
}

fn parse_hunk_header(line: &str) -> (u64, u64) {
    // Only read the `-a,b +c,d` between the first and second `@@`; git appends
    // function-context text after the closing `@@` that can contain `+`/`-` tokens.
    let (mut old, mut new) = (0u64, 0u64);
    let (mut in_range, mut got_old, mut got_new) = (false, false, false);
    for tok in line.split(' ') {
        if tok == "@@" {
            if in_range {
                break; // closing @@ — ignore trailing context
            }
            in_range = true;
            continue;
        }
        if !in_range {
            continue;
        }
        if let (false, Some(r)) = (got_old, tok.strip_prefix('-')) {
            old = r.split(',').next().unwrap_or("0").parse().unwrap_or(0);
            got_old = true;
        } else if let (false, Some(r)) = (got_new, tok.strip_prefix('+')) {
            new = r.split(',').next().unwrap_or("0").parse().unwrap_or(0);
            got_new = true;
        }
    }
    (old, new)
}

/// Parse a unified diff patch into hunks (FR-9). Preamble before the first `@@`
/// (diff --git / index / +++/--- lines) is skipped; the `\ No newline` marker is dropped.
fn parse_unified_diff(text: &str) -> Vec<DiffHunk> {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let (mut old_no, mut new_no) = (0u64, 0u64);
    for line in text.split('\n') {
        if line.starts_with("@@") {
            let (os, ns) = parse_hunk_header(line);
            old_no = os;
            new_no = ns;
            hunks.push(DiffHunk { header: line.to_string(), lines: Vec::new() });
            continue;
        }
        let Some(h) = hunks.last_mut() else { continue }; // still in preamble
        match line.as_bytes().first().copied() {
            Some(b' ') => {
                h.lines.push(DiffLine { kind: "ctx", old_no: Some(old_no), new_no: Some(new_no), text: line[1..].to_string() });
                old_no += 1;
                new_no += 1;
            }
            Some(b'+') if !line.starts_with("+++") => {
                h.lines.push(DiffLine { kind: "add", old_no: None, new_no: Some(new_no), text: line[1..].to_string() });
                new_no += 1;
            }
            Some(b'-') if !line.starts_with("---") => {
                h.lines.push(DiffLine { kind: "del", old_no: Some(old_no), new_no: None, text: line[1..].to_string() });
                old_no += 1;
            }
            _ => {} // `\ No newline`, blank tail, or stray line — dropped
        }
    }
    hunks
}

// ---------- summary + file diff ----------

/// Additions = full line count, deletions = 0 (FR-5) — computed IN-PROCESS. This used
/// to spawn `git diff --no-index --numstat` per untracked file, making every summary
/// cost O(untracked) git.exe spawns (~100ms each on Windows): a repo with a dozen new
/// files paid over a second per recompute. Semantics match numstat: binary (NUL in the
/// first 8 KiB) counts 0/0; a final line without a trailing newline still counts;
/// empty/unreadable → 0/0.
fn untracked_counts(root: &str, path: &str) -> (u64, u64) {
    use std::io::Read;
    let Ok(f) = std::fs::File::open(Path::new(root).join(path)) else {
        return (0, 0);
    };
    let mut reader = std::io::BufReader::with_capacity(64 * 1024, f);
    let mut buf = [0u8; 64 * 1024];
    let (mut lines, mut last, mut first) = (0u64, b'\n', true);
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if first {
                    if buf[..n.min(8192)].contains(&0) {
                        return (0, 0); // binary → numstat reports `-` → 0
                    }
                    first = false;
                }
                lines += buf[..n].iter().filter(|&&b| b == b'\n').count() as u64;
                last = buf[n - 1];
            }
            Err(_) => return (0, 0),
        }
    }
    if last != b'\n' {
        lines += 1; // unterminated final line still counts (git semantics)
    }
    (lines, 0)
}

fn compute_summary(cwd: &str) -> Result<DiffSummary, GitErr> {
    // Cached root + base (run everything from the worktree top so paths agree).
    let Some((root, base)) = repo_info(cwd) else {
        return Err(("NOT_A_GIT_REPO".into(), NOT_A_REPO_MSG.into()));
    };
    let st = git(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--renames"])
        .map_err(|e| ("GIT_ERROR".to_string(), e.to_string()))?;
    if st.code != 0 {
        return Err(("GIT_ERROR".into(), if st.stderr.is_empty() { "git status failed".into() } else { st.stderr }));
    }
    let numstat = git(&root, &["diff", &base, "-M", "-z", "--numstat"])
        .map_err(|e| ("GIT_ERROR".to_string(), e.to_string()))?;
    let counts = parse_numstat_z(&numstat.stdout);

    let mut files: Vec<DiffFileSummary> = parse_porcelain_z(&st.stdout)
        .into_iter()
        .map(|(xy, path)| {
            let status = map_status(&xy);
            let (additions, deletions) = if status == DiffFileStatus::Untracked {
                untracked_counts(&root, &path)
            } else {
                counts.get(&path).copied().unwrap_or((0, 0))
            };
            let (dir, name) = split_path(&path);
            DiffFileSummary { path, dir, name, additions, deletions, status }
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let total_add = files.iter().map(|f| f.additions).sum();
    let total_del = files.iter().map(|f| f.deletions).sum();
    Ok(DiffSummary { files, total_add, total_del })
}

fn compute_file_diff(cwd: &str, path: &str) -> Result<FileDiff, GitErr> {
    let Some((root, base)) = repo_info(cwd) else {
        return Err(("NOT_A_GIT_REPO".into(), NOT_A_REPO_MSG.into()));
    };
    // Targeted status for just this path — avoids re-running the whole summary (which
    // costs a full `git status` + numstat + a diff per untracked file). Big win on a
    // large repo where every chip click otherwise re-scans everything.
    let st = git(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", path])
        .map_err(|e| ("GIT_ERROR".to_string(), e.to_string()))?;
    if st.code != 0 {
        return Err(("GIT_ERROR".into(), if st.stderr.is_empty() { "git status failed".into() } else { st.stderr }));
    }
    // A path with no porcelain entry is not a currently-changed file → stale selection.
    let Some((xy, _)) = parse_porcelain_z(&st.stdout).into_iter().find(|(_, p)| p == path) else {
        return Err(("INVALID_INPUT".into(), format!("'{path}' is not in the current changes")));
    };
    let status = map_status(&xy);
    let out = if status == DiffFileStatus::Untracked {
        git(&root, &["diff", "--no-index", "--", "/dev/null", path])
    } else {
        git(&root, &["diff", &base, "-M", "--", path])
    }
    .map_err(|e| ("GIT_ERROR".to_string(), e.to_string()))?;

    // `--no-index` exit 1 = "files differ" (success); only >=2 is a real failure (FR-8).
    let failed = if status == DiffFileStatus::Untracked { out.code >= 2 } else { out.code != 0 };
    if failed {
        return Err(("GIT_ERROR".into(), if out.stderr.is_empty() { "git diff failed".into() } else { out.stderr }));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    if text.lines().any(|l| l.starts_with("Binary files") && l.contains("differ")) {
        return Ok(FileDiff { hunks: Vec::new(), binary: true });
    }
    Ok(FileDiff { hunks: parse_unified_diff(&text), binary: false })
}

// ---------- per-session git serialization (FR-14) ----------

static GIT_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

fn git_lock(session_id: &str) -> Arc<Mutex<()>> {
    let mut m = GIT_LOCKS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap();
    m.entry(session_id.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

// ---------- event broadcast (FR-17) ----------

fn broadcast(app: &AppHandle, session_id: &str, file_count: usize) {
    let _ = app.emit(
        "francois://diff/event",
        serde_json::json!({ "type": "diff.changed", "sessionId": session_id, "fileCount": file_count }),
    );
}

/// Recompute + broadcast under the session's git lock. Used by the watcher and
/// tool.done trigger; a NOT_A_GIT_REPO result clears the badge (fileCount 0).
fn recompute_and_broadcast(app: &AppHandle, session_id: &str, cwd: &str) {
    let lock = git_lock(session_id);
    let _g = lock.lock().unwrap();
    match compute_summary(cwd) {
        Ok(s) => broadcast(app, session_id, s.files.len()),
        Err((code, _)) if code == "NOT_A_GIT_REPO" => broadcast(app, session_id, 0),
        Err(_) => {} // transient git error — don't zero the badge
    }
}

/// Per-session recompute coalescer: at most ONE compute in flight; triggers that
/// arrive mid-compute set `dirty` so exactly one trailing compute follows. Without
/// this, a burst of Edit/Write tool.done events (one per edit, undebounced) plus the
/// watcher each spawn their own full `compute_summary` — a queue of O(burst) git
/// storms that serialize on the git lock and strobe diff.changed at the frontend.
struct RecomputeState {
    running: bool,
    dirty: bool,
}
static RECOMPUTES: OnceLock<Mutex<HashMap<String, RecomputeState>>> = OnceLock::new();

fn schedule_recompute(app: &AppHandle, session_id: &str, cwd: &str) {
    let states = RECOMPUTES.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let mut m = states.lock().unwrap();
        let st = m.entry(session_id.to_string()).or_insert(RecomputeState { running: false, dirty: false });
        if st.running {
            st.dirty = true; // fold into the in-flight run's trailing recompute
            return;
        }
        st.running = true;
    }
    let (app, sid, cwd) = (app.clone(), session_id.to_string(), cwd.to_string());
    std::thread::spawn(move || loop {
        recompute_and_broadcast(&app, &sid, &cwd);
        let mut m = RECOMPUTES.get().unwrap().lock().unwrap();
        let Some(st) = m.get_mut(&sid) else { break }; // session unwatched mid-run
        if st.dirty {
            st.dirty = false;
            drop(m);
            continue; // one trailing recompute picks up everything that arrived mid-run
        }
        st.running = false;
        break;
    });
}

// ---------- session-engine triggers (called from session.rs) ----------

/// FR-16: an Edit/Write tool finished → recompute immediately when idle (off-thread,
/// so the reader thread that emitted tool.done isn't blocked on git); bursts coalesce
/// into ≤ one in-flight + one trailing compute via `schedule_recompute`.
pub fn on_tool_done(app: &AppHandle, session_id: &str, cwd: &str) {
    schedule_recompute(app, session_id, cwd);
}

// ---------- fs watcher (FR-15) ----------

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

static WATCHERS: OnceLock<Mutex<HashMap<String, RecommendedWatcher>>> = OnceLock::new();

/// Skip events inside `.git/` (our own index/ref writes) and inside well-known heavy
/// build / dependency directories. Recursively watching a multi-GB `target/` or
/// `node_modules` and recomputing on its churn makes the DIFF panel lag badly — so,
/// like every mainstream file-watcher (chokidar, watchman, …), we hardcode a skip
/// list. These dirs are `.gitignore`'d in practice, so git already excludes them from
/// the summary; the only tradeoff is a *tracked* file living directly under a dir
/// literally named one of these, whose live update would be missed (any other change,
/// or reopening the tab, still refreshes it).
fn is_ignored_path(p: &Path, root: &Path) -> bool {
    // Match only the path *below* the watched root: a session whose cwd itself lives
    // under a dir named e.g. `build`/`vendor`/`.cache` must not have EVERY event
    // ignored — that would silently disable the watcher entirely (H1).
    p.strip_prefix(root)
        .unwrap_or(p)
        .components()
        .any(|c| {
            matches!(
                c.as_os_str().to_str(),
                Some(
                    ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".nuxt" | ".svelte-kit"
                        | ".venv" | "venv" | "__pycache__" | ".turbo" | ".cache" | ".gradle" | "vendor"
                )
            )
        })
}

/// Start a recursive watcher on a session's cwd (idempotent). On any relevant event,
/// debounce 300ms then recompute + broadcast.
pub fn watch_session(app: &AppHandle, session_id: &str, cwd: &str) {
    let reg = WATCHERS.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let map = reg.lock().unwrap();
        if map.contains_key(session_id) {
            return;
        }
    }
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let root = Path::new(cwd).to_path_buf();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| !is_ignored_path(p, &root)) {
                let _ = tx.send(());
            }
        }
    }) {
        Ok(w) => w,
        Err(_) => return,
    };
    if watcher.watch(Path::new(cwd), RecursiveMode::Recursive).is_err() {
        return;
    }

    let (app2, sid2, cwd2) = (app.clone(), session_id.to_string(), cwd.to_string());
    std::thread::spawn(move || {
        use std::sync::mpsc::RecvTimeoutError;
        loop {
            if rx.recv().is_err() {
                break; // watcher dropped → stop
            }
            // debounce: coalesce a burst, fire 300ms after the last event
            loop {
                match rx.recv_timeout(std::time::Duration::from_millis(300)) {
                    Ok(()) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            schedule_recompute(&app2, &sid2, &cwd2);
        }
    });
    reg.lock().unwrap().insert(session_id.to_string(), watcher);
}

/// Dispose a session's watcher (dropping it stops the fs events and ends the
/// debounce thread via channel disconnect) and drop its git lock entry.
pub fn unwatch_session(session_id: &str) {
    if let Some(reg) = WATCHERS.get() {
        reg.lock().unwrap().remove(session_id);
    }
    if let Some(locks) = GIT_LOCKS.get() {
        locks.lock().unwrap().remove(session_id);
    }
    if let Some(states) = RECOMPUTES.get() {
        states.lock().unwrap().remove(session_id); // in-flight loop sees the gap and stops
    }
}

// ---------- commands (francois:diff:<verb>) ----------

fn cwd_or_err<T: Serialize>(engine: &State<'_, Engine>, session_id: &str) -> Result<String, IpcResult<T>> {
    engine.cwd_of(session_id).ok_or_else(|| err("SESSION_NOT_FOUND", "no such session"))
}

// All diff commands are `async` so Tauri executes them on the async runtime — a
// SYNC command runs on the MAIN thread (Tauri 2), where every git spawn and every
// git-lock wait freezes the entire app (window moves, all panes, all IPC). With
// changes present, a background recompute holds the session git lock while the
// frontend refetches → the sync command blocked the main thread on that lock for
// the full multi-spawn summary. Bodies stay synchronous; parking a runtime worker
// on a git call is fine. Engine is resolved via `app.state()` instead of a
// `State<'_, Engine>` parameter: an async command's future must be 'static, and a
// borrowed State param breaks that (E0597 in the generated handler).
#[tauri::command]
pub async fn diff_get_summary(app: AppHandle, session_id: String) -> IpcResult<DiffSummary> {
    let engine = app.state::<Engine>();
    let cwd = match cwd_or_err(&engine, &session_id) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let lock = git_lock(&session_id);
    let _g = lock.lock().unwrap();
    match compute_summary(&cwd) {
        Ok(s) => {
            broadcast(&app, &session_id, s.files.len()); // FR-17
            ok(s)
        }
        Err((code, msg)) => err(&code, msg),
    }
}

#[tauri::command]
pub async fn diff_get_file_diff(app: AppHandle, session_id: String, path: String) -> IpcResult<FileDiff> {
    let engine = app.state::<Engine>();
    let cwd = match cwd_or_err(&engine, &session_id) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let lock = git_lock(&session_id);
    let _g = lock.lock().unwrap();
    match compute_file_diff(&cwd, &path) {
        Ok(d) => ok(d),
        Err((code, msg)) => err(&code, msg),
    }
}

#[tauri::command]
pub async fn diff_stage_all(app: AppHandle, session_id: String) -> IpcResult<Option<()>> {
    let engine = app.state::<Engine>();
    let cwd = match cwd_or_err(&engine, &session_id) {
        Ok(c) => c,
        Err(e) => return e,
    };
    if !is_git_repo(&cwd) {
        return err("NOT_A_GIT_REPO", NOT_A_REPO_MSG);
    }
    let lock = git_lock(&session_id);
    let _g = lock.lock().unwrap();
    let root = repo_root(&cwd);
    match git(&root, &["add", "-A"]) {
        Ok(o) if o.code == 0 => ok(None), // succeeds even with nothing to stage (FR-10)
        Ok(o) => err("GIT_ERROR", if o.stderr.is_empty() { "git add failed".into() } else { o.stderr }),
        Err(e) => err("GIT_ERROR", e.to_string()),
    }
}

#[tauri::command]
pub async fn diff_commit(app: AppHandle, session_id: String, message: String) -> IpcResult<CommitResult> {
    let engine = app.state::<Engine>();
    let cwd = match cwd_or_err(&engine, &session_id) {
        Ok(c) => c,
        Err(e) => return e,
    };
    if message.trim().is_empty() {
        return err("INVALID_INPUT", "commit message is empty"); // defense in depth (FR-24)
    }
    if !is_git_repo(&cwd) {
        return err("NOT_A_GIT_REPO", NOT_A_REPO_MSG);
    }
    let lock = git_lock(&session_id);
    let _g = lock.lock().unwrap();
    let root = repo_root(&cwd);

    // FR-11: nothing staged → `git diff --cached --quiet` exits 0.
    match git(&root, &["diff", "--cached", "--quiet"]) {
        Ok(o) if o.code == 0 => return err("GIT_ERROR", "nothing staged to commit — stage changes first"),
        Ok(_) => {}
        Err(e) => return err("GIT_ERROR", e.to_string()),
    }
    match git(&root, &["commit", "-m", message.trim()]) {
        Ok(o) if o.code == 0 => {}
        Ok(o) => return err("GIT_ERROR", if o.stderr.is_empty() { "git commit failed".into() } else { o.stderr }),
        Err(e) => return err("GIT_ERROR", e.to_string()),
    }
    match git(&root, &["rev-parse", "HEAD"]) {
        Ok(o) if o.code == 0 => ok(CommitResult { commit_hash: String::from_utf8_lossy(&o.stdout).trim().to_string() }),
        _ => ok(CommitResult { commit_hash: String::new() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_z_parses_rename_and_discards_origin() {
        let data = b"R  renamed.txt\0torename.txt\0 M tracked.txt\0?? bin.dat\0?? untracked.txt\0";
        let out = parse_porcelain_z(data);
        assert_eq!(
            out,
            vec![
                ("R ".to_string(), "renamed.txt".to_string()),
                (" M".to_string(), "tracked.txt".to_string()),
                ("??".to_string(), "bin.dat".to_string()),
                ("??".to_string(), "untracked.txt".to_string()),
            ]
        );
    }

    #[test]
    fn numstat_z_parses_rename_new_path() {
        let data = b"0\t0\t\0torename.txt\0renamed.txt\x002\t1\ttracked.txt\0";
        let m = parse_numstat_z(data);
        assert_eq!(m.get("renamed.txt"), Some(&(0, 0)));
        assert_eq!(m.get("tracked.txt"), Some(&(2, 1)));
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn numstat_binary_is_zero() {
        let m = parse_numstat_z(b"-\t-\tbin.dat\0");
        assert_eq!(m.get("bin.dat"), Some(&(0, 0)));
    }

    #[test]
    fn status_precedence() {
        assert_eq!(map_status("??"), DiffFileStatus::Untracked);
        assert_eq!(map_status("AM"), DiffFileStatus::Added); // added wins
        assert_eq!(map_status("R "), DiffFileStatus::Renamed);
        assert_eq!(map_status("RM"), DiffFileStatus::Renamed); // rename identity wins over M
        assert_eq!(map_status(" D"), DiffFileStatus::Deleted);
        assert_eq!(map_status(" M"), DiffFileStatus::Modified);
        assert_eq!(map_status("MM"), DiffFileStatus::Modified);
    }

    #[test]
    fn split_path_repo_root_and_nested() {
        assert_eq!(split_path("file.rs"), ("".to_string(), "file.rs".to_string()));
        assert_eq!(split_path("src/auth/mw.ts"), ("src/auth".to_string(), "mw.ts".to_string()));
    }

    #[test]
    fn unified_diff_line_numbers_and_kinds() {
        let patch = "diff --git a/f b/f\nindex 000..111 100644\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n line1\n-line2\n+CHANGED\n+added\n line3\n\\ No newline at end of file\n";
        let hunks = parse_unified_diff(patch);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].header, "@@ -1,3 +1,4 @@");
        let l = &hunks[0].lines;
        assert_eq!(l.len(), 5); // ctx, del, add, add, ctx  ('\ No newline' dropped)
        assert_eq!((l[0].kind, l[0].old_no, l[0].new_no), ("ctx", Some(1), Some(1)));
        assert_eq!((l[1].kind, l[1].old_no, l[1].new_no, l[1].text.as_str()), ("del", Some(2), None, "line2"));
        assert_eq!((l[2].kind, l[2].old_no, l[2].new_no, l[2].text.as_str()), ("add", None, Some(2), "CHANGED"));
        assert_eq!((l[3].kind, l[3].new_no), ("add", Some(3)));
        assert_eq!((l[4].kind, l[4].old_no, l[4].new_no), ("ctx", Some(3), Some(4)));
    }

    #[test]
    fn hunk_header_without_line_counts() {
        assert_eq!(parse_hunk_header("@@ -1 +1 @@"), (1, 1));
        assert_eq!(parse_hunk_header("@@ -10,3 +12,5 @@ fn foo()"), (10, 12));
    }

    #[test]
    fn hunk_header_ignores_context_with_plus_minus_tokens() {
        // trailing function-context containing '-'/'+' tokens must not hijack the counters (M6)
        assert_eq!(parse_hunk_header("@@ -10,6 +20,6 @@ def f(a - b + c):"), (10, 20));
        assert_eq!(parse_hunk_header("@@ -1,4 +1,5 @@ - bullet + item"), (1, 1));
    }

    #[test]
    fn unified_diff_multi_hunk_resets_counters_per_hunk() {
        let patch = "@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -50,2 +80,3 @@\n x\n+Y\n z\n";
        let hunks = parse_unified_diff(patch);
        assert_eq!(hunks.len(), 2);
        // first hunk starts at old 1 / new 1
        assert_eq!((hunks[0].lines[0].old_no, hunks[0].lines[0].new_no), (Some(1), Some(1)));
        assert_eq!((hunks[0].lines[1].kind, hunks[0].lines[1].old_no), ("del", Some(2)));
        // second hunk resets to old 50 / new 80
        assert_eq!((hunks[1].lines[0].kind, hunks[1].lines[0].old_no, hunks[1].lines[0].new_no), ("ctx", Some(50), Some(80)));
        assert_eq!((hunks[1].lines[1].kind, hunks[1].lines[1].new_no), ("add", Some(81)));
        assert_eq!((hunks[1].lines[2].kind, hunks[1].lines[2].old_no, hunks[1].lines[2].new_no), ("ctx", Some(51), Some(82)));
    }

    #[test]
    fn num_parses_counts_and_binary_dash() {
        assert_eq!(num("0"), 0);
        assert_eq!(num("42"), 42);
        assert_eq!(num("-"), 0); // git's binary marker
        assert_eq!(num(""), 0);
    }

    #[test]
    fn untracked_counts_in_process() {
        let dir = std::env::temp_dir().join("francois-untracked-counts-test");
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        std::fs::write(dir.join("two.txt"), "one\ntwo\n").unwrap();
        assert_eq!(untracked_counts(&root, "two.txt"), (2, 0));
        // final line without trailing newline still counts (git numstat semantics)
        std::fs::write(dir.join("noeol.txt"), "one\ntwo").unwrap();
        assert_eq!(untracked_counts(&root, "noeol.txt"), (2, 0));
        std::fs::write(dir.join("empty.txt"), "").unwrap();
        assert_eq!(untracked_counts(&root, "empty.txt"), (0, 0));
        // NUL in the first 8 KiB → binary → 0/0, like numstat's `-`
        std::fs::write(dir.join("bin.dat"), b"ab\0cd\n\n").unwrap();
        assert_eq!(untracked_counts(&root, "bin.dat"), (0, 0));
        // unreadable/missing → 0/0 (best-effort, matches the old spawn-failure path)
        assert_eq!(untracked_counts(&root, "missing.txt"), (0, 0));
    }

    #[test]
    fn ignored_path_skips_git_and_heavy_dirs() {
        use std::path::Path;
        let root = Path::new("/home/u/proj");
        // heavy build/dependency dirs *inside* the repo are skipped so their churn can't storm the watcher
        assert!(is_ignored_path(Path::new("/home/u/proj/.git/index"), root));
        assert!(is_ignored_path(Path::new("/home/u/proj/a/b/.git/HEAD"), root));
        assert!(is_ignored_path(Path::new("/home/u/proj/node_modules/pkg/index.js"), root));
        assert!(is_ignored_path(Path::new("/home/u/proj/target/debug/francois.exe"), root));
        assert!(is_ignored_path(Path::new("/home/u/proj/dist/bundle.js"), root));
        assert!(is_ignored_path(Path::new("/home/u/proj/a/b/__pycache__/x.pyc"), root));
        // ordinary source paths are watched
        assert!(!is_ignored_path(Path::new("/home/u/proj/src/main.rs"), root));
        assert!(!is_ignored_path(Path::new("/home/u/proj/contract/common.ts"), root));
        // H1 regression: when the repo ROOT path itself contains an ignored segment
        // (the project lives under `.../build/plugin`), only segments BELOW the root
        // count — its files must still be watched, not all silently ignored.
        let nested = Path::new("/home/u/build/plugin");
        assert!(!is_ignored_path(Path::new("/home/u/build/plugin/src/main.rs"), nested));
        assert!(is_ignored_path(Path::new("/home/u/build/plugin/target/x"), nested));
    }
}
