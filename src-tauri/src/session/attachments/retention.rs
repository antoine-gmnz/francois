//! session-attachments FR-13/FR-15..FR-18: release, commit reconciliation, and
//! the three sweeps (start-up, session delete, project purge).
//!
//! The rule the whole file turns on: a `copied: false` origin is NEVER deleted.
//! Francois copied nothing for it, so it owns nothing — it only ever removes
//! bytes it wrote itself.

use super::*;
use std::path::Path;

/// FR-15 (the decision half, pure): `(sent ids, released ids)` for the staged
/// records, given the text that was just sent. Already-`sent` records are in
/// neither list — they are terminal and untouched.
pub(crate) fn partition_commit(
    attachments: &[Attachment],
    text: &str,
) -> (Vec<String>, Vec<String>) {
    let mut sent = Vec::new();
    let mut released = Vec::new();
    for a in attachments.iter().filter(|a| a.is_staged()) {
        if text.contains(&format!("@{}", a.ref_path)) {
            sent.push(a.id.clone());
        } else {
            released.push(a.id.clone());
        }
    }
    (sent, released)
}

/// FR-13: delete the bytes Francois wrote for an attachment. An in-place
/// (`copied: false`) origin is left alone. Returns false only when a copy that
/// still exists could not be removed.
pub(crate) fn delete_stored(attachment: &Attachment) -> bool {
    if !attachment.copied {
        return true;
    }
    let path = Path::new(&attachment.stored_path);
    match std::fs::remove_file(path) {
        Ok(()) => true,
        // Already gone (deleted outside Francois, or a double release) is a success.
        Err(_) => !path.exists(),
    }
}

/// FR-17: the app-start sweep. Composer drafts do not survive a restart, so a
/// persisted record still `staged` is by definition abandoned — its copy is
/// deleted and the record dropped. `sent` records (and their files) survive:
/// the transcript references them and Claude may re-read them.
pub(crate) fn sweep_staged(attachments: Vec<Attachment>) -> Vec<Attachment> {
    attachments
        .into_iter()
        .filter(|a| {
            if a.is_staged() {
                delete_stored(a);
                false
            } else {
                true
            }
        })
        .collect()
}

/// Unlink one leaf: a file, or a LINK of either flavour. `remove_file` handles
/// files and (on unix) any symlink; a Windows directory symlink or junction is
/// not a file, and `remove_dir` on one removes the LINK, never its target.
fn unlink(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) => std::fs::remove_dir(path).map_err(|_| e),
    }
}

/// Delete one leaf, folding its size into `stats`. A leaf that cannot be removed
/// counts as `failed` rather than aborting the sweep. The size comes from
/// `symlink_metadata`, so nothing is ever read through a link; and a LINK itself
/// contributes ZERO — unlinking it reclaims no data bytes, and its reported size
/// is meaningless anyway (the target path's length on unix, the reparse buffer on
/// Windows), which would make `removed_bytes` vary with where the link points.
fn remove_counted(path: &Path, stats: &mut ClearAttachmentsResult) {
    let size = std::fs::symlink_metadata(path)
        .map(|m| if is_link(&m) { 0 } else { m.len() })
        .unwrap_or(0);
    match unlink(path) {
        Ok(()) => {
            stats.removed_files += 1;
            stats.removed_bytes += size;
        }
        Err(_) => stats.failed += 1,
    }
}

/// FR-16: deleting a session deletes every file THAT SESSION created under its
/// attachments dir (driven by its records, not by a crawl — §6's short-id
/// collision note), then removes the dir if it is empty.
pub(crate) fn purge_session(
    cwd: &str,
    session_id: &str,
    attachments: &[Attachment],
) -> ClearAttachmentsResult {
    let mut stats = ClearAttachmentsResult::default();
    for a in attachments.iter().filter(|a| a.copied) {
        let path = Path::new(&a.stored_path);
        if path.exists() {
            remove_counted(path, &mut stats);
        }
    }
    remove_dir_if_empty(&attachments_dir(cwd, session_id));
    stats
}

/// FR-18 (and the `session` clear scope): empty a session's attachments dir.
/// Unlike FR-16 this is a crawl — the palette command promises the folder is
/// emptied, including bytes a previous run left behind. A missing dir is not an
/// error: it reports zeros.
pub(crate) fn clear_dir(cwd: &str, session_id: &str) -> ClearAttachmentsResult {
    let dir = attachments_dir(cwd, session_id);
    let mut stats = ClearAttachmentsResult::default();
    clear_tree(&dir, &mut stats);
    remove_dir_if_empty(&dir);
    stats
}

/// FR-18 for ONE session: forget its copied records, then sweep its attachments
/// dir. **The order is the whole point.**
///
/// `Engine.sessions` is a single mutex guarding EVERY session in the app, so any
/// disk work done inside `with_session_mut` stalls unrelated sessions' turns and
/// IPC for its whole duration — a project-wide clear is an unbounded crawl over
/// as many dirs as the project has sessions. Only the record drop (O(1)) is taken
/// under the lock here; the sweep runs with no lock held.
///
/// That ordering cannot orphan a file (§2's "no orphan accumulation"), because
/// ingestion writes the bytes BEFORE it records the ref: if a concurrent attach's
/// record was dropped by this `forget`, its record-write — and therefore its
/// file-write — happened before the sweep started, so the sweep sees the file.
/// The reverse race leaves a staged record whose file is gone, which is §7's
/// benign "attachment file deleted outside Francois": the copy is already absent,
/// so `delete_stored` reports success at commit and the record retires normally.
pub(crate) fn clear_session(
    engine: &Engine,
    session_id: &str,
    cwd: &str,
) -> ClearAttachmentsResult {
    // Every copied record's file is about to go; in-place refs still resolve.
    // `None` ⇒ the session vanished between the registry read and the lock —
    // there is simply no record left to reconcile, and the bytes still are.
    engine.with_session_mut(session_id, |s| s.forget_copied_attachments());
    clear_dir(cwd, session_id)
}

/// True for a link of either flavour: a symlink, or a Windows junction (which
/// `is_symlink` does NOT report — it is a reparse point of a different tag).
fn is_link(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400; // junctions included
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// True only for a REAL directory — never for a symlink, and never for a Windows
/// junction/reparse point. `Path::is_dir` (and `Metadata::is_dir` on a junction)
/// would say yes to a link, which is precisely what lets a planted link walk the
/// sweep out of the attachments dir and delete files anywhere on disk.
fn is_real_dir(meta: &std::fs::Metadata) -> bool {
    !is_link(meta) && meta.is_dir()
}

fn clear_tree(dir: &Path, stats: &mut ClearAttachmentsResult) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // never created, or already gone
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // symlink_metadata: describes the ENTRY, following nothing. A link (or an
        // entry we cannot stat) is treated as a leaf and unlinked — the sweep only
        // ever recurses into directories that really are directories.
        let recurse = std::fs::symlink_metadata(&path)
            .map(|m| is_real_dir(&m))
            .unwrap_or(false);
        if recurse {
            clear_tree(&path, stats);
            remove_dir_if_empty(&path);
        } else {
            remove_counted(&path, stats);
        }
    }
}

fn remove_dir_if_empty(dir: &Path) {
    // remove_dir (not remove_dir_all) fails on a non-empty dir — which is exactly
    // the "only if empty" semantics FR-16 asks for.
    let _ = std::fs::remove_dir(dir);
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn partition_keeps_referenced_staged_refs_and_drops_the_rest() {
        let p = std::path::PathBuf::from("/repo/x.png");
        let list = vec![
            att(
                "keep",
                ".francois/attachments/a3f9c1e2/a.png",
                &p,
                true,
                "staged",
            ),
            att(
                "drop",
                ".francois/attachments/a3f9c1e2/b.png",
                &p,
                true,
                "staged",
            ),
            att(
                "done",
                ".francois/attachments/a3f9c1e2/c.png",
                &p,
                true,
                "sent",
            ),
        ];
        let text = "see @.francois/attachments/a3f9c1e2/a.png — the header wraps";
        assert_eq!(
            partition_commit(&list, text),
            (vec!["keep".to_string()], vec!["drop".to_string()])
        );
        // §7: "User deletes a ref by hand after sending" — a sent record is never
        // re-released, even when its ref is nowhere in the new text.
        assert_eq!(
            partition_commit(&list[2..], "nothing here").1,
            Vec::<String>::new()
        );
        // an empty send releases every staged ref
        assert_eq!(partition_commit(&list, "").0, Vec::<String>::new());
    }

    #[test]
    fn release_deletes_a_copy_and_never_an_in_place_origin() {
        // FR-13 / §9: "× deletes the copied file immediately; an in-place
        // (copied: false) origin is left on disk".
        let dir = temp_cwd("release");
        let copy = write_file(&dir.join("copy.png"), b"x");
        let origin = write_file(&dir.join("origin.png"), b"y");

        assert!(delete_stored(&att("a", "copy.png", &copy, true, "staged")));
        assert!(!copy.exists());

        assert!(delete_stored(&att(
            "b",
            "origin.png",
            &origin,
            false,
            "staged"
        )));
        assert!(origin.exists(), "an in-place origin is never touched");

        // already gone is a success, not a failure
        assert!(delete_stored(&att("a", "copy.png", &copy, true, "staged")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_start_up_sweep_deletes_staged_files_and_keeps_sent_ones() {
        // §9: "Restarting the app deletes files left in staged and keeps every
        // sent one" (FR-17).
        let dir = temp_cwd("sweep");
        let staged = write_file(&dir.join("staged.png"), b"x");
        let sent = write_file(&dir.join("sent.png"), b"y");
        let inplace = write_file(&dir.join("inplace.png"), b"z");

        let kept = sweep_staged(vec![
            att("s", "staged.png", &staged, true, "staged"),
            att("t", "sent.png", &sent, true, "sent"),
            att("u", "inplace.png", &inplace, false, "staged"),
        ]);

        assert_eq!(
            kept.iter().map(|a| a.id.clone()).collect::<Vec<_>>(),
            vec!["t"]
        );
        assert!(!staged.exists());
        assert!(sent.exists(), "sent attachments are never swept");
        assert!(
            inplace.exists(),
            "a staged in-place origin is only forgotten"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn purging_a_session_removes_its_own_files_then_the_dir() {
        // FR-16 / §6: only the files this session actually created, then the dir
        // if empty.
        let cwd = temp_cwd("purge");
        let cwd_s = cwd.to_string_lossy().to_string();
        let dir = attachments_dir(&cwd_s, SID);
        let a = write_file(&dir.join("a.png"), b"aaa");
        let b = write_file(&dir.join("b.png"), b"bb");
        let outside = write_file(&cwd.join("kept.png"), b"k");

        let stats = purge_session(
            &cwd_s,
            SID,
            &[
                att("1", "x", &a, true, "staged"),
                att("2", "y", &b, true, "sent"),
                att("3", "z", &outside, false, "staged"),
            ],
        );

        assert_eq!(stats.removed_files, 2);
        assert_eq!(stats.removed_bytes, 5);
        assert_eq!(stats.failed, 0);
        assert!(!dir.exists(), "the emptied dir is removed");
        assert!(outside.exists(), "an in-place origin survives the purge");
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn purging_leaves_a_dir_that_still_holds_a_foreign_file() {
        // §6's short-id collision note: two sessions can share a folder, so the
        // dir is only removed when the purge actually emptied it.
        let cwd = temp_cwd("purge-shared");
        let cwd_s = cwd.to_string_lossy().to_string();
        let dir = attachments_dir(&cwd_s, SID);
        let mine = write_file(&dir.join("mine.png"), b"m");
        let theirs = write_file(&dir.join("theirs.png"), b"t");

        let stats = purge_session(&cwd_s, SID, &[att("1", "x", &mine, true, "staged")]);

        assert_eq!(stats.removed_files, 1);
        assert!(theirs.exists(), "another session's file is not touched");
        assert!(dir.exists(), "a non-empty dir stays");
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn clearing_empties_the_whole_dir_and_reports_the_count() {
        // FR-18 / §9: "reports the file count".
        let cwd = temp_cwd("clear");
        let cwd_s = cwd.to_string_lossy().to_string();
        let dir = attachments_dir(&cwd_s, SID);
        write_file(&dir.join("a.png"), b"aaa");
        write_file(&dir.join("b.pdf"), b"bb");
        write_file(&dir.join("nested").join("c.txt"), b"c"); // a crawl, not a listing
        let kept = write_file(&cwd.join("src.png"), b"keep me");

        let stats = clear_dir(&cwd_s, SID);

        assert_eq!(stats.removed_files, 3);
        assert_eq!(stats.removed_bytes, 6);
        assert_eq!(stats.failed, 0);
        assert!(!dir.exists());
        assert!(
            kept.exists(),
            "nothing outside the attachments dir is touched"
        );
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn clearing_unlinks_a_planted_link_instead_of_following_it() {
        // Security: `Path::is_dir` FOLLOWS links, so a symlink (or, unprivileged
        // on Windows, a junction) planted in `<cwd>/.francois/attachments/<short8>/`
        // would make the FR-18 sweep recurse OUT of the tree and delete files
        // anywhere on disk. The link itself is removed; its target is not touched.
        let cwd = temp_cwd("clear-link");
        let cwd_s = cwd.to_string_lossy().to_string();
        let dir = attachments_dir(&cwd_s, SID);
        std::fs::create_dir_all(&dir).unwrap();
        let foreign = temp_cwd("clear-link-foreign");
        let precious = write_file(&foreign.join("precious.txt"), b"do not delete me");
        let mine = write_file(&dir.join("mine.png"), b"x");
        let link = dir.join("escape");

        if !link_dir(&foreign, &link) {
            std::fs::remove_dir_all(&cwd).ok();
            std::fs::remove_dir_all(&foreign).ok();
            return; // this host allows no links at all — nothing to exercise
        }

        let stats = clear_dir(&cwd_s, SID);

        assert!(precious.exists(), "the sweep must not follow the link");
        assert_eq!(std::fs::read(&precious).unwrap(), b"do not delete me");
        assert!(foreign.exists(), "the link's target dir survives");
        assert!(!mine.exists(), "real files in the dir are still swept");
        assert!(!link.exists(), "the link itself is unlinked");
        assert_eq!(
            stats.removed_bytes, 1,
            "only the bytes of `mine.png` are counted — never the target's"
        );
        assert_eq!(stats.failed, 0);
        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&foreign).ok();
    }

    #[test]
    fn clearing_a_session_drops_its_copied_records_then_sweeps_the_bytes() {
        // FR-18 over the engine: records go under the lock (O(1)), bytes go with
        // NO lock held — `Engine.sessions` guards EVERY session in the app, so a
        // sweep under it stalls unrelated sessions' turns and IPC.
        use crate::session::testutil::{test_engine_with, test_session};
        let cwd = temp_cwd("clear-session");
        let cwd_s = cwd.to_string_lossy().to_string();
        let dir = attachments_dir(&cwd_s, "s1");
        let copy = write_file(&dir.join("a.png"), b"aaa");
        let origin = write_file(&cwd.join("in-place.png"), b"o");
        let mut s = test_session();
        s.cwd = cwd_s.clone();
        s.stage_attachment(att("copied", "x", &copy, true, "staged"));
        s.stage_attachment(att("inplace", "in-place.png", &origin, false, "staged"));
        let engine = test_engine_with(s);

        let stats = clear_session(&engine, "s1", &cwd_s);

        assert_eq!(stats.removed_files, 1);
        assert_eq!(stats.removed_bytes, 3);
        assert!(!dir.exists(), "the emptied dir is removed");
        assert!(origin.exists(), "an in-place origin is never swept");
        assert_eq!(
            engine
                .with_session("s1", |s| s
                    .attachments
                    .iter()
                    .map(|a| a.id.clone())
                    .collect::<Vec<_>>())
                .unwrap(),
            vec!["inplace"],
            "only the copied records are forgotten"
        );
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn clearing_a_session_that_vanished_still_sweeps_its_dir() {
        // The registry read and the lock are two steps: a session deleted in
        // between has no record left to reconcile, but its bytes are still there.
        use crate::session::testutil::{test_engine_with, test_session};
        let cwd = temp_cwd("clear-gone");
        let cwd_s = cwd.to_string_lossy().to_string();
        let dir = attachments_dir(&cwd_s, "ghost");
        write_file(&dir.join("left.png"), b"zz");
        let engine = test_engine_with(test_session());

        let stats = clear_session(&engine, "ghost", &cwd_s);

        assert_eq!(stats.removed_files, 1);
        assert_eq!(stats.removed_bytes, 2);
        assert!(!dir.exists());
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn clearing_a_session_that_never_attached_anything_reports_zeros() {
        let cwd = temp_cwd("clear-empty");
        let stats = clear_dir(&cwd.to_string_lossy(), SID);
        assert_eq!(stats, ClearAttachmentsResult::default());
        std::fs::remove_dir_all(&cwd).ok();
    }
}
