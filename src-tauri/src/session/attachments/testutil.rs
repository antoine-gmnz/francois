//! Shared fixtures for the session-attachments tests.
//!
//! Every test that touches disk works in its OWN throwaway directory under the
//! system temp dir — no shared global state, no fixed paths (two `cargo test`
//! runs, or two tests in the same run, must never collide).

use super::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// A unique, NOT-yet-created directory path for one test.
pub(crate) fn temp_dir(label: &str) -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "francois-att-{label}-{}-{n}-{}",
        std::process::id(),
        crate::session::now_ms()
    ))
}

/// A created throwaway session cwd.
pub(crate) fn temp_cwd(label: &str) -> PathBuf {
    let dir = temp_dir(label);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub(crate) const SID: &str = "a3f9c1e2-1111-2222-3333-444444444444";

/// An `Attachment` record with everything but the fields a test cares about
/// filled in — the equivalent of `BufBlock::new` for this domain.
pub(crate) fn att(
    id: &str,
    ref_path: &str,
    stored: &Path,
    copied: bool,
    state: &str,
) -> Attachment {
    Attachment {
        id: id.into(),
        session_id: SID.into(),
        kind: attachment_kind_for_name(ref_path).into(),
        origin_path: None,
        stored_path: stored.to_string_lossy().to_string(),
        ref_path: ref_path.into(),
        name: file_name_of(stored),
        bytes: 1,
        copied,
        state: state.into(),
        created_at: 0,
    }
}

/// Plant a directory LINK at `link` pointing at `target` — the hostile input the
/// sweep must never follow. Returns false when the host refuses to create one
/// (the caller then has nothing to assert on this machine).
///
/// Windows needs both branches: `symlink_dir` requires Developer Mode or
/// elevation, while a JUNCTION (`mklink /J`) needs neither — and a junction is
/// exactly what an unprivileged attacker can plant, so it is the case worth
/// covering.
#[cfg(windows)]
pub(crate) fn link_dir(target: &std::path::Path, link: &std::path::Path) -> bool {
    if std::os::windows::fs::symlink_dir(target, link).is_ok() {
        return true;
    }
    std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .is_ok()
        && link.exists()
}

#[cfg(unix)]
pub(crate) fn link_dir(target: &std::path::Path, link: &std::path::Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

/// Write `bytes` at `path`, creating parents. Returns the path.
pub(crate) fn write_file(path: &std::path::Path, bytes: &[u8]) -> PathBuf {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::write(path, bytes).unwrap();
    path.to_path_buf()
}
