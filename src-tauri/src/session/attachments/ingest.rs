//! session-attachments FR-1..FR-9: the ONE ingestion pipeline.
//!
//! Every gesture — drop, clipboard paste, `+` picker — collapses to the same two
//! steps: put the bytes at a path the session can read, then hand back the ref.
//! Nothing here knows about Tauri: the pipeline takes `(session_id, cwd, source)`
//! and returns a record or an `AttachError`, so it is tested against temp dirs.

use super::*;
use std::path::{Path, PathBuf};

/// FR-2/FR-3: the attachments dir, created lazily, with `.francois/.gitignore`
/// written on the way. The gitignore is (re)created whenever it is missing —
/// never edited if it already exists, and the user's own `.gitignore` is never
/// touched.
pub fn ensure_attachments_dir(cwd: &str, session_id: &str) -> Result<PathBuf, AttachError> {
    let dir = attachments_dir(cwd, session_id);
    std::fs::create_dir_all(&dir).map_err(|e| {
        AttachError::io(
            &dir,
            format!("could not create the attachments folder: {e}"),
        )
    })?;
    let ignore = attachments_root(cwd).join(".gitignore");
    if !ignore.exists() {
        // Best effort: a missing .gitignore only means the tree shows up in
        // `git status`; it must not fail the attachment itself.
        let _ = std::fs::write(&ignore, ATTACHMENTS_GITIGNORE_BODY);
    }
    Ok(dir)
}

/// FR-1/FR-5/FR-7/FR-8: ingest a file already on disk.
///
/// Already under the session cwd ⇒ referenced IN PLACE (`copied: false`,
/// `storedPath` unchanged, ref relative to the cwd) and NO attachments dir is
/// created. Otherwise the file is copied in under a never-overwriting name.
pub fn ingest_path(
    session_id: &str,
    cwd: &str,
    src: &str,
    now: u64,
) -> Result<Attachment, AttachError> {
    let trimmed = src.trim();
    if trimmed.is_empty() {
        return Err(AttachError::invalid("no path given"));
    }
    let source = Path::new(trimmed);
    if !source.is_absolute() {
        return Err(AttachError::invalid("path must be absolute"));
    }
    let meta = std::fs::metadata(source)
        .map_err(|_| AttachError::invalid("that file does not exist or is not readable"))?;
    // FR-8: refuse folders BEFORE anything is created (§7: "No dir is created").
    if meta.is_dir() {
        return Err(AttachError::is_directory());
    }
    let bytes = meta.len();
    if bytes > ATTACHMENT_MAX_BYTES {
        return Err(AttachError::too_large(bytes));
    }

    // FR-1: already under the cwd → reference it where it lies.
    if let Some(ref_path) = relative_ref(cwd, source) {
        let name = file_name_of(source);
        return Ok(Attachment {
            id: super::super::uuid(),
            session_id: session_id.to_string(),
            kind: attachment_kind_for_name(&name).to_string(),
            origin_path: Some(trimmed.to_string()),
            stored_path: trimmed.to_string(),
            ref_path,
            name,
            bytes,
            copied: false,
            state: "staged".into(),
            created_at: now,
        });
    }

    // FR-1: outside the cwd → copy in. The target name is CLAIMED (exclusive
    // create) before a byte moves, so two concurrent attaches can never settle on
    // one name — that is FR-7's "nothing is ever overwritten" against a race.
    let dir = ensure_attachments_dir(cwd, session_id)?;
    let (name, mut file) = create_unique(&dir, &file_name_of(source))
        .map_err(|e| AttachError::io(&dir, format!("could not create the attachment: {e}")))?;
    let target = dir.join(&name);
    // Capped at cap+1: a source that grows after the `metadata()` snapshot above
    // can never write more than one byte past the cap into the cwd, and that byte
    // is what `enforce_cap` refuses on.
    let written = copy_into(source, &mut file, ATTACHMENT_MAX_BYTES + 1);
    drop(file); // release the handle before any cleanup touches the path
    let copied_bytes = written.map_err(|e| {
        // §7: no partial copy is ever left behind.
        let _ = std::fs::remove_file(&target);
        AttachError::io(&target, format!("could not copy the file: {e}"))
    })?;
    // FR-8 again, on what ACTUALLY landed (see `enforce_cap`).
    let copied_bytes = enforce_cap(&target, copied_bytes)?;
    Ok(stored_attachment(
        session_id,
        &name,
        &target,
        copied_bytes,
        Some(trimmed.to_string()),
        now,
    ))
}

/// FR-9: ingest a batch of picks INDEPENDENTLY. One refusal never aborts the
/// rest, and it is reported rather than dropped — the frontend cannot otherwise
/// tell a silently skipped file from one the user never picked. The refusal
/// names the file (basename), because that is what the copy is about.
pub fn ingest_picks(
    session_id: &str,
    cwd: &str,
    paths: &[String],
    now: u64,
) -> PickAttachmentsResponse {
    let mut response = PickAttachmentsResponse::default();
    for path in paths {
        match ingest_path(session_id, cwd, path, now) {
            Ok(a) => response.attached.push(a),
            Err(e) => response.failed.push(AttachFailure {
                name: file_name_of(Path::new(path.trim())),
                error: e.to_app_error(),
            }),
        }
    }
    response
}

/// FR-6: write clipboard bytes out as `pasted-<YYYYMMDD>-<HHMMSS>.<ext>` in LOCAL
/// time. Always `copied: true`, always without an `originPath` — the bytes came
/// from the clipboard, not from a file.
pub fn ingest_clipboard_image(
    session_id: &str,
    cwd: &str,
    mime: &str,
    data_base64: &str,
    now: u64,
) -> Result<Attachment, AttachError> {
    let bytes = decode_base64(data_base64)?;
    if bytes.is_empty() {
        return Err(AttachError::invalid("the clipboard image is empty"));
    }
    if bytes.len() as u64 > ATTACHMENT_MAX_BYTES {
        return Err(AttachError::too_large(bytes.len() as u64));
    }
    let dir = ensure_attachments_dir(cwd, session_id)?;
    let (name, mut file) = create_unique(&dir, &pasted_name(mime, chrono::Local::now()))
        .map_err(|e| AttachError::io(&dir, format!("could not create the image file: {e}")))?;
    let target = dir.join(&name);
    let written = std::io::Write::write_all(&mut file, &bytes);
    drop(file);
    written.map_err(|e| {
        let _ = std::fs::remove_file(&target);
        AttachError::io(&target, format!("could not write the image: {e}"))
    })?;
    Ok(stored_attachment(
        session_id,
        &name,
        &target,
        bytes.len() as u64,
        None,
        now,
    ))
}

/// FR-8, the second half: the cap is enforced AGAIN on what actually landed.
/// The pre-copy check reads `metadata().len()`, a snapshot taken before a single
/// byte moves — a source that grows in between (a log still being written, a
/// download finishing) would otherwise store an attachment over the 10 MiB cap.
/// Over the cap ⇒ the target is deleted (§7: "no partial copy is left behind")
/// and the refusal is FR-8's `ATTACHMENT_TOO_LARGE`, not an IO error, because
/// that is what the user has to act on.
fn enforce_cap(target: &Path, copied_bytes: u64) -> Result<u64, AttachError> {
    if copied_bytes > ATTACHMENT_MAX_BYTES {
        let _ = std::fs::remove_file(target);
        return Err(AttachError::too_large(copied_bytes));
    }
    Ok(copied_bytes)
}

/// Stream `src` into an ALREADY-CLAIMED target handle, reading AT MOST `limit`
/// bytes. `fs::copy` cannot be used here: it opens the destination itself, which
/// would give up the exclusive create that makes the name claim atomic.
///
/// The limit is the cap's first line of defence: an unbounded `io::copy` drains
/// whatever the source produces, so a file still being written could push
/// arbitrarily many bytes into the session cwd before `enforce_cap` deletes
/// them. Callers pass `ATTACHMENT_MAX_BYTES + 1` — one byte past the cap, which
/// is exactly enough for `enforce_cap` to SEE the overrun and refuse it.
fn copy_into(src: &Path, dst: &mut std::fs::File, limit: u64) -> std::io::Result<u64> {
    use std::io::Read as _;
    let input = std::fs::File::open(src)?;
    std::io::copy(&mut input.take(limit), dst)
}

/// The record shape shared by both copy paths (FR-2/FR-4: the ref is the
/// attachments dir's ref path plus the stored name, POSIX-separated).
fn stored_attachment(
    session_id: &str,
    name: &str,
    target: &Path,
    bytes: u64,
    origin_path: Option<String>,
    now: u64,
) -> Attachment {
    Attachment {
        id: super::super::uuid(),
        session_id: session_id.to_string(),
        kind: attachment_kind_for_name(name).to_string(),
        origin_path,
        stored_path: target.to_string_lossy().to_string(),
        ref_path: format!("{}/{name}", attachments_dir_ref_path(session_id)),
        name: name.to_string(),
        bytes,
        copied: true,
        state: "staged".into(),
        created_at: now,
    }
}

/// Decode the contract's `dataBase64` (raw bytes, no `data:` URL prefix). A
/// prefix and embedded whitespace are tolerated rather than rejected: a
/// clipboard payload that arrives slightly dressed up is still the user's image.
///
/// FR-8's cap is applied to the payload's LENGTH first. Decoding and then
/// measuring means an oversized paste forces the full allocation (the cleaned
/// copy plus the decoded bytes) before the cap can refuse it — the same
/// "cap enforced after the work" shape `copy_into`'s limit removed on the file
/// path. The encoding's length already proves what it cannot fit into.
pub fn decode_base64(data: &str) -> Result<Vec<u8>, AttachError> {
    use base64::Engine as _;
    if data.len() as u64 > ATTACHMENT_MAX_BASE64_CHARS {
        return Err(AttachError::too_large(base64_decoded_bytes(
            data.len() as u64
        )));
    }
    let body = match data.find("base64,") {
        Some(i) => &data[i + "base64,".len()..],
        None => data,
    };
    let cleaned: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .map_err(|_| AttachError::invalid("the clipboard image could not be decoded"))
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;
    use crate::ipc::ErrorCode;

    #[test]
    fn a_file_under_the_cwd_is_referenced_in_place_and_creates_no_dir() {
        // §9: "Dropping a file already inside the session cwd inserts a relative
        // ref and copies nothing — verified by asserting the attachments dir was
        // not created."
        let cwd = temp_cwd("inplace");
        let file = write_file(&cwd.join("docs").join("logo.png"), b"bytes!");
        let cwd_s = cwd.to_string_lossy().to_string();

        let a = ingest_path(SID, &cwd_s, &file.to_string_lossy(), 7).unwrap();

        assert!(!a.copied);
        assert_eq!(a.ref_path, "docs/logo.png");
        assert_eq!(a.stored_path, file.to_string_lossy());
        assert_eq!(a.origin_path.as_deref(), Some(&*file.to_string_lossy()));
        assert_eq!(a.name, "logo.png");
        assert_eq!(a.kind, "image");
        assert_eq!(a.bytes, 6);
        assert_eq!(a.state, "staged");
        assert_eq!(a.created_at, 7);
        assert!(
            !attachments_root(&cwd_s).exists(),
            "FR-1: no attachments dir for an in-place ref"
        );
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn a_file_outside_the_cwd_is_copied_in_and_gitignored() {
        // §9: the copy lands under the session cwd, the ref resolves from it, and
        // `.francois/.gitignore` holds `*` so git never sees it (FR-3).
        let cwd = temp_cwd("copyin");
        let outside = temp_cwd("origin");
        let file = write_file(&outside.join("report.pdf"), b"pdf-bytes");
        let cwd_s = cwd.to_string_lossy().to_string();

        let a = ingest_path(SID, &cwd_s, &file.to_string_lossy(), 0).unwrap();

        assert!(a.copied);
        assert_eq!(a.kind, "file");
        assert_eq!(a.ref_path, ".francois/attachments/a3f9c1e2/report.pdf");
        assert_eq!(a.name, "report.pdf");
        assert_eq!(a.bytes, 9);
        assert_eq!(a.origin_path.as_deref(), Some(&*file.to_string_lossy()));
        let stored = std::path::PathBuf::from(&a.stored_path);
        assert!(stored.exists());
        assert_eq!(std::fs::read(&stored).unwrap(), b"pdf-bytes");
        // FR-3
        let ignore = attachments_root(&cwd_s).join(".gitignore");
        assert_eq!(std::fs::read_to_string(&ignore).unwrap(), "*\n");
        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn a_second_copy_of_the_same_name_is_suffixed() {
        // §9: "Dropping report.pdf twice yields report.pdf and report-2.pdf".
        let cwd = temp_cwd("dupe");
        let outside = temp_cwd("dupe-origin");
        let file = write_file(&outside.join("report.pdf"), b"a");
        let cwd_s = cwd.to_string_lossy().to_string();

        let first = ingest_path(SID, &cwd_s, &file.to_string_lossy(), 0).unwrap();
        let second = ingest_path(SID, &cwd_s, &file.to_string_lossy(), 0).unwrap();

        assert_eq!(first.name, "report.pdf");
        assert_eq!(second.name, "report-2.pdf");
        assert_eq!(
            second.ref_path,
            ".francois/attachments/a3f9c1e2/report-2.pdf"
        );
        assert!(std::path::PathBuf::from(&first.stored_path).exists());
        assert!(std::path::PathBuf::from(&second.stored_path).exists());
        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn a_pick_batch_attaches_what_it_can_and_reports_what_it_refused() {
        // FR-9 / §9: "picking three files attaches all three"; a refused pick
        // never aborts the batch and is REPORTED, with the file's basename.
        let cwd = temp_cwd("pick");
        let outside = temp_cwd("pick-origin");
        let cwd_s = cwd.to_string_lossy().to_string();
        let good = write_file(&outside.join("notes.txt"), b"ok");
        let inside = write_file(&cwd.join("logo.png"), b"in");
        let big = outside.join("huge.bin");
        write_file(&big, &vec![0u8; (ATTACHMENT_MAX_BYTES + 1) as usize]);
        let folder = temp_cwd("pick-folder");

        let response = ingest_picks(
            SID,
            &cwd_s,
            &[
                good.to_string_lossy().to_string(),
                big.to_string_lossy().to_string(),
                inside.to_string_lossy().to_string(),
                folder.to_string_lossy().to_string(),
            ],
            5,
        );

        assert_eq!(
            response
                .attached
                .iter()
                .map(|a| a.name.clone())
                .collect::<Vec<_>>(),
            vec!["notes.txt", "logo.png"]
        );
        assert!(response.attached[0].copied); // from outside: copied in
        assert!(!response.attached[1].copied); // FR-1: referenced in place
        let failed: Vec<(String, ErrorCode)> = response
            .failed
            .iter()
            .map(|f| (f.name.clone(), f.error.code))
            .collect();
        assert_eq!(
            failed,
            vec![
                ("huge.bin".to_string(), ErrorCode::AttachmentTooLarge),
                (file_name_of(&folder), ErrorCode::AttachmentIsDirectory),
            ]
        );
        // an empty pick list (a cancelled dialog) refuses nothing
        let none = ingest_picks(SID, &cwd_s, &[], 0);
        assert!(none.attached.is_empty() && none.failed.is_empty());
        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
        std::fs::remove_dir_all(&folder).ok();
    }

    #[test]
    fn an_oversized_file_is_refused_and_leaves_nothing_behind() {
        // §9: "A 12 MB file is refused with ATTACHMENT_TOO_LARGE and leaves no
        // partial copy."
        let cwd = temp_cwd("toobig");
        let outside = temp_cwd("toobig-origin");
        let big = outside.join("huge.bin");
        write_file(&big, &vec![0u8; (ATTACHMENT_MAX_BYTES + 1) as usize]);
        let cwd_s = cwd.to_string_lossy().to_string();

        let e = ingest_path(SID, &cwd_s, &big.to_string_lossy(), 0).unwrap_err();

        assert_eq!(e.code, ErrorCode::AttachmentTooLarge);
        assert_eq!(e.detail.unwrap()["cap"], ATTACHMENT_MAX_BYTES);
        assert!(
            !attachments_root(&cwd_s).exists(),
            "a refusal creates no dir and no partial copy"
        );
        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn a_copy_that_outgrew_the_cap_is_refused_and_its_target_deleted() {
        // FR-8's second half. `metadata().len()` is a SNAPSHOT taken before the
        // copy: a source that grows between the check and `io::copy` (a log being
        // written, a download finishing) would otherwise land a stored attachment
        // over the 10 MiB cap. The post-copy guard is exercised directly — the
        // race itself is not reproducible deterministically on any host.
        let dir = temp_cwd("grew");
        let target = write_file(&dir.join("grown.bin"), b"partial");

        let e = enforce_cap(&target, ATTACHMENT_MAX_BYTES + 1).unwrap_err();

        assert_eq!(e.code, ErrorCode::AttachmentTooLarge);
        let detail = e.detail.unwrap();
        assert_eq!(detail["bytes"], ATTACHMENT_MAX_BYTES + 1);
        assert_eq!(detail["cap"], ATTACHMENT_MAX_BYTES);
        assert!(!target.exists(), "§7: no partial copy is left behind");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_copy_stream_itself_is_capped_so_an_overrun_is_never_fully_written() {
        // FR-8's second half, first line of defence. `io::copy` alone drains the
        // WHOLE source: a file still being written could push unbounded bytes
        // into the session cwd before `enforce_cap` gets to delete them. The
        // stream stops at the limit — one byte past the cap, which is exactly
        // enough to DETECT the overrun and never more.
        let dir = temp_cwd("capped-stream");
        let src = write_file(&dir.join("growing.bin"), b"0123456789");
        let target = dir.join("copy.bin");
        let mut file = std::fs::File::create(&target).unwrap();

        let written = copy_into(&src, &mut file, 4).unwrap();
        drop(file);

        assert_eq!(written, 4, "the stream stops at the limit");
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"0123",
            "nothing past the limit ever reaches the disk"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_source_that_outgrew_the_snapshot_stops_one_byte_past_the_cap() {
        // The two halves wired together: the stream is capped at cap+1 and
        // `enforce_cap` turns that extra byte into the refusal, so at most
        // cap+1 bytes ever exist under the cwd and none survive.
        let dir = temp_cwd("overrun");
        let src = write_file(
            &dir.join("huge.bin"),
            &vec![9u8; (ATTACHMENT_MAX_BYTES + 4096) as usize],
        );
        let target = dir.join("copy.bin");
        let mut file = std::fs::File::create(&target).unwrap();

        let written = copy_into(&src, &mut file, ATTACHMENT_MAX_BYTES + 1).unwrap();
        drop(file);

        assert_eq!(written, ATTACHMENT_MAX_BYTES + 1);
        assert_eq!(
            std::fs::metadata(&target).unwrap().len(),
            ATTACHMENT_MAX_BYTES + 1
        );
        assert_eq!(
            enforce_cap(&target, written).unwrap_err().code,
            ErrorCode::AttachmentTooLarge
        );
        assert!(!target.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_copy_at_the_cap_is_kept() {
        // Strictly-larger is the refusal (FR-8), so exactly the cap passes.
        let dir = temp_cwd("atcap");
        let target = write_file(&dir.join("exact.bin"), b"x");
        assert_eq!(
            enforce_cap(&target, ATTACHMENT_MAX_BYTES).unwrap(),
            ATTACHMENT_MAX_BYTES
        );
        assert!(target.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_directory_is_refused_without_creating_anything() {
        let cwd = temp_cwd("isdir");
        let folder = temp_cwd("isdir-folder");
        let cwd_s = cwd.to_string_lossy().to_string();

        let e = ingest_path(SID, &cwd_s, &folder.to_string_lossy(), 0).unwrap_err();

        assert_eq!(e.code, ErrorCode::AttachmentIsDirectory);
        assert!(!attachments_root(&cwd_s).exists());
        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&folder).ok();
    }

    #[test]
    fn a_missing_or_blank_path_is_invalid_input() {
        let cwd = temp_cwd("missing");
        let cwd_s = cwd.to_string_lossy().to_string();
        assert_eq!(
            ingest_path(SID, &cwd_s, "   ", 0).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        let ghost = cwd.join("nope.txt");
        assert_eq!(
            ingest_path(SID, &cwd_s, &ghost.to_string_lossy(), 0)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn a_relative_path_is_rejected_before_touching_the_filesystem() {
        // The contract's `AttachFileRequest.path` is documented "absolute, host
        // dialect"; a relative path must never be resolved against the
        // PROCESS's cwd instead of the session's cwd, so it is refused up front.
        let cwd = temp_cwd("relative");
        let cwd_s = cwd.to_string_lossy().to_string();
        write_file(&cwd.join("logo.png"), b"bytes!");

        let e = ingest_path(SID, &cwd_s, "logo.png", 0).unwrap_err();

        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert!(
            !attachments_root(&cwd_s).exists(),
            "a refused relative path creates no dir"
        );
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn a_clipboard_image_is_written_out_as_a_pasted_png() {
        // §9: "Pasting a screenshot writes pasted-<ts>.png under
        // .francois/attachments/<short8>/".
        let cwd = temp_cwd("paste");
        let cwd_s = cwd.to_string_lossy().to_string();
        // "hello" in base64
        let a = ingest_clipboard_image(SID, &cwd_s, "image/png", "aGVsbG8=", 11).unwrap();

        assert!(a.copied);
        assert!(a.origin_path.is_none(), "clipboard bytes have no origin");
        assert_eq!(a.kind, "image");
        assert_eq!(a.bytes, 5);
        assert_eq!(a.created_at, 11);
        assert!(a.name.starts_with("pasted-"), "{}", a.name);
        assert!(a.name.ends_with(".png"), "{}", a.name);
        assert_eq!(
            a.ref_path,
            format!(".francois/attachments/a3f9c1e2/{}", a.name)
        );
        assert_eq!(
            std::fs::read(std::path::PathBuf::from(&a.stored_path)).unwrap(),
            b"hello"
        );
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn a_clipboard_jpeg_gets_a_jpg_extension_and_a_second_paste_never_overwrites() {
        let cwd = temp_cwd("paste-jpg");
        let cwd_s = cwd.to_string_lossy().to_string();
        let first = ingest_clipboard_image(SID, &cwd_s, "image/jpeg", "aGVsbG8=", 0).unwrap();
        let second = ingest_clipboard_image(SID, &cwd_s, "image/jpeg", "aGVsbG8=", 0).unwrap();
        assert!(first.name.ends_with(".jpg"), "{}", first.name);
        assert_ne!(first.name, second.name, "FR-7: same-second pastes collide");
        assert!(std::path::PathBuf::from(&first.stored_path).exists());
        assert!(std::path::PathBuf::from(&second.stored_path).exists());
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn clipboard_refusals() {
        let cwd = temp_cwd("paste-bad");
        let cwd_s = cwd.to_string_lossy().to_string();
        assert_eq!(
            ingest_clipboard_image(SID, &cwd_s, "image/png", "!!not base64!!", 0)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            ingest_clipboard_image(SID, &cwd_s, "image/png", "", 0)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        // over the cap, decoded
        let big = base64_encode(&vec![7u8; (ATTACHMENT_MAX_BYTES + 1) as usize]);
        assert_eq!(
            ingest_clipboard_image(SID, &cwd_s, "image/png", &big, 0)
                .unwrap_err()
                .code,
            ErrorCode::AttachmentTooLarge
        );
        assert!(
            !attachments_root(&cwd_s).exists(),
            "a refused paste creates no dir"
        );
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn an_oversized_base64_payload_is_refused_before_it_is_decoded() {
        // FR-8 on the paste path. Decoding first means an oversized clipboard
        // payload forces the whole allocation the cap then throws away — the
        // same "cap enforced after the work" shape `copy_into` fixed on the file
        // path. The payload's LENGTH already proves it cannot fit.
        //
        // The proof the gate runs FIRST: a payload that is both oversized and
        // undecodable comes back ATTACHMENT_TOO_LARGE, not INVALID_INPUT.
        let junk = "!".repeat(ATTACHMENT_MAX_BASE64_CHARS as usize + 1);

        let e = decode_base64(&junk).unwrap_err();

        assert_eq!(e.code, ErrorCode::AttachmentTooLarge);
        let detail = e.detail.unwrap();
        assert_eq!(detail["cap"], ATTACHMENT_MAX_BYTES);
        assert!(
            detail["bytes"].as_u64().unwrap() > ATTACHMENT_MAX_BYTES,
            "the refusal reports DECODED bytes, so the chip's copy still reads in MB: {detail}"
        );
    }

    #[test]
    fn a_paste_at_the_cap_still_gets_through_the_pre_check() {
        // The pre-check is a BOUND on the encoding, not a second cap: exactly
        // ATTACHMENT_MAX_BYTES of image — padding and a `data:` prefix included —
        // must still decode, or FR-8's "10 MB" would silently become ~7.5 MB.
        let payload = format!(
            "data:image/png;base64,{}",
            base64_encode(&vec![3u8; ATTACHMENT_MAX_BYTES as usize])
        );
        assert!(payload.len() as u64 <= ATTACHMENT_MAX_BASE64_CHARS);
        assert_eq!(
            decode_base64(&payload).unwrap().len() as u64,
            ATTACHMENT_MAX_BYTES
        );
    }

    #[test]
    fn base64_decoding_tolerates_a_data_url_prefix_and_whitespace() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(
            decode_base64("data:image/png;base64,aGVsbG8=").unwrap(),
            b"hello"
        );
        assert_eq!(decode_base64("aGVs\n bG8=").unwrap(), b"hello");
        assert!(decode_base64("****").is_err());
    }

    #[test]
    fn the_gitignore_is_written_once_and_never_rewritten() {
        let cwd = temp_cwd("ignore");
        let cwd_s = cwd.to_string_lossy().to_string();
        ensure_attachments_dir(&cwd_s, SID).unwrap();
        let ignore = attachments_root(&cwd_s).join(".gitignore");
        assert_eq!(std::fs::read_to_string(&ignore).unwrap(), "*\n");
        std::fs::write(&ignore, "# edited by the user\n*\n").unwrap();
        ensure_attachments_dir(&cwd_s, SID).unwrap();
        assert_eq!(
            std::fs::read_to_string(&ignore).unwrap(),
            "# edited by the user\n*\n",
            "an existing .gitignore is never rewritten"
        );
        std::fs::remove_dir_all(&cwd).ok();
    }

    fn base64_encode(bytes: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }
}
