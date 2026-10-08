// editor/files.rs — code-editor: path safety, read/decode, atomic save (FR-8,
// FR-11) and the HEAD blob behind the gutter markers (FR-9).
//
// Everything here is plain filesystem + git; the Tauri commands in mod.rs only
// resolve the root (root.rs) and call in. The explorer listing lives in listing.rs.

use super::{
    EditorFile, EditorRoot, LineEnding, ReadOnlyReason, EDITOR_BINARY_SNIFF_BYTES,
    EDITOR_EDIT_CAP_BYTES, EDITOR_OPEN_CAP_BYTES,
};
use crate::diff::{git_routed, is_git_repo, GitHost};
use crate::ipc::{AppError, ErrorCode};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

type Res<T> = Result<T, AppError>;

fn outside(msg: &str) -> AppError {
    AppError::new(ErrorCode::EditorOutsideRoot, msg)
}

// ---------- FR-9: path safety ----------

pub(super) struct Resolved {
    /// Canonical location (or, when the file does not exist yet, canonical parent + name).
    pub abs: PathBuf,
    /// Relative to the root, '/'-separated.
    pub rel: String,
}

/// Canonicalise the longest existing prefix of `p` and append the rest. `p` must
/// carry no `..` (callers reject those first).
fn canonicalize_lenient(p: &Path) -> std::io::Result<PathBuf> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        // symlink_metadata: a dangling symlink "exists" and must not be walked past.
        if std::fs::symlink_metadata(&cur).is_ok() {
            let mut base = std::fs::canonicalize(&cur)?;
            for part in tail.iter().rev() {
                base.push(part);
            }
            return Ok(base);
        }
        let Some(name) = cur.file_name().map(|n| n.to_owned()) else {
            return Err(std::io::Error::from(std::io::ErrorKind::NotFound));
        };
        tail.push(name);
        if !cur.pop() {
            return Err(std::io::Error::from(std::io::ErrorKind::NotFound));
        }
    }
}

pub(super) fn has_git_component(rel: &Path) -> bool {
    rel.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|s| s.eq_ignore_ascii_case(".git"))
    })
}

/// Resolve `input` (relative to `root`, or an absolute path inside it) to a
/// canonical path under the canonical root. Refuses `..`, anything that
/// canonicalises outside the root (symlinks included) and `.git/` internals.
pub(super) fn resolve(root: &str, input: &str) -> Res<Resolved> {
    let root_c = std::fs::canonicalize(root)
        .map_err(|e| AppError::new(ErrorCode::Internal, format!("root unreadable: {e}")))?;
    let input = input.replace('\\', "/");
    let p = Path::new(&input);
    if input.trim().is_empty() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(outside("path escapes the root"));
    }
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else if p
        .components()
        .any(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
    {
        return Err(outside("path escapes the root"));
    } else {
        root_c.join(p)
    };
    let abs = canonicalize_lenient(&joined).map_err(|_| outside("path escapes the root"))?;
    let rel_path = abs
        .strip_prefix(&root_c)
        .map_err(|_| outside("path escapes the root"))?;
    if rel_path.as_os_str().is_empty() || has_git_component(rel_path) {
        return Err(outside("path is not an editable file under the root"));
    }
    let rel = rel_path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    Ok(Resolved { abs, rel })
}

// ---------- version ----------

fn hash16(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn version_from(meta: &std::fs::Metadata, bytes: &[u8]) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    format!("{mtime}:{}:{}", meta.len(), hash16(bytes))
}

/// `${mtimeMs}:${size}:${sha256-16hex}` of the file on disk; None when it is not a readable file.
pub(super) fn version_of(abs: &Path) -> Option<String> {
    let meta = std::fs::metadata(abs).ok()?;
    if !meta.is_file() {
        return None;
    }
    let bytes = std::fs::read(abs).ok()?;
    Some(version_from(&meta, &bytes))
}

// ---------- FR-6: read + decode ----------

pub(super) struct Loaded {
    pub text: String,
    pub version: String,
    pub line_ending: LineEnding,
    pub bom: bool,
    pub trailing_newline: bool,
    pub read_only: Option<ReadOnlyReason>,
}

pub(super) fn load(abs: &Path) -> Res<Loaded> {
    let meta = match std::fs::metadata(abs) {
        Ok(m) if m.is_file() => m,
        _ => {
            return Err(AppError::new(
                ErrorCode::EditorFileNotFound,
                "no such file under the root",
            ))
        }
    };
    if meta.len() > EDITOR_OPEN_CAP_BYTES {
        return Err(AppError::with_detail(
            ErrorCode::EditorTooLarge,
            "file is too large to open here",
            json!({ "size": meta.len() }),
        ));
    }
    let bytes = std::fs::read(abs)
        .map_err(|e| AppError::new(ErrorCode::Internal, format!("read failed: {e}")))?;
    let binary = || AppError::new(ErrorCode::EditorBinary, "binary or non-UTF-8 file");
    if bytes[..bytes.len().min(EDITOR_BINARY_SNIFF_BYTES)].contains(&0) {
        return Err(binary());
    }
    let (bom, body) = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => (true, rest),
        None => (false, &bytes[..]),
    };
    let raw = std::str::from_utf8(body).map_err(|_| binary())?;
    let line_ending = if raw.contains("\r\n") {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    };
    let read_only = if meta.len() > EDITOR_EDIT_CAP_BYTES {
        Some(ReadOnlyReason::TooLarge)
    } else if meta.permissions().readonly() {
        Some(ReadOnlyReason::Permission)
    } else {
        None
    };
    Ok(Loaded {
        text: raw.replace("\r\n", "\n"),
        version: version_from(&meta, &bytes),
        line_ending,
        bom,
        trailing_newline: raw.ends_with('\n'),
        read_only,
    })
}

/// FR-7: `git show HEAD:./<rel>` (LF-normalised); None when untracked, no HEAD, not a repo or not UTF-8.
fn head_text(root: &str, rel: &str) -> Option<String> {
    let host = GitHost::of(root);
    if !is_git_repo(&host, root) {
        return None;
    }
    let spec = format!("HEAD:./{rel}");
    let out = git_routed(&host, root, &["show", &spec]).ok()?;
    if out.code != 0 {
        return None;
    }
    String::from_utf8(out.stdout)
        .ok()
        .map(|s| s.replace("\r\n", "\n"))
}

pub(super) fn open_file(dir: &str, root: &EditorRoot, resolved: &Resolved) -> Res<EditorFile> {
    let l = load(&resolved.abs)?;
    Ok(EditorFile {
        root: root.clone(),
        path: resolved.rel.clone(),
        text: l.text,
        version: l.version,
        line_ending: l.line_ending,
        bom: l.bom,
        trailing_newline: l.trailing_newline,
        read_only: l.read_only.is_some(),
        read_only_reason: l.read_only,
        head_text: head_text(dir, &resolved.rel),
    })
}

// ---------- FR-8: atomic save ----------

/// Compare `base_version` with the disk, then temp-file + rename in the same
/// directory, keeping the original's permissions. A file missing on disk is
/// recreated (there is no version left to compare against).
pub(super) fn save_file(
    abs: &Path,
    text: &str,
    base_version: &str,
    line_ending: LineEnding,
    bom: bool,
) -> Res<String> {
    if abs.is_dir() {
        return Err(write_failed("target is a directory"));
    }
    let existing = std::fs::metadata(abs).ok();
    if existing.is_some() {
        let current = version_of(abs);
        if current.as_deref() != Some(base_version) {
            return Err(AppError::with_detail(
                ErrorCode::EditorStale,
                "the file changed on disk",
                json!({ "version": current }),
            ));
        }
    }
    let normalized = text.replace("\r\n", "\n");
    let body = match line_ending {
        LineEnding::Lf => normalized,
        LineEnding::Crlf => normalized.replace('\n', "\r\n"),
    };
    let mut bytes = Vec::with_capacity(body.len() + 3);
    if bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(body.as_bytes());

    let parent = abs
        .parent()
        .ok_or_else(|| write_failed("no parent directory"))?;
    let name = abs.file_name().unwrap_or_default().to_string_lossy();
    let tmp = parent.join(format!(".{name}.francois-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
        if let Some(meta) = &existing {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        std::fs::rename(&tmp, abs)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(write_failed(&e.to_string()));
    }
    version_of(abs).ok_or_else(|| write_failed("file vanished after write"))
}

fn write_failed(reason: &str) -> AppError {
    AppError::with_detail(
        ErrorCode::EditorWriteFailed,
        format!("could not save: {reason}"),
        json!({ "reason": reason }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::testutil::{git, TempDir};

    fn sroot() -> EditorRoot {
        EditorRoot::Session {
            session_id: "s".into(),
        }
    }

    fn root(d: &TempDir) -> String {
        d.path().to_string_lossy().into_owned()
    }

    fn code(e: AppError) -> ErrorCode {
        e.code
    }

    // ----- FR-9 path safety -----

    #[test]
    fn resolve_accepts_relative_and_absolute_inside_root() {
        let d = TempDir::new();
        std::fs::create_dir_all(d.path().join("src")).unwrap();
        std::fs::write(d.path().join("src/a.ts"), "x").unwrap();
        let r = resolve(&root(&d), "src/a.ts").unwrap();
        assert_eq!(r.rel, "src/a.ts");
        let abs = d.path().join("src").join("a.ts");
        let r2 = resolve(&root(&d), &abs.to_string_lossy()).unwrap();
        assert_eq!(r2.rel, "src/a.ts");
        assert_eq!(resolve(&root(&d), "./src\\a.ts").unwrap().rel, "src/a.ts");
    }

    #[test]
    fn resolve_refuses_traversal_absolute_outside_and_git_internals() {
        let d = TempDir::new();
        let outside_dir = TempDir::new();
        std::fs::write(outside_dir.path().join("x.txt"), "x").unwrap();
        std::fs::create_dir_all(d.path().join(".git")).unwrap();
        std::fs::write(d.path().join(".git/config"), "x").unwrap();
        for p in [
            "../x.txt",
            "a/../../x.txt",
            ".git/config",
            ".GIT/config",
            "",
            ".",
        ] {
            let e = resolve(&root(&d), p).err().expect(p);
            assert_eq!(code(e), ErrorCode::EditorOutsideRoot, "{p}");
        }
        let abs = outside_dir.path().join("x.txt");
        let e = resolve(&root(&d), &abs.to_string_lossy()).err().unwrap();
        assert_eq!(code(e), ErrorCode::EditorOutsideRoot);
    }

    #[test]
    fn resolve_refuses_symlink_escape() {
        let d = TempDir::new();
        let outside_dir = TempDir::new();
        std::fs::write(outside_dir.path().join("secret.txt"), "s").unwrap();
        let link = d.path().join("link");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(outside_dir.path(), &link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(outside_dir.path(), &link).is_ok();
        if !made {
            return; // no symlink privilege on this box (Windows without developer mode)
        }
        let e = resolve(&root(&d), "link/secret.txt").err().unwrap();
        assert_eq!(code(e), ErrorCode::EditorOutsideRoot);
    }

    #[test]
    fn resolve_allows_a_not_yet_existing_file_in_an_existing_dir() {
        let d = TempDir::new();
        let r = resolve(&root(&d), "new.txt").unwrap();
        assert_eq!(r.rel, "new.txt");
        assert!(!r.abs.exists());
    }

    // ----- FR-6 read -----

    #[test]
    fn load_decodes_bom_crlf_and_trailing_newline() {
        let d = TempDir::new();
        let p = d.path().join("a.txt");
        std::fs::write(&p, b"\xEF\xBB\xBFone\r\ntwo\r\n").unwrap();
        let l = load(&p).unwrap();
        assert_eq!(l.text, "one\ntwo\n");
        assert!(l.bom && l.trailing_newline);
        assert_eq!(l.line_ending, LineEnding::Crlf);
        assert!(l.read_only.is_none());
        std::fs::write(&p, "plain").unwrap();
        let l = load(&p).unwrap();
        assert_eq!(l.line_ending, LineEnding::Lf);
        assert!(!l.bom && !l.trailing_newline);
    }

    #[test]
    fn load_refuses_binary_missing_directories_and_huge_files() {
        let d = TempDir::new();
        let p = d.path().join("b.bin");
        std::fs::write(&p, b"ab\0cd").unwrap();
        assert_eq!(code(load(&p).err().unwrap()), ErrorCode::EditorBinary);
        std::fs::write(&p, [0xff, 0xfe, 0x41]).unwrap();
        assert_eq!(code(load(&p).err().unwrap()), ErrorCode::EditorBinary);
        assert_eq!(
            code(load(&d.path().join("nope")).err().unwrap()),
            ErrorCode::EditorFileNotFound
        );
        assert_eq!(
            code(load(d.path()).err().unwrap()),
            ErrorCode::EditorFileNotFound
        );
        let big = d.path().join("big.txt");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(EDITOR_OPEN_CAP_BYTES + 1).unwrap();
        let e = load(&big).err().unwrap();
        assert_eq!(e.code, ErrorCode::EditorTooLarge);
        assert!(e.detail.unwrap()["size"].is_u64());
    }

    #[test]
    fn load_marks_files_over_the_edit_cap_read_only() {
        let d = TempDir::new();
        let p = d.path().join("mid.txt");
        std::fs::write(&p, "a".repeat(EDITOR_EDIT_CAP_BYTES as usize + 1)).unwrap();
        let l = load(&p).unwrap();
        assert_eq!(l.read_only, Some(ReadOnlyReason::TooLarge));
    }

    // ----- FR-8 save -----

    #[test]
    fn save_round_trips_crlf_and_bom_and_returns_the_new_version() {
        let d = TempDir::new();
        let p = d.path().join("a.txt");
        std::fs::write(&p, b"\xEF\xBB\xBFone\r\ntwo\r\n").unwrap();
        let l = load(&p).unwrap();
        let v = save_file(&p, "one\nTWO\n", &l.version, LineEnding::Crlf, true).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"\xEF\xBB\xBFone\r\nTWO\r\n");
        assert_eq!(Some(v), version_of(&p));
        let again = load(&p).unwrap();
        assert_eq!(again.text, "one\nTWO\n");
    }

    #[test]
    fn save_normalises_pasted_lf_and_keeps_no_trailing_newline() {
        let d = TempDir::new();
        let p = d.path().join("a.txt");
        std::fs::write(&p, "a\r\nb").unwrap();
        let v = load(&p).unwrap().version;
        save_file(&p, "a\nb\nc", &v, LineEnding::Crlf, false).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"a\r\nb\r\nc");
    }

    #[test]
    fn save_refuses_a_stale_base_version_and_leaves_disk_alone() {
        let d = TempDir::new();
        let p = d.path().join("a.txt");
        std::fs::write(&p, "one").unwrap();
        let v = load(&p).unwrap().version;
        std::fs::write(&p, "agent wrote this").unwrap();
        let e = save_file(&p, "mine", &v, LineEnding::Lf, false)
            .err()
            .unwrap();
        assert_eq!(e.code, ErrorCode::EditorStale);
        assert_eq!(
            e.detail.unwrap()["version"].as_str().map(str::to_string),
            version_of(&p)
        );
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "agent wrote this");
    }

    #[test]
    fn save_is_atomic_leaves_no_temp_and_recreates_a_deleted_file() {
        let d = TempDir::new();
        let p = d.path().join("a.txt");
        std::fs::write(&p, "one").unwrap();
        let v = load(&p).unwrap().version;
        save_file(&p, "two", &v, LineEnding::Lf, false).unwrap();
        std::fs::remove_file(&p).unwrap();
        save_file(&p, "three", &v, LineEnding::Lf, false).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "three");
        let leftovers: Vec<_> = std::fs::read_dir(d.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["a.txt".to_string()]);
    }

    #[test]
    fn save_into_a_missing_directory_is_write_failed() {
        let d = TempDir::new();
        let p = d.path().join("nodir").join("a.txt");
        let e = save_file(&p, "x", "0:0:0", LineEnding::Lf, false)
            .err()
            .unwrap();
        assert_eq!(e.code, ErrorCode::EditorWriteFailed);
    }

    #[cfg(unix)]
    #[test]
    fn save_preserves_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let d = TempDir::new();
        let p = d.path().join("run.sh");
        std::fs::write(&p, "#!/bin/sh").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        let v = load(&p).unwrap().version;
        save_file(&p, "#!/bin/sh\necho", &v, LineEnding::Lf, false).unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
    }

    // ----- FR-9 HEAD blob -----

    #[test]
    fn open_file_reports_head_text_for_tracked_files_and_null_otherwise() {
        let d = TempDir::new();
        git(d.path(), &["init", "-q"]);
        std::fs::write(d.path().join("t.txt"), "head\r\nline\r\n").unwrap();
        git(d.path(), &["add", "t.txt"]);
        git(d.path(), &["commit", "-q", "-m", "init"]);
        std::fs::write(d.path().join("t.txt"), "edited\n").unwrap();
        std::fs::write(d.path().join("u.txt"), "new").unwrap();
        let r = root(&d);
        let f = open_file(&r, &sroot(), &resolve(&r, "t.txt").unwrap()).unwrap();
        assert_eq!(f.head_text.as_deref(), Some("head\nline\n"));
        assert_eq!(f.text, "edited\n");
        let u = open_file(&r, &sroot(), &resolve(&r, "u.txt").unwrap()).unwrap();
        assert_eq!(u.head_text, None);
    }

    #[test]
    fn open_file_outside_a_repo_has_no_head_text() {
        let d = TempDir::new();
        std::fs::write(d.path().join("t.txt"), "x").unwrap();
        let r = root(&d);
        let f = open_file(&r, &sroot(), &resolve(&r, "t.txt").unwrap()).unwrap();
        assert_eq!(f.head_text, None);
    }
}
