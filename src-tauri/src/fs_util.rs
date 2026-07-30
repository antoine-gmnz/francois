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
