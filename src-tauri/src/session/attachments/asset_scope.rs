//! FR-12: the bytes behind a staged image chip's thumbnail.
//!
//! The webview renders that thumbnail from `storedPath` through Tauri's
//! `asset://` protocol (`convertFileSrc`), and the protocol answers **403 for
//! every path outside its filesystem scope**. Enabling the protocol
//! (`app.security.assetProtocol.enable` + the `protocol-asset` cargo feature) is
//! only half of it — without a scope the webview can still read nothing.
//!
//! The scope is granted HERE, **one file at a time**, at the moment an
//! attachment is staged. A session cwd can be anywhere on disk, so a static glob
//! (`**/.francois/attachments/**`) would hand the webview read access across the
//! whole filesystem for every path that merely looks like an attachments dir.
//! Two further reasons per-file is not just narrower but the only reliable form:
//!
//!   * the scope's glob matching sets `require_literal_leading_dot` (true on
//!     unix), so a `**` wildcard does not traverse the `.francois` dot-segment
//!     at all — the static glob would grant nothing on macOS and Linux;
//!   * a grant is only ever made for a file Francois itself just ingested, so
//!     the webview's reach is exactly the set of images the user attached in
//!     this run, and it is empty until the user attaches one.
//!
//! Grants are never revoked. `Scope::forbid_file` takes PERMANENT precedence
//! over allowed paths, so forbidding a released attachment's path would also
//! blind the next attachment that legitimately claims that freed name (FR-7
//! reuses `report.pdf` once `report.pdf` is gone). The grants live only as long
//! as the process, and the files themselves are deleted on release.

use super::*;
use tauri::{AppHandle, Manager};

/// The stored paths the webview must be able to read: exactly the IMAGES among
/// the records just staged. The frontend builds a chip — and therefore an
/// `<img>` — only for `kind: 'image'`, so exposing a `file` would widen the
/// scope for a thumbnail nobody renders.
pub(crate) fn thumbnail_paths(attachments: &[Attachment]) -> Vec<&str> {
    attachments
        .iter()
        .filter(|a| a.kind == "image")
        .map(|a| a.stored_path.as_str())
        .collect()
}

/// Grant the webview read access to those files and to nothing else.
///
/// Best effort: a refused grant costs a thumbnail (the chip falls back to its
/// `▣` state) and never the attachment, which is already staged and already
/// referenced by the prompt.
pub(crate) fn allow_thumbnails(app: &AppHandle, attachments: &[Attachment]) {
    let scope = app.asset_protocol_scope();
    for path in thumbnail_paths(attachments) {
        let _ = scope.allow_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn only_the_images_are_exposed_to_the_webview() {
        // The scope is the app's read surface for the webview: it grows by
        // exactly the files a thumbnail is rendered from, and by no others.
        let png = std::path::PathBuf::from("/repo/.francois/attachments/a3f9c1e2/shot.png");
        let pdf = std::path::PathBuf::from("/repo/.francois/attachments/a3f9c1e2/report.pdf");
        let inplace = std::path::PathBuf::from("/repo/docs/logo.jpeg");
        let staged = vec![
            att(
                "1",
                ".francois/attachments/a3f9c1e2/shot.png",
                &png,
                true,
                "staged",
            ),
            att(
                "2",
                ".francois/attachments/a3f9c1e2/report.pdf",
                &pdf,
                true,
                "staged",
            ),
            // FR-1: an in-place ref renders a thumbnail too — from its ORIGIN,
            // which is the path the record already carries as `storedPath`.
            att("3", "docs/logo.jpeg", &inplace, false, "staged"),
        ];

        assert_eq!(
            thumbnail_paths(&staged),
            vec![png.to_string_lossy(), inplace.to_string_lossy()]
        );
        assert!(
            thumbnail_paths(&[]).is_empty(),
            "nothing staged, nothing granted"
        );
    }
}
