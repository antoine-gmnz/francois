//! session-attachments FR-1..FR-7: the path/name arithmetic.
//!
//! Everything here is a pure function of its inputs except `create_unique`, which
//! CLAIMS a name on the filesystem (FR-7 is defined against what is on disk).
//! The constants MIRROR contract/session-attachments.ts byte-for-byte — the
//! frontend derives chips from the same values, so a drift here desyncs the UI.

use std::fs::{File, OpenOptions};
use std::path::{Component, Path, PathBuf};

/// FR-8. Files strictly larger than this are refused with ATTACHMENT_TOO_LARGE.
pub(crate) const ATTACHMENT_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// FR-8, applied to a clipboard payload BEFORE it is decoded. base64 packs 3
/// bytes into every 4 characters, so `ATTACHMENT_MAX_BYTES` needs at most
/// `4 * ceil(cap / 3)` characters: anything longer cannot possibly decode to
/// something within the cap, and decoding it first would force the whole
/// allocation the cap is about to throw away.
///
/// `BASE64_SLACK` keeps the bound from turning into a SECOND, tighter cap: it
/// covers the `=` padding, a `data:image/…;base64,` prefix and the modest
/// whitespace `decode_base64` tolerates. A payload padded with kilobytes of
/// whitespace is refused as too large — the trade the cap is worth.
const BASE64_SLACK: u64 = 1024;
pub(crate) const ATTACHMENT_MAX_BASE64_CHARS: u64 =
    (ATTACHMENT_MAX_BYTES + 2) / 3 * 4 + BASE64_SLACK;

/// The decoded size a base64 payload of `chars` characters carries — the number
/// FR-8's `detail.bytes` reports when the pre-check refuses, so the chip's copy
/// still talks about the image's size and never about its encoding's.
pub(crate) fn base64_decoded_bytes(chars: u64) -> u64 {
    chars / 4 * 3
}

/// FR-5. Extensions (lowercase, with dot) that classify as kind `image`.
pub(crate) const ATTACHMENT_IMAGE_EXTENSIONS: [&str; 5] =
    [".png", ".jpg", ".jpeg", ".gif", ".webp"];

/// FR-2. Directory segments appended to the session cwd.
pub(crate) const ATTACHMENTS_DIR_ROOT: &str = ".francois";
pub(crate) const ATTACHMENTS_DIR_NAME: &str = "attachments";

/// FR-3. Contents written to `<cwd>/.francois/.gitignore` on creation — a single
/// `*` ignores the folder's contents INCLUDING this file, so `git status` (and
/// therefore diff-view) never sees an attachment.
pub(crate) const ATTACHMENTS_GITIGNORE_BODY: &str = "*\n";

/// FR-5. Case-insensitive extension test on a file name or path.
pub(crate) fn attachment_kind_for_name(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if ATTACHMENT_IMAGE_EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        "image"
    } else {
        "file"
    }
}

/// FR-2. First 8 characters of the session id — the per-session folder name.
pub(crate) fn attachments_short_id(session_id: &str) -> String {
    session_id.chars().take(8).collect()
}

/// FR-2/FR-4. POSIX-separated attachments dir, relative to the session cwd.
pub(crate) fn attachments_dir_ref_path(session_id: &str) -> String {
    format!(
        "{ATTACHMENTS_DIR_ROOT}/{ATTACHMENTS_DIR_NAME}/{}",
        attachments_short_id(session_id)
    )
}

/// FR-2. The absolute attachments dir of a session, in the HOST's dialect.
pub(crate) fn attachments_dir(cwd: &str, session_id: &str) -> PathBuf {
    Path::new(cwd)
        .join(ATTACHMENTS_DIR_ROOT)
        .join(ATTACHMENTS_DIR_NAME)
        .join(attachments_short_id(session_id))
}

/// The `.francois` root of a session cwd (FR-3's gitignore lives directly in it).
pub(crate) fn attachments_root(cwd: &str) -> PathBuf {
    Path::new(cwd).join(ATTACHMENTS_DIR_ROOT)
}

/// Resolve `.`/`..` segments without touching the filesystem — the fallback for
/// a path `canonicalize` cannot resolve (a `\\wsl$\…` share that is not mounted,
/// a path that does not exist yet).
pub(crate) fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The comparable form of a path: canonical when the OS can produce one (that is
/// what resolves symlinks, 8.3 short names and Windows' case), lexical otherwise.
pub(crate) fn normalize_for_compare(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| lexical_normalize(path))
}

/// FR-4. POSIX-separated rendering of a RELATIVE path.
pub(crate) fn to_posix(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// FR-1/FR-4. `Some(refPath)` when `path` lies under `cwd` after normalization —
/// the "reference it in place, copy nothing" case. `None` when it lies outside.
pub(crate) fn relative_ref(cwd: &str, path: &Path) -> Option<String> {
    let base = normalize_for_compare(Path::new(cwd));
    let target = normalize_for_compare(path);
    let rel = target.strip_prefix(&base).ok()?;
    let posix = to_posix(rel);
    if posix.is_empty() {
        None // the cwd itself is not an attachment
    } else {
        Some(posix)
    }
}

/// Split a file name on its LAST dot. A leading dot belongs to the stem, so
/// `.gitignore` has no extension and never becomes `-2.gitignore`.
fn split_ext(name: &str) -> (&str, Option<&str>) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], Some(&name[i + 1..])),
        _ => (name, None),
    }
}

/// FR-7. CLAIM the first free name in `dir`: `report.pdf` → `report-2.pdf` →
/// `report-3.pdf` … and hand back `(name, the open file)`.
///
/// The claim is `create_new` — an EXCLUSIVE create, so the name is taken by the
/// very syscall that tests it. Probing with `exists()` and copying afterwards
/// left a window in which two concurrent attaches on one session cwd settled on
/// the same name and one silently overwrote the other; FR-7 says nothing is ever
/// overwritten, so a ref already sent keeps pointing at the bytes it named.
pub(crate) fn create_unique(dir: &Path, name: &str) -> std::io::Result<(String, File)> {
    let (stem, ext) = split_ext(name);
    let suffixed = |n: u64| match ext {
        Some(e) => format!("{stem}-{n}.{e}"),
        None => format!("{stem}-{n}"),
    };
    // The plain name first; then `-2`, `-3`, … (FR-7's example: report-2.pdf).
    match claim(dir, name) {
        Ok(file) => return Ok((name.to_string(), file)),
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
        Err(_) => {}
    }
    if let Some(hit) = claim_series(dir, &suffixed, 2, 10_000)? {
        return Ok(hit);
    }
    // Pathological: 10k collisions on one name. Fall back to a STAMPED series
    // rather than overwriting anything — and keep retrying, because a single
    // stamped claim collides with any other fallback in the same millisecond and
    // would surface that as an ATTACHMENT_IO_FAILED the user cannot act on.
    let start = super::super::now_ms();
    match claim_series(dir, &suffixed, start, start + FALLBACK_TRIES)? {
        Some(hit) => Ok(hit),
        None => Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "no free attachment name in this folder",
        )),
    }
}

/// How many stamped names the pathological fallback tries. Only reachable after
/// 10k collisions on one name, and then only against a concurrent fallback.
const FALLBACK_TRIES: u64 = 1_000;

/// Claim the first free `name(n)` for `n` in `start..end`. `Ok(None)` means every
/// name in the range was taken — a collision is a RETRY, never an error, which is
/// what makes this the shared body of both the `-2`, `-3`, … series and the
/// stamped fallback.
fn claim_series(
    dir: &Path,
    name: &dyn Fn(u64) -> String,
    start: u64,
    end: u64,
) -> std::io::Result<Option<(String, File)>> {
    for n in start..end {
        let candidate = name(n);
        match claim(dir, &candidate) {
            Ok(file) => return Ok(Some((candidate, file))),
            // Taken between two attempts (or already there): try the next name.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(None)
}

/// Create `dir/name` for writing, failing if anything already answers to it.
fn claim(dir: &Path, name: &str) -> std::io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join(name))
}

/// FR-6. The extension a clipboard image is written with; `png` by default.
pub(crate) fn extension_for_mime(mime: &str) -> &'static str {
    match mime.trim().to_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "png",
    }
}

/// FR-6. `pasted-<YYYYMMDD>-<HHMMSS>.<ext>`. The clock is a parameter so the
/// format is testable; callers pass `chrono::Local::now()` (LOCAL time, per spec).
pub(crate) fn pasted_name(mime: &str, now: chrono::DateTime<chrono::Local>) -> String {
    format!(
        "pasted-{}.{}",
        now.format("%Y%m%d-%H%M%S"),
        extension_for_mime(mime)
    )
}

/// The base name of a path, as the `name` field carries it.
pub(crate) fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::attachments::testutil::temp_dir;

    #[test]
    fn kind_is_image_for_the_five_extensions_case_insensitively() {
        for name in [
            "a.png",
            "b.JPG",
            "c.jpeg",
            "d.GIF",
            "e.webp",
            "shot.PNG",
            "/x/y/z.Png",
        ] {
            assert_eq!(attachment_kind_for_name(name), "image", "{name}");
        }
        for name in [
            "report.pdf",
            "notes.txt",
            "archive.png.zip",
            "noext",
            "a.svg",
        ] {
            assert_eq!(attachment_kind_for_name(name), "file", "{name}");
        }
    }

    #[test]
    fn short_id_and_dir_ref_path_mirror_the_contract() {
        let sid = "a3f9c1e2-1111-2222-3333-444444444444";
        assert_eq!(attachments_short_id(sid), "a3f9c1e2");
        assert_eq!(
            attachments_dir_ref_path(sid),
            ".francois/attachments/a3f9c1e2"
        );
        // a shorter-than-8 id degrades instead of panicking
        assert_eq!(attachments_short_id("abc"), "abc");
    }

    #[test]
    fn attachments_dir_hangs_off_the_session_cwd() {
        let dir = attachments_dir("/repo", "a3f9c1e2-x");
        assert!(dir.ends_with("a3f9c1e2"));
        assert!(dir.starts_with("/repo"));
        assert_eq!(attachments_root("/repo"), Path::new("/repo/.francois"));
    }

    #[test]
    fn relative_ref_is_posix_and_only_for_paths_under_the_cwd() {
        let root = temp_dir("relref");
        let inner = root.join("src").join("ui");
        std::fs::create_dir_all(&inner).unwrap();
        let file = inner.join("logo.png");
        std::fs::write(&file, b"x").unwrap();
        let cwd = root.to_string_lossy().to_string();

        // FR-1/FR-4: under the cwd → relative, POSIX-separated
        assert_eq!(
            relative_ref(&cwd, &file).as_deref(),
            Some("src/ui/logo.png")
        );

        // outside the cwd → None (the copy branch)
        let outside = root.parent().unwrap().join("elsewhere-xyz.txt");
        assert_eq!(relative_ref(&cwd, &outside), None);

        // the cwd itself is not an attachment
        assert_eq!(relative_ref(&cwd, &root), None);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn relative_ref_resolves_dot_segments() {
        let root = temp_dir("relref-dots");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::write(root.join("a").join("f.txt"), b"x").unwrap();
        let cwd = root.to_string_lossy().to_string();
        let noisy = root.join("a").join("..").join("a").join("f.txt");
        assert_eq!(relative_ref(&cwd, &noisy).as_deref(), Some("a/f.txt"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn create_unique_suffixes_before_the_extension() {
        let dir = temp_dir("unique");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(create_unique(&dir, "report.pdf").unwrap().0, "report.pdf");
        assert_eq!(create_unique(&dir, "report.pdf").unwrap().0, "report-2.pdf");
        assert_eq!(create_unique(&dir, "report.pdf").unwrap().0, "report-3.pdf");
        // extension-less and dotfile names
        assert_eq!(create_unique(&dir, "LICENSE").unwrap().0, "LICENSE");
        assert_eq!(create_unique(&dir, "LICENSE").unwrap().0, "LICENSE-2");
        assert_eq!(create_unique(&dir, ".gitignore").unwrap().0, ".gitignore");
        assert_eq!(create_unique(&dir, ".gitignore").unwrap().0, ".gitignore-2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_unique_claims_the_name_before_any_byte_is_written() {
        // FR-7 "Nothing is ever overwritten": the name must be claimed by the SAME
        // syscall that tests it. A check-then-write (`exists()` now, `copy()` later)
        // hands the same name to two ingestions racing on one session cwd, and one
        // silently overwrites the other.
        let dir = temp_dir("claim");
        std::fs::create_dir_all(&dir).unwrap();
        let (first, _handle) = create_unique(&dir, "shot.png").unwrap();
        // nothing written yet — the claim alone must move the next caller along
        assert_eq!(first, "shot.png");
        assert!(
            dir.join(&first).exists(),
            "the claim is on disk immediately"
        );
        assert_eq!(create_unique(&dir, "shot.png").unwrap().0, "shot-2.png");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn concurrent_claims_on_one_name_never_collide() {
        let dir = temp_dir("claim-race");
        std::fs::create_dir_all(&dir).unwrap();
        let names: Vec<String> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|i| {
                    let dir = dir.clone();
                    scope.spawn(move || {
                        let (name, mut f) = create_unique(&dir, "report.pdf").unwrap();
                        use std::io::Write as _;
                        f.write_all(format!("thread-{i}").as_bytes()).unwrap();
                        name
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let mut unique: Vec<String> = names.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), names.len(), "two claims settled on one name");
        // every writer's bytes survived — nothing was overwritten
        for name in &names {
            assert!(std::fs::read(dir.join(name))
                .unwrap()
                .starts_with(b"thread-"));
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn claim_series_walks_past_taken_names_and_stops_at_the_end() {
        // The retry mechanism BOTH the `-2`, `-3`, … series and the pathological
        // stamped fallback are built from: a fallback that claims once and
        // propagates `AlreadyExists` turns a same-millisecond double-fallback
        // into an ATTACHMENT_IO_FAILED the user cannot act on.
        let dir = temp_dir("series");
        std::fs::create_dir_all(&dir).unwrap();
        let name = |n: u64| format!("x-{n}.txt");
        std::fs::write(dir.join("x-100.txt"), b"a").unwrap();
        std::fs::write(dir.join("x-101.txt"), b"b").unwrap();

        let (claimed, _handle) = claim_series(&dir, &name, 100, 200).unwrap().unwrap();
        assert_eq!(claimed, "x-102.txt", "the first FREE name in the range");

        // every name in the range taken ⇒ Ok(None), never an error
        std::fs::write(dir.join("x-300.txt"), b"c").unwrap();
        assert!(claim_series(&dir, &name, 300, 301).unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pasted_name_is_local_time_stamped_with_the_mime_extension() {
        use chrono::TimeZone;
        let at = chrono::Local
            .with_ymd_and_hms(2026, 7, 30, 14, 25, 30)
            .unwrap();
        assert_eq!(pasted_name("image/png", at), "pasted-20260730-142530.png");
        assert_eq!(pasted_name("image/jpeg", at), "pasted-20260730-142530.jpg");
        assert_eq!(pasted_name("IMAGE/WEBP", at), "pasted-20260730-142530.webp");
        // FR-6: unknown/absent mime defaults to png
        assert_eq!(pasted_name("", at), "pasted-20260730-142530.png");
        assert_eq!(
            pasted_name("application/octet-stream", at),
            "pasted-20260730-142530.png"
        );
    }
}
