//! per-session git serialization, the fs watcher, and event broadcast.

use super::*;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

use crate::wsl;

// ---------- per-session git serialization (FR-14) ----------

pub(crate) static GIT_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

pub(crate) fn git_lock(session_id: &str) -> Arc<Mutex<()>> {
    let mut m = GIT_LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    m.entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

// ---------- event broadcast (FR-17) ----------

pub(crate) fn broadcast(app: &AppHandle, session_id: &str, file_count: usize) {
    let _ = app.emit(
        "francois://diff/event",
        serde_json::json!({ "type": "diff.changed", "sessionId": session_id, "fileCount": file_count }),
    );
}

/// Recompute + broadcast under the session's git lock. Used by the watcher and
/// tool.done trigger; a NOT_A_GIT_REPO result clears the badge (fileCount 0).
pub(crate) fn recompute_and_broadcast(app: &AppHandle, session_id: &str, cwd: &str) {
    let lock = git_lock(session_id);
    let _g = lock.lock().unwrap();
    match compute_summary(cwd, None) {
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
pub(crate) struct RecomputeState {
    running: bool,
    dirty: bool,
}
pub(crate) static RECOMPUTES: OnceLock<Mutex<HashMap<String, RecomputeState>>> = OnceLock::new();

pub(crate) fn schedule_recompute(app: &AppHandle, session_id: &str, cwd: &str) {
    let states = RECOMPUTES.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let mut m = states.lock().unwrap();
        let st = m.entry(session_id.to_string()).or_insert(RecomputeState {
            running: false,
            dirty: false,
        });
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

pub(crate) static WATCHERS: OnceLock<Mutex<HashMap<String, RecommendedWatcher>>> = OnceLock::new();

/// Skip events inside `.git/` (our own index/ref writes) and inside well-known heavy
/// build / dependency directories. Recursively watching a multi-GB `target/` or
/// `node_modules` and recomputing on its churn makes the DIFF panel lag badly — so,
/// like every mainstream file-watcher (chokidar, watchman, …), we hardcode a skip
/// list. These dirs are `.gitignore`'d in practice, so git already excludes them from
/// the summary; the only tradeoff is a *tracked* file living directly under a dir
/// literally named one of these, whose live update would be missed (any other change,
/// or reopening the tab, still refreshes it).
pub(crate) fn is_ignored_path(p: &Path, root: &Path) -> bool {
    // Match only the path *below* the watched root: a session whose cwd itself lives
    // under a dir named e.g. `build`/`vendor`/`.cache` must not have EVERY event
    // ignored — that would silently disable the watcher entirely (H1).
    p.strip_prefix(root).unwrap_or(p).components().any(|c| {
        matches!(
            c.as_os_str().to_str(),
            Some(
                ".git"
                    | "node_modules"
                    | "target"
                    | "dist"
                    | "build"
                    | ".next"
                    | ".nuxt"
                    | ".svelte-kit"
                    | ".venv"
                    | "venv"
                    | "__pycache__"
                    | ".turbo"
                    | ".cache"
                    | ".gradle"
                    | "vendor"
            )
        )
    })
}

/// Start a recursive watcher on a session's cwd (idempotent). On any relevant event,
/// debounce 300ms then recompute + broadcast.
pub fn watch_session(app: &AppHandle, session_id: &str, cwd: &str) {
    // wsl-filesystem FR-8: no watcher over 9P — `\\wsl$`/`\\wsl.localhost` change
    // notifications are unreliable, and a "watcher" that silently never fires is
    // worse than none. Freshness for these sessions instead comes from tool.done
    // recomputes, DIFF tab activation, and stage/commit (all unaffected, spec §7).
    // Drive-letter repos keep the recursive watcher regardless of runtime.
    if wsl::is_wsl_unc_path(cwd) {
        return;
    }
    let reg = WATCHERS.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let map = reg.lock().unwrap();
        if map.contains_key(session_id) {
            return;
        }
    }
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let root = Path::new(cwd).to_path_buf();
    let mut watcher =
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if ev.paths.iter().any(|p| !is_ignored_path(p, &root)) {
                    let _ = tx.send(());
                }
            }
        }) {
            Ok(w) => w,
            Err(_) => return,
        };
    if watcher
        .watch(Path::new(cwd), RecursiveMode::Recursive)
        .is_err()
    {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignored_path_skips_git_and_heavy_dirs() {
        use std::path::Path;
        let root = Path::new("/home/u/proj");
        // heavy build/dependency dirs *inside* the repo are skipped so their churn can't storm the watcher
        assert!(is_ignored_path(Path::new("/home/u/proj/.git/index"), root));
        assert!(is_ignored_path(
            Path::new("/home/u/proj/a/b/.git/HEAD"),
            root
        ));
        assert!(is_ignored_path(
            Path::new("/home/u/proj/node_modules/pkg/index.js"),
            root
        ));
        assert!(is_ignored_path(
            Path::new("/home/u/proj/target/debug/francois.exe"),
            root
        ));
        assert!(is_ignored_path(
            Path::new("/home/u/proj/dist/bundle.js"),
            root
        ));
        assert!(is_ignored_path(
            Path::new("/home/u/proj/a/b/__pycache__/x.pyc"),
            root
        ));
        // ordinary source paths are watched
        assert!(!is_ignored_path(
            Path::new("/home/u/proj/src/main.rs"),
            root
        ));
        assert!(!is_ignored_path(
            Path::new("/home/u/proj/contract/common.ts"),
            root
        ));
        // H1 regression: when the repo ROOT path itself contains an ignored segment
        // (the project lives under `.../build/plugin`), only segments BELOW the root
        // count — its files must still be watched, not all silently ignored.
        let nested = Path::new("/home/u/build/plugin");
        assert!(!is_ignored_path(
            Path::new("/home/u/build/plugin/src/main.rs"),
            nested
        ));
        assert!(is_ignored_path(
            Path::new("/home/u/build/plugin/target/x"),
            nested
        ));
    }
}
