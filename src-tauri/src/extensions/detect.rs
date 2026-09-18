//! FR-12 (extension-install, supersedes `extensions` FR-3) — the closed
//! predicate set and the per-root cache.
//!
//! A predicate is a filesystem or PATH question and NEVER executes
//! repo-supplied content: `pathExists` stats a path, `pathJsonEquals` reads
//! one JSON pointer out of a file, and `commandSucceeds` runs a declared argv
//! under every provider cap. Detection grants nothing but whether a tab is
//! offered.
//!
//! FR-13: results are cached per NORMALIZED root and reused on every session
//! switch and tab open. There is no watcher and no TTL — only an explicit
//! `extensions_detect`, a project (re)open, or an app restart invalidates.

use super::provider::{run_predicate, ProviderError};
use super::schema::sanitize_field_strict;
use super::stream::resolve_under_root;
use super::{DetectPredicate, LoadedExtension, EXT_FIELD_MAX_CHARS};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// One extension's answer for one root. `reason` is the copy the Extensions
/// modal renders next to `unavailable here` — always present when the answer
/// is negative, so a panel is never silently missing.
#[derive(Clone, Debug, PartialEq)]
pub struct Detection {
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

    fn no(reason: impl Into<String>) -> Detection {
        Detection {
            detected: false,
            reason: Some(reason.into()),
        }
    }
}

/// FR-14: with no active session there is no root to evaluate against, so
/// every extension reports `detected: false` WITH a reason.
pub const NO_ROOT_REASON: &str = "select a session";

/// FR-7/FR-17: an exec predicate for a disabled OR unconsented extension is
/// not run AT ALL. The two filesystem predicates spawn nothing, so they still
/// answer honestly.
pub const NOT_PROBED_REASON: &str = "not evaluated — enable to detect";

/// FR-4: the cache key. Trailing separators and `.`/`..` segments must not
/// mint a second entry for the same project.
pub fn normalize_root(root: &str) -> PathBuf {
    let path = PathBuf::from(root);
    std::fs::canonicalize(&path).unwrap_or(path)
}

#[derive(Default)]
pub struct DetectCache {
    entries: HashMap<PathBuf, HashMap<String, Detection>>,
}

impl DetectCache {
    pub fn get(&self, root: &Path, extension_id: &str) -> Option<&Detection> {
        self.entries.get(root)?.get(extension_id)
    }

    pub(crate) fn put(&mut self, root: &Path, extension_id: &str, detection: Detection) {
        self.entries
            .entry(root.to_path_buf())
            .or_default()
            .insert(extension_id.to_string(), detection);
    }

    /// `Re-detect` drops this root's whole entry so every predicate runs again.
    pub(crate) fn invalidate(&mut self, root: &Path) {
        self.entries.remove(root);
    }

    /// FR-13: the whole cache is invalidated whenever the manifest directory
    /// rescan (app launch, `extensions_detect`) finds a predicate changed for
    /// any extension — called from `refresh_registry`, which compares the
    /// outgoing registry's predicates against the freshly loaded ones.
    pub(crate) fn invalidate_all(&mut self) {
        self.entries.clear();
    }

    #[cfg(test)]
    pub(crate) fn is_cached(&self, root: &Path, extension_id: &str) -> bool {
        self.get(root, extension_id).is_some()
    }
}

// ---------- FR-12: the predicates ----------

/// `<root>/<rel>` parses as JSON and the RFC-6901 pointer resolves to `equals`.
///
/// FR-12/FR-17: this predicate runs pre-consent (an unreviewed manifest can
/// declare any `path`), so the resolution goes through the same
/// `resolve_under_root` containment proof the `file` log-tail source uses —
/// never a raw `root.join(rel)` — or a symlink could turn this into a
/// boolean oracle for reading arbitrary files outside the project root.
pub fn json_pointer_equals(root: &Path, rel: &str, pointer: &str, equals: &str) -> bool {
    let Ok(resolved) = resolve_under_root(root, rel) else {
        return false;
    };
    let Ok(bytes) = std::fs::read(&resolved) else {
        return false;
    };
    let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    doc.pointer(pointer).and_then(|v| v.as_str()) == Some(equals)
}

/// `<root>/<rel>` exists as a FILE or a DIRECTORY — a linked worktree's `.git`
/// is a file, and `exists()` alone would also miss a broken symlink.
///
/// FR-12/FR-17: resolved through `resolve_under_root` first, same reasoning
/// as `json_pointer_equals` above — a predicate is evaluated before consent,
/// so it must never stat a path that escapes the root even via a symlink.
pub fn path_exists(root: &Path, rel: &str) -> bool {
    let Ok(resolved) = resolve_under_root(root, rel) else {
        return false;
    };
    resolved.exists() || std::fs::symlink_metadata(&resolved).is_ok()
}

/// FR-51: `path`/`pointer`/`equals` are manifest-controlled strings that flow
/// into an `undetected_reason` and cross IPC — sanitize them the same way
/// `declared_commands` sanitizes argv elements (control sequences AND
/// bidi-control/zero-width code points via `sanitize_field_strict`), so a
/// raw ANSI/control sequence OR a bidi override in a manifest can never ride
/// along in a detection reason.
fn sanitize_reason_field(input: &str) -> String {
    sanitize_field_strict(input, EXT_FIELD_MAX_CHARS)
}

/// Evaluate one predicate against one root. `enabled == false` short-circuits
/// the exec predicate ONLY (FR-17 — an unconsented/disabled extension never
/// spawns, including for detection); the two filesystem predicates keep
/// answering honestly.
pub fn evaluate(spec: &DetectPredicate, root: &Path, enabled: bool) -> Detection {
    match spec {
        DetectPredicate::PathExists { path } => {
            if path_exists(root, path) {
                Detection::yes()
            } else {
                let path = sanitize_reason_field(path);
                Detection::no(format!("{path} not found here"))
            }
        }
        DetectPredicate::PathJsonEquals {
            path,
            pointer,
            equals,
        } => {
            if json_pointer_equals(root, path, pointer, equals) {
                Detection::yes()
            } else {
                let path = sanitize_reason_field(path);
                let pointer = sanitize_reason_field(pointer);
                let equals = sanitize_reason_field(equals);
                Detection::no(format!("{path}{pointer} is not {equals}"))
            }
        }
        DetectPredicate::CommandSucceeds { argv } => {
            if !enabled {
                return Detection::no(NOT_PROBED_REASON);
            }
            match run_predicate(argv, root) {
                Ok(()) => Detection::yes(),
                Err(ProviderError::Missing { argv0 }) => {
                    Detection::no(format!("{argv0} is not installed"))
                }
                Err(_) => Detection::no("the command failed"),
            }
        }
    }
}

/// FR-13: the cached read. NEVER holds `cache_mutex` while `evaluate` runs — a
/// cache miss executes the predicate (including a capped `commandSucceeds`
/// exec) with the lock released, and only re-acquires it to record the
/// result, so a slow predicate for one root cannot stall every other root's
/// `extensions_list`/`extensions_detect`/`extensions_panel` call.
pub fn detect_cached_locked(
    cache_mutex: &Mutex<DetectCache>,
    ext: &LoadedExtension,
    root: &Path,
    enabled: bool,
) -> Detection {
    if let Some(hit) = cache_mutex.lock().unwrap().get(root, &ext.id) {
        return hit.clone();
    }
    let detection = evaluate(&ext.predicate, root, enabled);
    let mut cache = cache_mutex.lock().unwrap();
    if detection.reason.as_deref() != Some(NOT_PROBED_REASON) {
        cache.put(root, &ext.id, detection.clone());
    }
    detection
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::testutil::tmp_root;

    fn path_exists_predicate(path: &str) -> DetectPredicate {
        DetectPredicate::PathExists {
            path: path.to_string(),
        }
    }

    #[test]
    fn a_path_json_equals_predicate_reads_one_pointer() {
        let root = tmp_root("detect-json-equals");
        let spec = DetectPredicate::PathJsonEquals {
            path: ".claude/pipeline.json".into(),
            pointer: "/pipeline".into(),
            equals: "cohorte".into(),
        };
        assert!(!evaluate(&spec, &root, true).detected);

        std::fs::create_dir_all(root.join(".claude")).unwrap();
        std::fs::write(
            root.join(".claude/pipeline.json"),
            br#"{"pipeline":"other"}"#,
        )
        .unwrap();
        assert!(!evaluate(&spec, &root, true).detected);

        std::fs::write(root.join(".claude/pipeline.json"), b"{not json").unwrap();
        assert!(!evaluate(&spec, &root, true).detected);

        std::fs::write(
            root.join(".claude/pipeline.json"),
            br#"{"pipeline":"cohorte","name":"Francois"}"#,
        )
        .unwrap();
        assert!(evaluate(&spec, &root, true).detected);
    }

    // FR-12: `.git` as a FILE counts — that is what a linked worktree has.
    #[test]
    fn path_exists_matches_a_file_or_a_directory() {
        let root = tmp_root("detect-git");
        let spec = path_exists_predicate(".git");
        let miss = evaluate(&spec, &root, true);
        assert!(!miss.detected);
        assert!(miss.reason.is_some());

        std::fs::write(root.join(".git"), b"gitdir: /elsewhere/.git/worktrees/x").unwrap();
        assert!(evaluate(&spec, &root, true).detected);

        let dir_root = tmp_root("detect-git-dir");
        std::fs::create_dir_all(dir_root.join(".git")).unwrap();
        assert!(evaluate(&spec, &dir_root, true).detected);
    }

    // FR-17: OFF (or unconsented) means off. The exec predicate does not run.
    //
    // REVIEW round 4: proven DIRECTLY rather than by inference from the
    // `docker` binary's absence/presence — the argv here is a real marker
    // script that writes a sentinel file the instant it is executed. If
    // `evaluate` ever stopped short-circuiting before the exec, this test
    // would catch it even on a machine where `docker`/whatever binary is
    // simply not installed (which would make the old assertion pass for the
    // wrong reason).
    #[test]
    fn a_disabled_extension_never_runs_its_exec_predicate() {
        let root = tmp_root("detect-docker-off");
        let marker_dir = tmp_root("detect-docker-off-marker");
        let sentinel = marker_dir.join("ran.marker");

        let spec = DetectPredicate::CommandSucceeds {
            argv: marker_script_argv(&sentinel),
        };

        let detection = evaluate(&spec, &root, false);
        assert!(!detection.detected);
        assert_eq!(detection.reason.as_deref(), Some(NOT_PROBED_REASON));
        assert!(
            !sentinel.exists(),
            "the exec predicate must never spawn while disabled"
        );

        // Control: the same marker script DOES run — and DOES write the
        // sentinel — once enabled, proving the script itself is not
        // silently broken (which would make the assertion above vacuous).
        let enabled_detection = evaluate(&spec, &root, true);
        assert!(
            enabled_detection.detected,
            "the marker script must succeed once enabled — reason: {:?}",
            enabled_detection.reason
        );
        assert!(
            sentinel.exists(),
            "the marker script must actually run once enabled"
        );
    }

    /// A cross-platform argv that, when executed, creates `sentinel` on disk —
    /// used to prove an exec predicate did or did not run, rather than
    /// inferring it from a system binary's exit status. Only `.exists()` is
    /// ever asked of it, so what kind of entry it is does not matter.
    #[cfg(unix)]
    fn marker_script_argv(sentinel: &std::path::Path) -> Vec<String> {
        vec![
            "sh".into(),
            "-c".into(),
            format!("touch '{}'", sentinel.display()),
        ]
    }

    /// `mkdir` rather than `type nul > …`, and the path as its OWN argv element
    /// rather than interpolated into one string. `Command` escapes a quote
    /// inside an argument as `\"`, which is MSVC's convention and NOT one
    /// `cmd.exe` understands — so an interpolated, quoted redirect target
    /// reached cmd as a literal `\"C:\…\"`, an invalid filename, and the
    /// predicate failed on Windows for a reason that had nothing to do with
    /// the code under test. Keeping the path a separate argument lets
    /// `Command` quote it on its own terms, and `mkdir` needs no redirection.
    #[cfg(windows)]
    fn marker_script_argv(sentinel: &std::path::Path) -> Vec<String> {
        vec![
            "cmd".into(),
            "/C".into(),
            "mkdir".into(),
            sentinel.display().to_string(),
        ]
    }

    #[test]
    fn a_disabled_extension_still_answers_its_filesystem_predicate() {
        let root = tmp_root("detect-git-off");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        assert!(evaluate(&path_exists_predicate(".git"), &root, false).detected);
    }

    // CRITICAL fix: FR-12/FR-17 — an unreviewed manifest's `pathExists` must
    // not be a boolean oracle over the whole filesystem. `../../etc/passwd`
    // (almost certainly real on the test machine) must read as NOT detected,
    // not as a leak of whether the path exists outside the root.
    #[test]
    fn path_exists_refuses_to_escape_the_root() {
        let root = tmp_root("detect-path-exists-escape");
        assert!(
            !evaluate(
                &path_exists_predicate("../../../../etc/passwd"),
                &root,
                true
            )
            .detected
        );
    }

    #[cfg(unix)]
    #[test]
    fn path_exists_refuses_a_symlink_that_escapes_the_root() {
        let root = tmp_root("detect-path-exists-symlink-escape");
        let outside = tmp_root("detect-path-exists-symlink-target");
        std::fs::write(outside.join("secret"), b"sshhh").unwrap();
        std::os::unix::fs::symlink(outside.join("secret"), root.join("link")).unwrap();
        assert!(!evaluate(&path_exists_predicate("link"), &root, true).detected);
    }

    // Same containment proof for `pathJsonEquals` — it must not read a file
    // that resolves outside the root, symlink included.
    #[test]
    fn json_pointer_equals_refuses_to_escape_the_root() {
        let root = tmp_root("detect-json-equals-escape");
        let outside = tmp_root("detect-json-equals-target");
        std::fs::write(outside.join("secret.json"), br#"{"pipeline":"cohorte"}"#).unwrap();
        let escape_path = format!(
            "../{}/secret.json",
            outside.file_name().unwrap().to_string_lossy()
        );
        assert!(!json_pointer_equals(
            &root,
            &escape_path,
            "/pipeline",
            "cohorte"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn json_pointer_equals_refuses_a_symlink_that_escapes_the_root() {
        let root = tmp_root("detect-json-equals-symlink-escape");
        let outside = tmp_root("detect-json-equals-symlink-target");
        std::fs::write(outside.join("secret.json"), br#"{"pipeline":"cohorte"}"#).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.json"), root.join("link.json")).unwrap();
        assert!(!json_pointer_equals(
            &root,
            "link.json",
            "/pipeline",
            "cohorte"
        ));
    }

    fn loaded(id: &str, predicate: DetectPredicate) -> LoadedExtension {
        LoadedExtension {
            id: id.to_string(),
            dir: PathBuf::from("/tmp"),
            label: id.to_string(),
            min_version_label: None,
            predicate,
            panels: Vec::new(),
            declared_commands: Vec::new(),
            manifest_sha256: Some("x".into()),
            manifest_error: None,
        }
    }

    #[test]
    fn a_detection_is_cached_per_root() {
        let root = tmp_root("detect-cache");
        let git = loaded("git", path_exists_predicate(".git"));
        let cache = Mutex::new(DetectCache::default());
        assert!(!cache.lock().unwrap().is_cached(&root, "git"));
        assert!(!detect_cached_locked(&cache, &git, &root, true).detected);
        assert!(cache.lock().unwrap().is_cached(&root, "git"));

        std::fs::create_dir_all(root.join(".git")).unwrap();
        assert!(!detect_cached_locked(&cache, &git, &root, true).detected);

        cache.lock().unwrap().invalidate(&root);
        assert!(detect_cached_locked(&cache, &git, &root, true).detected);
    }

    #[test]
    fn the_not_probed_answer_is_never_cached() {
        let root = tmp_root("detect-cache-off");
        let docker = loaded(
            "docker",
            DetectPredicate::CommandSucceeds {
                argv: vec!["docker".into(), "info".into()],
            },
        );
        let cache = Mutex::new(DetectCache::default());
        detect_cached_locked(&cache, &docker, &root, false);
        assert!(!cache.lock().unwrap().is_cached(&root, "docker"));
    }

    // CRITICAL fix: `detect_cached_locked` must not hold `cache_mutex` while a
    // slow `CommandSucceeds` predicate runs.
    #[test]
    fn detect_cached_locked_does_not_hold_the_lock_across_a_slow_evaluate() {
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        let slow_root = tmp_root("detect-cache-lock-free-slow");
        let fast_root = tmp_root("detect-cache-lock-free-fast");
        let cache = Arc::new(Mutex::new(DetectCache::default()));

        let slow = loaded(
            "test-slow",
            DetectPredicate::CommandSucceeds {
                argv: vec!["sleep".into(), "0.15".into()],
            },
        );

        let cache_for_thread = cache.clone();
        let slow_root_for_thread = slow_root.clone();
        let handle = std::thread::spawn(move || {
            detect_cached_locked(&cache_for_thread, &slow, &slow_root_for_thread, true)
        });

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
            "an unrelated root's cache write waited {elapsed:?}"
        );
    }

    #[test]
    fn roots_normalize_to_one_cache_key() {
        let root = tmp_root("detect-normalize");
        let with_dot = format!("{}/.", root.to_string_lossy());
        assert_eq!(
            normalize_root(&root.to_string_lossy()),
            normalize_root(&with_dot)
        );
        assert_eq!(
            normalize_root("/francois/gone"),
            PathBuf::from("/francois/gone")
        );
    }

    #[test]
    fn extensions_are_cached_independently_within_a_root() {
        let root = tmp_root("detect-independent");
        let mut cache = DetectCache::default();
        cache.put(&root, "git", Detection::yes());
        assert!(cache.get(&root, "git").unwrap().detected);
        assert!(cache.get(&root, "cohorte").is_none());
    }

    // FR-51: `path`/`pointer`/`equals` are manifest-controlled and must never
    // ride an ANSI/control sequence into IPC via the `undetected_reason` —
    // sanitized the same way `declared_commands` sanitizes argv elements.
    #[test]
    fn path_exists_reason_strips_control_sequences_from_the_manifest_path() {
        let root = tmp_root("detect-path-exists-control-chars");
        let spec = path_exists_predicate("weird\u{1b}[31mred\u{1b}[0m");
        let detection = evaluate(&spec, &root, true);
        assert!(!detection.detected);
        let reason = detection.reason.unwrap();
        assert!(!reason.contains('\u{1b}'));
        assert_eq!(reason, "weirdred not found here");
    }

    #[test]
    fn path_json_equals_reason_strips_control_sequences_from_every_field() {
        let root = tmp_root("detect-json-equals-control-chars");
        let spec = DetectPredicate::PathJsonEquals {
            path: "a\u{1b}[31mb".into(),
            pointer: "/x\u{1b}[0m".into(),
            equals: "y\u{1b}[0mz".into(),
        };
        let detection = evaluate(&spec, &root, true);
        assert!(!detection.detected);
        let reason = detection.reason.unwrap();
        assert!(!reason.contains('\u{1b}'));
        assert_eq!(reason, "ab/x is not yz");
    }

    // FR-51 round 15: `sanitize_reason_field` used to strip ANSI/control
    // sequences only (via `schema::sanitize_field`), unlike
    // `manifest::sanitize_argv_element` — a manifest-controlled `path` could
    // ride a bidi override or zero-width char into `undetected_reason`,
    // which crosses IPC and renders in the Extensions modal.
    #[test]
    fn path_exists_reason_strips_bidi_and_zero_width_from_the_manifest_path() {
        let root = tmp_root("detect-path-exists-bidi-chars");
        let spec = path_exists_predicate("weird\u{202e}reversed\u{200b}hidden");
        let detection = evaluate(&spec, &root, true);
        assert!(!detection.detected);
        let reason = detection.reason.unwrap();
        assert!(!reason.contains('\u{202e}'));
        assert!(!reason.contains('\u{200b}'));
        assert_eq!(reason, "weirdreversedhidden not found here");
    }

    #[test]
    fn invalidate_all_clears_every_root() {
        let root_a = tmp_root("detect-invalidate-all-a");
        let root_b = tmp_root("detect-invalidate-all-b");
        let mut cache = DetectCache::default();
        cache.put(&root_a, "git", Detection::yes());
        cache.put(&root_b, "git", Detection::yes());
        cache.invalidate_all();
        assert!(cache.get(&root_a, "git").is_none());
        assert!(cache.get(&root_b, "git").is_none());
    }
}
