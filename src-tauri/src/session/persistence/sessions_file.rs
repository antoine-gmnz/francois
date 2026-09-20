//! session/persistence/sessions_file.rs — the `sessions.json` FILE itself:
//! the atomic write `persist` performs, and the quarantine `load_persisted`
//! performs when that file cannot be read back.
//!
//! A child module rather than more of `persistence.rs` (already past
//! CLAUDE.md's ~1000-line cap and on the quality gate's oversized baseline),
//! and pure over an explicit path so every rule here is provable in a temp
//! dir with no `AppHandle`.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// Write `bytes` to `path` atomically: a UNIQUE sibling temp file, flushed to
/// the device, then renamed into place.
///
/// Three things this fixes over the `with_extension("json.tmp")` +
/// `fs::write` + `fs::rename` it replaces:
/// * the temp name was FIXED, so two writers racing could interleave and
///   rename a torn file. `PERSIST_LOCK` serialises writers inside ONE
///   process; it says nothing about a second François (a worktree, a dev
///   build) sharing the same app-data directory.
/// * nothing was flushed before the rename, so a crash could publish a
///   directory entry pointing at bytes that never reached the device — an
///   empty or truncated `sessions.json`, which is the one file holding every
///   session's resume anchor.
/// * a failed WRITE (a full disk) left the temp file behind; only a failed
///   rename was cleaned up.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let tmp = crate::fs_util::unique_temp_path(path, "json");
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    let result = written.and_then(|()| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Where a `sessions.json` this build cannot read is moved to. Timestamped,
/// and it never clobbers an earlier one — a user who hits this twice keeps
/// BOTH copies, because the older one may well be the recoverable one.
pub(crate) fn quarantine_path(path: &Path, now_ms: u64) -> PathBuf {
    let base = format!("{}.corrupt-{now_ms}", path.display());
    PathBuf::from(crate::session::worktree::suffix_until_free(&base, |p| {
        Path::new(p).exists()
    }))
}

/// Read `sessions.json` back, or MOVE it out of the way. Returns the records
/// plus — only when something went wrong — one diagnostic line for the caller
/// to log.
///
/// A `sessions.json` this build could not parse used to load as "no
/// sessions", and the next `persist` wrote an empty list straight over it:
/// every session, every Pi/Claude resume anchor and every project link gone
/// for good, with nothing to recover from. Setting the file aside FIRST is
/// what makes the fresh start non-destructive — the bytes survive under a
/// name nothing writes to, and the user can be told exactly where.
pub(crate) fn read_or_set_aside(path: &Path, now_ms: u64) -> (Vec<Value>, Option<String>) {
    let fault = match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<Vec<Value>>(&bytes) {
            Ok(list) => return (list, None),
            Err(e) => format!("{} could not be parsed ({e})", path.display()),
        },
        // No file at all — a fresh install, and the ONLY case that may
        // legitimately start empty.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Vec::new(), None),
        // Any OTHER read error means the file is there and this launch could
        // not see it — on Windows a sharing violation from an AV scanner, the
        // search indexer or a OneDrive placeholder is the ordinary case. Same
        // hazard, same answer: never read as a fresh install.
        Err(e) => format!("{} could not be read ({e})", path.display()),
    };
    let aside = quarantine_path(path, now_ms);
    let outcome = match std::fs::rename(path, &aside) {
        Ok(()) => format!("set aside as {}", aside.display()),
        // The one case where the next persist can still destroy it. Say so
        // plainly rather than implying the fresh start was safe.
        Err(e) => format!("could NOT be set aside ({e}) and may be overwritten"),
    };
    (Vec::new(), Some(format!("{fault}; {outcome}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "francois-sessions-file-{tag}-{}-{}",
            std::process::id(),
            crate::ids::uuid()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ---------- the atomic write ----------

    #[test]
    fn write_atomic_lands_the_bytes_and_leaves_no_temp_file_behind() {
        let dir = temp_dir("write");
        let path = dir.join("sessions.json");
        write_atomic(&path, b"[{\"id\":\"s1\"}]").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"[{\"id\":\"s1\"}]");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != "sessions.json")
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The fixed temp name was the bug: two writers sharing one app-data dir
    /// shared ONE `sessions.json.tmp`, so one could rename a file the other
    /// was still writing. Asserted deterministically — a file parked at the
    /// OLD fixed name must be neither read, written nor consumed, which is
    /// only true if the writer no longer uses that name at all.
    #[test]
    fn the_temp_file_is_not_the_old_fixed_name_a_second_writer_would_share() {
        let dir = temp_dir("temp-name");
        let path = dir.join("sessions.json");
        let squatted = dir.join("sessions.json.tmp");
        std::fs::write(&squatted, b"another writer's in-flight bytes").unwrap();

        write_atomic(&path, b"[]").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"[]");
        assert_eq!(
            std::fs::read(&squatted).unwrap(),
            b"another writer's in-flight bytes",
            "the other writer's temp file must be untouched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The same invariant end to end: whatever order two real writers land
    /// in, the published file is one of them WHOLE — never a mixture, never a
    /// truncation.
    #[test]
    fn two_concurrent_writers_never_publish_a_torn_file() {
        let dir = temp_dir("concurrent");
        let path = dir.join("sessions.json");
        let a = vec![b'a'; 200_000];
        let b = vec![b'b'; 200_000];
        let (pa, pb) = (path.clone(), path.clone());
        let (wa, wb) = (a.clone(), b.clone());
        let ta = std::thread::spawn(move || write_atomic(&pa, &wa));
        let tb = std::thread::spawn(move || write_atomic(&pb, &wb));
        ta.join().unwrap().unwrap();
        tb.join().unwrap().unwrap();
        let landed = std::fs::read(&path).unwrap();
        assert!(landed == a || landed == b, "a torn file landed");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---------- the quarantine ----------

    #[test]
    fn a_valid_file_reads_back_with_no_diagnostic() {
        let dir = temp_dir("valid");
        let path = dir.join("sessions.json");
        std::fs::write(&path, br#"[{"id":"s1"},{"id":"s2"}]"#).unwrap();
        let (list, diagnostic) = read_or_set_aside(&path, 1_700_000_000_000);
        assert_eq!(list.len(), 2);
        assert!(diagnostic.is_none());
        assert!(path.exists(), "a readable file is never moved");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_file_is_a_fresh_install_and_writes_nothing() {
        let dir = temp_dir("missing");
        let path = dir.join("sessions.json");
        let (list, diagnostic) = read_or_set_aside(&path, 1_700_000_000_000);
        assert!(list.is_empty());
        assert!(diagnostic.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The finding itself: an unparsable `sessions.json` loaded as "no
    /// sessions", and the next `persist` overwrote it. The bytes must survive
    /// somewhere the app never writes.
    #[test]
    fn an_unparsable_file_is_set_aside_before_anything_can_overwrite_it() {
        let dir = temp_dir("corrupt");
        let path = dir.join("sessions.json");
        std::fs::write(&path, b"[{ not json").unwrap();

        let (list, diagnostic) = read_or_set_aside(&path, 1_700_000_000_000);

        assert!(list.is_empty());
        let diagnostic = diagnostic.expect("the user is told");
        assert!(diagnostic.contains("could not be parsed"), "{diagnostic}");
        assert!(
            !path.exists(),
            "the unreadable file must be MOVED, not left"
        );
        let aside = dir.join("sessions.json.corrupt-1700000000000");
        assert_eq!(std::fs::read(&aside).unwrap(), b"[{ not json");
        assert!(diagnostic.contains("set aside as"), "{diagnostic}");

        // ...and the very next write is a clean one that destroys nothing.
        write_atomic(&path, b"[]").unwrap();
        assert_eq!(std::fs::read(&aside).unwrap(), b"[{ not json");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Valid JSON that is not a session ARRAY is unreadable too — `{}` and a
    /// bare object both used to load as "no sessions".
    #[test]
    fn valid_json_that_is_not_a_session_array_is_also_set_aside() {
        for (tag, body) in [("object", "{}"), ("string", "\"sessions\"")] {
            let dir = temp_dir(tag);
            let path = dir.join("sessions.json");
            std::fs::write(&path, body).unwrap();
            let (list, diagnostic) = read_or_set_aside(&path, 1_700_000_000_000);
            assert!(list.is_empty(), "{tag}");
            assert!(diagnostic.is_some(), "{tag}");
            assert!(!path.exists(), "{tag}");
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    /// Hitting this twice in the same millisecond must not cost the user the
    /// FIRST copy — which may well be the recoverable one.
    #[test]
    fn a_second_quarantine_never_clobbers_the_first() {
        let dir = temp_dir("twice");
        let path = dir.join("sessions.json");
        std::fs::write(&path, b"first corrupt copy").unwrap();
        read_or_set_aside(&path, 1_700_000_000_000);
        std::fs::write(&path, b"second corrupt copy").unwrap();
        read_or_set_aside(&path, 1_700_000_000_000);

        let first = dir.join("sessions.json.corrupt-1700000000000");
        let second = dir.join("sessions.json.corrupt-1700000000000-2");
        assert_eq!(std::fs::read(&first).unwrap(), b"first corrupt copy");
        assert_eq!(std::fs::read(&second).unwrap(), b"second corrupt copy");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Only "there is no file" may read as a fresh install. Any other read
    /// failure means a file the user cares about is there and this launch
    /// could not see it — a directory stands in for it, because `fs::read`
    /// on one fails with `IsADirectory` on unix and `PermissionDenied` on
    /// Windows, never `NotFound`, with nothing to mock.
    #[test]
    fn an_unreadable_file_is_never_mistaken_for_a_fresh_install() {
        let dir = temp_dir("unreadable");
        let path = dir.join("sessions.json");
        std::fs::create_dir(&path).unwrap();
        let (list, diagnostic) = read_or_set_aside(&path, 1_700_000_000_000);
        assert!(list.is_empty());
        let diagnostic = diagnostic.expect("an unreadable index is reported, never silent");
        assert!(diagnostic.contains("could not be read"), "{diagnostic}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
