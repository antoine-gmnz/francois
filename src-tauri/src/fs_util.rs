//! filesystem plumbing shared by the crate's atomic writers.
//!
//! What is shared here is ONLY the unique temp-path generation. The two atomic
//! writers themselves — `permissions::settings::write_json_atomic` and
//! `project::standards::write_text_atomic` — deliberately stay separate, because
//! the part that looks duplicated is the part that genuinely differs:
//!
//! * settings.json can carry secrets under `env`, so its temp file is created
//!   0600 by default and the target's mode is carried over on BOTH unix and
//!   Windows (a read-only settings.json stays read-only), and the write is
//!   `sync_all`'d before the rename.
//! * CLAUDE.md is a git-tracked document in the user's repo, and standards.rs
//!   explicitly does NOT copy the target's attributes on Windows — doing so
//!   would make a read-only target's temp file undeletable, breaking the
//!   remove-on-failure cleanup that FR-15 requires.
//!
//! Collapsing them would mean either leaking settings.json's permissions or
//! breaking standards.rs's cleanup. The shared skeleton below is the part that
//! can be unified without choosing between those.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Monotonic counter making each temp filename unique within the process. The
/// name used to be a constant per target, so two concurrent writers to the same
/// file (a decide racing the editor modal, or two sessions sharing a cwd) could
/// interleave and clobber each other's temp file.
///
/// NOTE: this prevents temp-file collision only. It does NOT serialize the
/// read-modify-write itself — callers that need that hold their own lock (e.g.
/// `STANDARDS_LOCK` in `write_standards`).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// A sibling temp path for `path`, unique per process and per call:
/// `<path>.<ext>.<pid>.<seq>.tmp`. Same directory as the target, so the
/// subsequent rename stays on one filesystem and is therefore atomic.
///
/// `ext` is the target's own extension (`"json"`, `"md"`) — kept in the temp
/// name so a leaked temp file is still recognizable as what it came from.
pub(crate) fn unique_temp_path(path: &Path, ext: &str) -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    path.with_extension(format!("{ext}.{}.{seq}.tmp", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_path_is_a_sibling_of_the_target() {
        let target = Path::new("/tmp/some/dir/settings.json");
        let tmp = unique_temp_path(target, "json");
        assert_eq!(tmp.parent(), target.parent());
    }

    #[test]
    fn temp_path_is_unique_per_call() {
        let target = Path::new("CLAUDE.md");
        let first = unique_temp_path(target, "md");
        let second = unique_temp_path(target, "md");
        assert_ne!(first, second, "two writers must not share a temp path");
    }

    #[test]
    fn temp_path_keeps_the_extension_and_ends_in_tmp() {
        let tmp = unique_temp_path(Path::new("x/CLAUDE.md"), "md");
        let name = tmp.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("CLAUDE.md."), "{name}");
        assert!(name.ends_with(".tmp"), "{name}");
    }
}

// ---------- extension-install FR-1: ~/.francois ----------

/// `$HOME/.francois` (`%USERPROFILE%\.francois` on Windows) — the one fixed
/// location `cli-companion` and `extension-install` both anchor to. PURE path
/// resolution only — nothing is created here, so a test can call this freely
/// without touching the real machine's home directory. `ensure_dir_0700` is
/// the (separate, explicit) side-effecting half.
pub(crate) fn francois_home_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".francois"))
}

/// `~/.francois/extensions` — the one directory `extension-install` FR-1 reads
/// manifests from, and nowhere else.
pub(crate) fn extensions_dir() -> Option<PathBuf> {
    francois_home_dir().map(|h| h.join("extensions"))
}

/// Create `dir` (and its ancestors) if missing, at mode `0700` on unix. A
/// pre-existing directory is left as-is — never re-chmod'd, so a user who
/// loosened it on purpose is not fought.
pub(crate) fn ensure_dir_0700(dir: &Path) -> std::io::Result<()> {
    if dir.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod francois_home_tests {
    use super::*;

    #[test]
    fn francois_home_dir_is_a_dot_francois_child_of_home() {
        let home = francois_home_dir().expect("a home directory must resolve in CI");
        assert!(home.ends_with(".francois"));
    }

    #[test]
    fn extensions_dir_is_a_child_of_the_francois_home() {
        let dir = extensions_dir().expect("a home directory must resolve in CI");
        assert!(dir.ends_with("extensions"));
        assert_eq!(dir.parent(), francois_home_dir().as_deref());
    }

    // FR-1: "no manifest is read from any other location — not a repo, not
    // ~/.claude, not a Claude Code plugin, not an env-var override." Prove the
    // negative directly: `extensions_dir()` reads no env var at all (besides
    // whatever `dirs::home_dir()` itself consults internally to find $HOME) —
    // setting a battery of plausible override variables must not move the
    // result away from `<home>/.francois/extensions`.
    #[test]
    fn extensions_dir_ignores_every_env_var_override() {
        let before = extensions_dir();

        let candidates = [
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_HOME",
            "CLAUDE_PROJECT_DIR",
            "FRANCOIS_HOME",
            "FRANCOIS_EXTENSIONS_DIR",
            "FRANCOIS_CONFIG_DIR",
            "XDG_CONFIG_HOME",
        ];
        for name in candidates {
            std::env::set_var(name, "/tmp/should-never-be-consulted");
        }

        let after = extensions_dir();

        for name in candidates {
            std::env::remove_var(name);
        }

        assert_eq!(
            before, after,
            "extensions_dir() must be unaffected by CLAUDE_*/FRANCOIS_*/XDG_* env vars"
        );
        // And it must land under the real home, not under any of the bogus
        // override values above.
        if let Some(dir) = after {
            assert!(
                !dir.starts_with("/tmp/should-never-be-consulted"),
                "{dir:?}"
            );
        }
    }

    // The directory is created on first use, and mode 0700 on unix — nothing
    // under it is group- or world-readable by default.
    #[cfg(unix)]
    #[test]
    fn ensure_dir_0700_creates_and_chmods_a_missing_directory() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "francois-fsutil-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        assert!(!dir.exists());
        ensure_dir_0700(&dir).unwrap();
        assert!(dir.exists());
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "{mode:o}");
        // Idempotent — a second call on an existing dir does not error.
        ensure_dir_0700(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
