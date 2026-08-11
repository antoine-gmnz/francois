//! FR-3..FR-5, FR-7 — the detection predicates and the per-root cache.
//!
//! A predicate is a filesystem or PATH question and NEVER executes repo-supplied
//! content: `cohorte` reads one JSON key, `git` stats a path, and `docker` runs
//! `docker info` — a fixed argv under every provider cap. Detection grants
//! nothing but whether a tab is offered.
//!
//! FR-4: results are cached per NORMALIZED root and reused on every session
//! switch and tab open. There is no watcher and no TTL — only an explicit
//! `extensions_detect`, a project (re)open, or an app restart invalidates.

use super::provider::{run_predicate, ProviderError};
use super::{DetectSpec, ExtensionDefinition};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// One extension's answer for one root. `reason` is the copy the Extensions
/// modal renders next to `unavailable here` (FR-56) — always present when the
/// answer is negative, so a panel is never silently missing.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Detection {
    pub detected: bool,
    pub reason: Option<String>,
}

impl Detection {
    fn yes() -> Detection {
        Detection {
            detected: true,
            reason: None,
        }
    }

    fn no(reason: &str) -> Detection {
        Detection {
            detected: false,
            reason: Some(reason.to_string()),
        }
    }
}

/// FR-14: with no active session there is no root to evaluate against, so every
/// extension reports `detected: false` WITH a reason. This governs whether a NEW
/// tab is offered; it never closes an open one.
pub(crate) const NO_ROOT_REASON: &str = "select a session";

/// FR-7: an exec predicate for a disabled extension is not run AT ALL — off
/// means off, including for detection. The two filesystem predicates spawn
/// nothing, so they still answer honestly while disabled.
pub(crate) const NOT_PROBED_REASON: &str = "turned off — nothing was probed";

/// FR-4: the cache key. Trailing separators and `.`/`..` segments must not mint
/// a second entry for the same project, so the root is canonicalized where the
/// filesystem allows it and passed through untouched where it does not (a root
/// that no longer exists still needs a stable key).
pub(crate) fn normalize_root(root: &str) -> PathBuf {
    let path = PathBuf::from(root);
    std::fs::canonicalize(&path).unwrap_or(path)
}

/// FR-4: `root -> extensionId -> Detection`. In memory only (§6) — it rebuilds
/// on restart, which is one of the three ways it is invalidated.
#[derive(Default)]
pub(crate) struct DetectCache {
    entries: HashMap<PathBuf, HashMap<String, Detection>>,
}

impl DetectCache {
    pub(crate) fn get(&self, root: &Path, extension_id: &str) -> Option<&Detection> {
        self.entries.get(root)?.get(extension_id)
    }

    pub(crate) fn put(&mut self, root: &Path, extension_id: &str, detection: Detection) {
        self.entries
            .entry(root.to_path_buf())
            .or_default()
            .insert(extension_id.to_string(), detection);
    }

    /// FR-57: `Re-detect` drops this root's whole entry so every predicate runs
    /// again — including the `docker info` exec.
    pub(crate) fn invalidate(&mut self, root: &Path) {
        self.entries.remove(root);
    }

    #[cfg(test)]
    pub(crate) fn is_cached(&self, root: &Path, extension_id: &str) -> bool {
        self.get(root, extension_id).is_some()
    }
}

// ---------- FR-3: the predicates ----------

/// `<root>/<rel>` parses as JSON and carries `key == value`. Reading one string
/// out of a JSON document is the whole of it: nothing in the file is executed,
/// and no other key of it is ever consulted.
pub(crate) fn json_key_holds(root: &Path, rel: &str, key: &str, value: &str) -> bool {
    let Ok(bytes) = std::fs::read(root.join(rel)) else {
        return false;
    };
    let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    doc.get(key).and_then(|v| v.as_str()) == Some(value)
}

/// `<root>/<rel>` exists as a FILE or a DIRECTORY — a linked worktree's `.git`
/// is a file, and `exists()` alone would also miss a broken symlink.
pub(crate) fn path_exists(root: &Path, rel: &str) -> bool {
    let path = root.join(rel);
    path.exists() || std::fs::symlink_metadata(&path).is_ok()
}

/// Evaluate one predicate against one root. `enabled == false` short-circuits
/// the exec predicate ONLY (FR-7): nothing is spawned for a disabled extension,
/// on any path, including this one.
pub(crate) fn evaluate(spec: &DetectSpec, root: &Path, enabled: bool) -> Detection {
    match spec {
        DetectSpec::JsonKey {
            rel,
            key,
            value,
            reason,
        } => {
            if json_key_holds(root, rel, key, value) {
                Detection::yes()
            } else {
                Detection::no(reason)
            }
        }
        DetectSpec::PathExists { rel, reason } => {
            if path_exists(root, rel) {
                Detection::yes()
            } else {
                Detection::no(reason)
            }
        }
        DetectSpec::CommandOk {
            argv,
            missing_reason,
            failed_reason,
        } => {
            if !enabled {
                return Detection::no(NOT_PROBED_REASON);
            }
            let argv: Vec<String> = argv.iter().map(|a| (*a).to_string()).collect();
            match run_predicate(&argv, root) {
                Ok(()) => Detection::yes(),
                // FR-24: the binary is not there at all.
                Err(ProviderError::Missing { .. }) => Detection::no(missing_reason),
                // §7: `docker info` hanging is the FR-21 timeout, and reads as
                // the daemon being unreachable — the same as a non-zero exit.
                Err(_) => Detection::no(failed_reason),
            }
        }
    }
}

/// FR-4/FR-5: the cached read. A cached answer is reused on every session
/// switch and every tab open, so `docker info` runs once per root per app run.
/// NEVER holds `cache_mutex` while `evaluate` runs — a cache miss executes the
/// predicate (including the FR-21-capped `docker info`) with the lock
/// released, and only re-acquires it to record the result. This keeps a slow
/// or blocked exec predicate for one root from stalling every other
/// `extensions_list`/`extensions_detect`/`extensions_panel` call in the app.
pub(crate) fn detect_cached_locked(
    cache_mutex: &Mutex<DetectCache>,
    ext: &ExtensionDefinition,
    root: &Path,
    enabled: bool,
) -> Detection {
    if let Some(hit) = cache_mutex.lock().unwrap().get(root, ext.id) {
        return hit.clone();
    }
    let detection = evaluate(&ext.detect, root, enabled);
    let mut cache = cache_mutex.lock().unwrap();
    // FR-7: the "not probed" answer describes the TOGGLE, not the root — caching
    // it would outlive the toggle it came from.
    if detection.reason.as_deref() != Some(NOT_PROBED_REASON) {
        cache.put(root, ext.id, detection.clone());
    }
    detection
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::registry;
    use crate::extensions::testutil::tmp_root;

    // FR-3: cohorte is detected by ONE key of `.claude/pipeline.json`.
    #[test]
    fn cohorte_is_detected_by_the_pipeline_key() {
        let root = tmp_root("detect-cohorte");
        let spec = &registry::extension("cohorte").unwrap().detect;
        assert!(!evaluate(spec, &root, true).detected);

        std::fs::create_dir_all(root.join(".claude")).unwrap();
        std::fs::write(
            root.join(".claude/pipeline.json"),
            br#"{"pipeline":"other"}"#,
        )
        .unwrap();
        assert!(!evaluate(spec, &root, true).detected);

        std::fs::write(root.join(".claude/pipeline.json"), b"{not json").unwrap();
        assert!(!evaluate(spec, &root, true).detected);

        std::fs::write(
            root.join(".claude/pipeline.json"),
            br#"{"pipeline":"cohorte","name":"Francois"}"#,
        )
        .unwrap();
        assert!(evaluate(spec, &root, true).detected);
    }

    // FR-3: `.git` as a FILE counts — that is what a linked worktree has.
    #[test]
    fn git_is_detected_by_a_dot_git_file_or_directory() {
        let root = tmp_root("detect-git");
        let spec = &registry::extension("git").unwrap().detect;
        let miss = evaluate(spec, &root, true);
        assert!(!miss.detected);
        assert_eq!(miss.reason.as_deref(), Some("not a git repository"));

        std::fs::write(root.join(".git"), b"gitdir: /elsewhere/.git/worktrees/x").unwrap();
        assert!(evaluate(spec, &root, true).detected);

        let dir_root = tmp_root("detect-git-dir");
        std::fs::create_dir_all(dir_root.join(".git")).unwrap();
        assert!(evaluate(spec, &dir_root, true).detected);
    }

    // FR-7: OFF MEANS OFF. The exec predicate does not run for a disabled
    // extension, and the answer says so rather than blaming the machine.
    #[test]
    fn a_disabled_extension_never_runs_its_exec_predicate() {
        let root = tmp_root("detect-docker-off");
        let spec = &registry::extension("docker").unwrap().detect;
        let detection = evaluate(spec, &root, false);
        assert!(!detection.detected);
        assert_eq!(detection.reason.as_deref(), Some(NOT_PROBED_REASON));
    }

    // FR-7: a filesystem predicate spawns nothing, so a disabled extension still
    // answers honestly about the root — the modal shows a real state.
    #[test]
    fn a_disabled_extension_still_answers_its_filesystem_predicate() {
        let root = tmp_root("detect-git-off");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let spec = &registry::extension("git").unwrap().detect;
        assert!(evaluate(spec, &root, false).detected);
    }

    // FR-4: the answer is cached per root and reused — a second read does not
    // re-run the predicate, which is what keeps `docker info` off the session
    // switch path (FR-5).
    #[test]
    fn a_detection_is_cached_per_root() {
        let root = tmp_root("detect-cache");
        let git = registry::extension("git").unwrap();
        let cache = Mutex::new(DetectCache::default());
        assert!(!cache.lock().unwrap().is_cached(&root, "git"));
        assert!(!detect_cached_locked(&cache, git, &root, true).detected);
        assert!(cache.lock().unwrap().is_cached(&root, "git"));

        // The root becomes a repo — the CACHE still answers no (FR-4: no
        // watcher, no TTL).
        std::fs::create_dir_all(root.join(".git")).unwrap();
        assert!(!detect_cached_locked(&cache, git, &root, true).detected);

        // FR-57: only an explicit re-detect re-runs the predicate.
        cache.lock().unwrap().invalidate(&root);
        assert!(detect_cached_locked(&cache, git, &root, true).detected);
    }

    // FR-7: the "not probed" answer describes the toggle, so it must not be
    // cached against the root and outlive it.
    #[test]
    fn the_not_probed_answer_is_never_cached() {
        let root = tmp_root("detect-cache-off");
        let docker = registry::extension("docker").unwrap();
        let cache = Mutex::new(DetectCache::default());
        detect_cached_locked(&cache, docker, &root, false);
        assert!(!cache.lock().unwrap().is_cached(&root, "docker"));
    }

    // CRITICAL fix: `detect_cached_locked` must not hold `cache_mutex` while a
    // slow `CommandOk` predicate (e.g. `docker info`) runs, or one root's exec
    // would stall every other root's read. Proven with a real second thread: a
    // ~150ms `sleep`-backed predicate is in flight on one root while a plain
    // (uncached) read of a DIFFERENT root races it — if the lock were held
    // across `evaluate`, the second read would be forced to wait ~150ms too;
    // instead it completes immediately.
    #[test]
    fn detect_cached_locked_does_not_hold_the_lock_across_a_slow_evaluate() {
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        let slow_root = tmp_root("detect-cache-lock-free-slow");
        let fast_root = tmp_root("detect-cache-lock-free-fast");
        let cache = Arc::new(Mutex::new(DetectCache::default()));

        let slow = ExtensionDefinition {
            id: "test-slow",
            label: "Slow",
            min_version_label: None,
            detect: DetectSpec::CommandOk {
                argv: &["sleep", "0.15"],
                missing_reason: "missing",
                failed_reason: "failed",
            },
            panels: &[],
        };

        let cache_for_thread = cache.clone();
        let slow_root_for_thread = slow_root.clone();
        let handle = std::thread::spawn(move || {
            detect_cached_locked(&cache_for_thread, &slow, &slow_root_for_thread, true)
        });

        // Give the slow evaluate a moment to actually start before racing it.
        std::thread::sleep(Duration::from_millis(30));
        let started = Instant::now();
        cache
            .lock()
            .unwrap()
            .put(&fast_root, "git", Detection::yes());
        let elapsed = started.elapsed();

        handle.join().unwrap();
        assert!(
            elapsed < Duration::from_millis(100),
            "an unrelated root's cache write waited {elapsed:?} — the lock was \
             held across the slow evaluate"
        );
    }

    // FR-4: two spellings of one root are ONE cache entry.
    #[test]
    fn roots_normalize_to_one_cache_key() {
        let root = tmp_root("detect-normalize");
        let with_dot = format!("{}/.", root.to_string_lossy());
        assert_eq!(
            normalize_root(&root.to_string_lossy()),
            normalize_root(&with_dot)
        );
        // A root that no longer exists still gets a stable key.
        assert_eq!(
            normalize_root("/francois/gone"),
            PathBuf::from("/francois/gone")
        );
    }

    // Each extension is cached independently — one negative answer never masks
    // another extension's positive one.
    #[test]
    fn extensions_are_cached_independently_within_a_root() {
        let root = tmp_root("detect-independent");
        let mut cache = DetectCache::default();
        cache.put(&root, "git", Detection::yes());
        assert!(cache.get(&root, "git").unwrap().detected);
        assert!(cache.get(&root, "cohorte").is_none());
    }
}
