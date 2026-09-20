//! session/adapter/pi/wire/images.rs — pi-transcript-events FR-7: turning a
//! prompt's referenced attachments into the wire's own image content. Split
//! out of `wire.rs` (which was at the 1000-line cap) because this is the one
//! concern in that file that touches the FILESYSTEM: everything left there is
//! pure framing and serde.
//!
//! Two gates, in this order, before any byte is read:
//!   1. the connection's `images` capability (FR-7: "Reject unsupported model
//!      image input before submission"), and
//!   2. the attachment's own scope — the bytes must still live where the
//!      ingest pipeline said they do (`verify_inside_session_scope`).

use super::PiCommandBody;
use crate::ipc::{AppError, ErrorCode};
use crate::session::attachments::{
    mime_type_for_extension, AttachError, Attachment, ATTACHMENT_MAX_BYTES,
};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// FR-7: one image content part of a `prompt` command — bytes resolved and
/// base64-encoded server-side (`build_prompt_body`), never round-tripped
/// from React.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub(crate) struct PiPromptImage {
    pub(crate) data: String,
    #[serde(rename = "mimeType")]
    pub(crate) mime_type: String,
}

/// FR-7: build a `prompt` command's body from the user's text and the
/// session's CURRENT attachment records, resolving only the ones the text
/// actually references — the same `@refPath` convention
/// `Session::validate_attachment_submission` already checks before a send is
/// even attempted. Rejects with `RUNTIME_UNSUPPORTED` before anything is read
/// off disk when a referenced attachment is an image and the connection's own
/// capability snapshot marks `images` unavailable — the adapter's own gate,
/// independent of (and in addition to) the generic session-level one, since
/// `PiConnection` is the only thing that knows the ACTUAL wire shape a model
/// without vision would otherwise receive. Image bytes are read and
/// base64-encoded HERE, server-side, and never travel back through React —
/// FR-7's "never transmit base64 back to React".
pub(crate) fn build_prompt_body(
    text: String,
    attachments: &[Attachment],
    images_supported: bool,
) -> Result<PiCommandBody, AppError> {
    let referenced_images: Vec<&Attachment> = attachments
        .iter()
        .filter(|a| a.kind == "image" && text.contains(&format!("@{}", a.ref_path)))
        .collect();
    if !referenced_images.is_empty() && !images_supported {
        return Err(AppError::new(
            ErrorCode::RuntimeUnsupported,
            "runtime images capability is unavailable",
        ));
    }
    let mut images = Vec::with_capacity(referenced_images.len());
    for a in referenced_images {
        let bytes = read_capped(a)?;
        use base64::Engine as _;
        images.push(PiPromptImage {
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
            mime_type: mime_type_for_extension(&a.name).to_string(),
        });
    }
    Ok(PiCommandBody::Prompt { text, images })
}

/// LOW (review round 7): FR-7 says "Reuse existing attachment ingest/asset
/// scopes" — the size was capped on the read, but nothing checked that the
/// bytes still came from where ingest put them.
///
/// The legitimate roots are the session's own cwd and, inside it, the
/// per-session attachments dir (`attachments::paths`): `ingest_path` either
/// references a file already under the cwd (`relative_ref` proved it) or
/// copies it into `<cwd>/.francois/attachments/<short id>/`. Both branches
/// leave the SAME invariant on the record — `stored_path == <cwd>/<ref_path>`
/// — and that is what is re-checked here, against the CANONICAL path. It
/// needs no `cwd` parameter (the submission carries none) and it fails
/// exactly the escapes that matter:
///   * a symlink (file or directory) pointing outside the session tree
///     resolves away from `ref_path`'s tail;
///   * a record whose `stored_path` was rewritten to some other file no
///     longer matches its own `ref_path`;
///   * a `ref_path` carrying `..` never matches a canonical component;
///   * a path that cannot be canonicalized at all is refused rather than
///     read on trust.
/// The verified canonical path is what is then opened, so the window for a
/// swap between the check and the read is as small as this layer can make it.
fn verify_inside_session_scope(a: &Attachment) -> Result<PathBuf, AppError> {
    let refused = |why: &str| {
        AppError::new(
            ErrorCode::AttachmentNotFound,
            format!("attachment {} is outside the session scope: {why}", a.name),
        )
    };
    let canonical = std::fs::canonicalize(&a.stored_path)
        .map_err(|e| refused(&format!("path could not be resolved ({e})")))?;
    let relative: Vec<&std::ffi::OsStr> = Path::new(&a.ref_path)
        .components()
        .map(|c| match c {
            Component::Normal(s) => Ok(s),
            _ => Err(()),
        })
        .collect::<Result<Vec<_>, ()>>()
        .map_err(|()| refused("reference path is not a plain relative path"))?;
    if relative.is_empty() {
        return Err(refused("reference path is empty"));
    }
    let tail: Vec<&std::ffi::OsStr> = canonical
        .components()
        .rev()
        .take(relative.len())
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s),
            _ => None,
        })
        .collect();
    let matches = tail.len() == relative.len()
        && tail
            .iter()
            .rev()
            .zip(relative.iter())
            .all(|(a, b)| a.eq_ignore_ascii_case(b));
    if !matches {
        return Err(refused("resolved path does not match its reference path"));
    }
    Ok(canonical)
}

/// An image's bytes, capped. `Attachment.bytes` (what the frame gate sums) is
/// the size at INGEST, and an uncopied attachment sits in the session's cwd,
/// where the agent can rewrite it before the send — so the cap is re-enforced
/// on the READ, not on `metadata().len()` (a device symlink reports 0).
fn read_capped(a: &Attachment) -> Result<Vec<u8>, AppError> {
    use std::io::Read as _;
    let path = verify_inside_session_scope(a)?;
    let unreadable = |e: std::io::Error| {
        AppError::new(
            ErrorCode::RuntimeUnavailable,
            format!("could not read attachment {}: {e}", a.name),
        )
    };
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .map_err(unreadable)?
        .take(ATTACHMENT_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(unreadable)?;
    if bytes.len() as u64 > ATTACHMENT_MAX_BYTES {
        return Err(AttachError::too_large(bytes.len() as u64).into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const REF_DIR: &str = ".francois/attachments/a3f9c1e2";

    fn temp_cwd(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "francois-pi-images-{tag}-{}-{}",
            std::process::id(),
            crate::ids::uuid()
        ));
        std::fs::create_dir_all(dir.join(REF_DIR)).unwrap();
        dir
    }

    fn attachment(kind: &str, ref_path: &str, stored_path: &str, name: &str) -> Attachment {
        Attachment {
            id: "a1".into(),
            session_id: "s1".into(),
            kind: kind.into(),
            origin_path: None,
            stored_path: stored_path.into(),
            ref_path: ref_path.into(),
            name: name.into(),
            bytes: 1,
            copied: true,
            state: "sent".into(),
            created_at: 0,
        }
    }

    /// An attachment as `ingest.rs` records one: the stored path IS the cwd
    /// joined with the ref path.
    fn ingested(cwd: &Path, name: &str, bytes: &[u8]) -> Attachment {
        let ref_path = format!("{REF_DIR}/{name}");
        let stored = cwd.join(REF_DIR).join(name);
        std::fs::write(&stored, bytes).unwrap();
        attachment("image", &ref_path, &stored.to_string_lossy(), name)
    }

    #[test]
    fn a_text_only_prompt_carries_no_images() {
        let body = build_prompt_body("just text, no refs".into(), &[], true).unwrap();
        match body {
            PiCommandBody::Prompt { text, images } => {
                assert_eq!(text, "just text, no refs");
                assert!(images.is_empty());
            }
            _ => panic!("expected a prompt body"),
        }
    }

    #[test]
    fn a_referenced_image_is_resolved_and_base64_encoded_never_left_as_a_path() {
        let cwd = temp_cwd("resolve");
        let a = ingested(&cwd, "shot.png", b"hello");

        let body = build_prompt_body(format!("look at @{}", a.ref_path), &[a], true).unwrap();

        match body {
            PiCommandBody::Prompt { images, .. } => {
                assert_eq!(images.len(), 1);
                assert_eq!(images[0].mime_type, "image/png");
                use base64::Engine as _;
                assert_eq!(
                    base64::engine::general_purpose::STANDARD
                        .decode(&images[0].data)
                        .unwrap(),
                    b"hello"
                );
            }
            _ => panic!("expected a prompt body"),
        }
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn an_unreferenced_attachment_is_never_resolved() {
        let a = attachment(
            "image",
            &format!("{REF_DIR}/shot.png"),
            "/does/not/exist.png",
            "shot.png",
        );
        let body = build_prompt_body("nothing attached here".into(), &[a], true).unwrap();
        match body {
            PiCommandBody::Prompt { images, .. } => assert!(images.is_empty()),
            _ => panic!("expected a prompt body"),
        }
    }

    #[test]
    fn a_referenced_image_is_rejected_before_submission_when_images_are_unsupported() {
        let a = attachment(
            "image",
            &format!("{REF_DIR}/shot.png"),
            "/does/not/exist.png",
            "shot.png",
        );
        let err = build_prompt_body(format!("look at @{}", a.ref_path), &[a], false).unwrap_err();
        assert_eq!(err.code, ErrorCode::RuntimeUnsupported);
    }

    #[test]
    fn a_referenced_file_attachment_is_never_resolved_as_an_image() {
        // FR-7: "File paths remain explicit user attachments, not guessed
        // URLs" — a non-image kind never becomes image content, whatever the
        // capability snapshot says, and never touches the filesystem for it.
        let a = attachment(
            "file",
            &format!("{REF_DIR}/report.pdf"),
            "/does/not/exist.pdf",
            "report.pdf",
        );
        let body = build_prompt_body(format!("see @{}", a.ref_path), &[a], false).unwrap();
        match body {
            PiCommandBody::Prompt { images, .. } => assert!(images.is_empty()),
            _ => panic!("expected a prompt body"),
        }
    }

    #[test]
    fn a_missing_referenced_image_file_fails_explicitly_rather_than_silently_dropping() {
        let a = attachment(
            "image",
            &format!("{REF_DIR}/shot.png"),
            "/definitely/does/not/exist-francois-test.png",
            "shot.png",
        );
        let err = build_prompt_body(format!("look at @{}", a.ref_path), &[a], true).unwrap_err();
        // A path that cannot be canonicalized is refused as out of scope
        // rather than read on trust.
        assert_eq!(err.code, ErrorCode::AttachmentNotFound);
    }

    /// The cap is enforced against the bytes on disk AT SEND TIME. `bytes: 1`
    /// is what ingest recorded; the file has since grown past the cap — which
    /// the agent can do itself, since an uncopied attachment lives in its cwd.
    #[test]
    fn an_image_that_outgrew_the_cap_after_ingest_is_refused_not_read_whole() {
        let cwd = temp_cwd("too-large");
        let cap = crate::session::attachments::ATTACHMENT_MAX_BYTES;
        let a = ingested(&cwd, "shot.png", &vec![0u8; (cap + 1) as usize]);
        let result = build_prompt_body(format!("look at @{}", a.ref_path), &[a], true);
        std::fs::remove_dir_all(&cwd).ok();
        assert_eq!(result.unwrap_err().code, ErrorCode::AttachmentTooLarge);
    }

    /// LOW (review round 7): a record whose `stored_path` points somewhere
    /// else entirely — the bytes no longer come from where ingest put them,
    /// so they are not this session's attachment at all.
    #[test]
    fn an_attachment_whose_stored_path_left_its_reference_path_is_refused() {
        let cwd = temp_cwd("escaped");
        let outside = cwd.join("secret.png");
        std::fs::write(&outside, b"not yours").unwrap();
        let a = attachment(
            "image",
            &format!("{REF_DIR}/shot.png"),
            &outside.to_string_lossy(),
            "shot.png",
        );
        let err = build_prompt_body(format!("look at @{}", a.ref_path), &[a], true).unwrap_err();
        std::fs::remove_dir_all(&cwd).ok();
        assert_eq!(err.code, ErrorCode::AttachmentNotFound);
    }

    #[test]
    fn a_reference_path_climbing_out_with_dot_dot_is_refused() {
        let cwd = temp_cwd("dot-dot");
        let outside = cwd.join("secret.png");
        std::fs::write(&outside, b"not yours").unwrap();
        let a = attachment(
            "image",
            "../../secret.png",
            &outside.to_string_lossy(),
            "secret.png",
        );
        let err = build_prompt_body("look at @../../secret.png".into(), &[a], true).unwrap_err();
        std::fs::remove_dir_all(&cwd).ok();
        assert_eq!(err.code, ErrorCode::AttachmentNotFound);
    }

    /// The escape the size cap cannot see: the record is perfectly shaped, but
    /// the file in the attachments dir is a symlink to something outside the
    /// session tree. Unix-only because creating a symlink on Windows needs
    /// privileges a test run does not have.
    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_session_tree_is_refused_not_followed() {
        let cwd = temp_cwd("symlink");
        let outside = cwd.join("secret.png");
        std::fs::write(&outside, b"not yours").unwrap();
        let link = cwd.join(REF_DIR).join("shot.png");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let a = attachment(
            "image",
            &format!("{REF_DIR}/shot.png"),
            &link.to_string_lossy(),
            "shot.png",
        );
        let err = build_prompt_body(format!("look at @{}", a.ref_path), &[a], true).unwrap_err();
        std::fs::remove_dir_all(&cwd).ok();
        assert_eq!(err.code, ErrorCode::AttachmentNotFound);
    }

    /// A cwd that is itself reached through a symlink (macOS `/tmp`) must not
    /// make every attachment look like an escape: only the TAIL is compared,
    /// so the root may canonicalize to anything.
    #[test]
    fn a_cwd_whose_own_path_canonicalizes_differently_still_resolves() {
        let cwd = temp_cwd("canon");
        let a = ingested(&cwd, "shot.png", b"ok");
        // Reach the same file through a noisy, non-canonical path.
        let noisy = cwd
            .join(REF_DIR)
            .join("..")
            .join("a3f9c1e2")
            .join("shot.png");
        let a = Attachment {
            stored_path: noisy.to_string_lossy().to_string(),
            ..a
        };
        let body = build_prompt_body(format!("look at @{}", a.ref_path), &[a], true).unwrap();
        match body {
            PiCommandBody::Prompt { images, .. } => assert_eq!(images.len(), 1),
            _ => panic!("expected a prompt body"),
        }
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn a_prompt_with_images_serializes_them_under_the_images_key() {
        let cwd = temp_cwd("serialize");
        let a = ingested(&cwd, "shot.png", b"hi");
        let body = build_prompt_body(format!("look at @{}", a.ref_path), &[a], true).unwrap();
        let cmd = super::super::PiCommand {
            id: "abc".into(),
            body,
        };
        let v: Value = serde_json::from_str(cmd.to_line().trim_end()).unwrap();
        assert_eq!(v["type"], "prompt");
        assert_eq!(v["images"][0]["mimeType"], "image/png");
        std::fs::remove_dir_all(&cwd).ok();
    }
}
