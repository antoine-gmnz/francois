//! code-editor-agents FR-1/FR-2: the `file.touched` signal — what a
//! file-mutating tool call does to its path, and the path itself translated
//! from whatever spelling the runtime used into the host's normalised form.

use crate::fs_util::norm_path;
use crate::wsl::is_wsl_unc_path;
use serde::Serialize;

/// Mirrors contract/common.ts `FileTouchKind`.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileTouchKind {
    Edit,
    Write,
    Delete,
}

impl FileTouchKind {
    /// Codex's patch-change kind: `add` → write, `delete` → delete, anything
    /// else (`update`, a move, an unknown or missing kind) → edit.
    pub(crate) fn from_patch_kind(kind: &str) -> Self {
        match kind {
            "add" => Self::Write,
            "delete" => Self::Delete,
            _ => Self::Edit,
        }
    }
}

fn has_drive(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic()
}

/// FR-1: a runtime-reported path as the host sees it, normalised (FR-2).
///
/// - A host-absolute path (drive letter or UNC) is kept.
/// - A Linux-absolute path from a WSL session is translated by the
///   `wsl-filesystem` rules: under a WSL UNC cwd it hangs off that cwd's own
///   `\\<host>\<distro>` prefix (pure — no `wsl.exe` probe); under a
///   drive-letter cwd, `/mnt/<d>/…` becomes `<D>:/…`. Anything else stays as
///   given (a native POSIX host).
/// - A relative path is joined onto `cwd`.
pub(crate) fn host_path(raw: &str, cwd: &str) -> String {
    let raw = raw.trim();
    let host = if has_drive(raw) || raw.starts_with(r"\\") || raw.starts_with("//") {
        raw.to_string()
    } else if raw.starts_with('/') {
        linux_to_host(raw, cwd)
    } else {
        let rel = raw
            .strip_prefix("./")
            .or_else(|| raw.strip_prefix(r".\"))
            .unwrap_or(raw);
        format!("{}/{rel}", norm_path(cwd).trim_end_matches('/'))
    };
    norm_path(&host)
}

fn linux_to_host(p: &str, cwd: &str) -> String {
    if is_wsl_unc_path(cwd) {
        let cwd = norm_path(cwd);
        let mut parts = cwd[2..].splitn(3, '/');
        let (host, distro) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        return format!("//{host}/{distro}{p}");
    }
    if has_drive(cwd) {
        if let Some(rest) = p.strip_prefix("/mnt/") {
            let mut chars = rest.chars();
            if let Some(letter) = chars.next().filter(char::is_ascii_alphabetic) {
                let tail = chars.as_str();
                if tail.is_empty() || tail.starts_with('/') {
                    return format!("{}:{tail}", letter.to_ascii_uppercase());
                }
            }
        }
    }
    p.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_serialises_lowercase_and_maps_codex_patch_kinds() {
        assert_eq!(serde_json::to_value(FileTouchKind::Edit).unwrap(), "edit");
        assert_eq!(serde_json::to_value(FileTouchKind::Write).unwrap(), "write");
        assert_eq!(
            serde_json::to_value(FileTouchKind::Delete).unwrap(),
            "delete"
        );
        assert_eq!(FileTouchKind::from_patch_kind("add"), FileTouchKind::Write);
        assert_eq!(
            FileTouchKind::from_patch_kind("update"),
            FileTouchKind::Edit
        );
        assert_eq!(
            FileTouchKind::from_patch_kind("delete"),
            FileTouchKind::Delete
        );
        assert_eq!(FileTouchKind::from_patch_kind(""), FileTouchKind::Edit);
    }

    #[test]
    fn host_absolute_paths_are_kept_and_normalised() {
        assert_eq!(
            host_path(r"c:\repo\src\a.ts", r"C:\repo"),
            "C:/repo/src/a.ts"
        );
        assert_eq!(
            host_path("/home/u/api/a.ts", "/home/u/api"),
            "/home/u/api/a.ts"
        );
        // Outside cwd is still emitted (FR-1).
        assert_eq!(host_path(r"D:\other\x.rs", r"C:\repo"), "D:/other/x.rs");
    }

    #[test]
    fn relative_paths_resolve_against_the_cwd() {
        assert_eq!(host_path("src/a.ts", r"C:\repo\"), "C:/repo/src/a.ts");
        assert_eq!(
            host_path("./src/a.ts", "/home/u/api"),
            "/home/u/api/src/a.ts"
        );
        assert_eq!(host_path(r"src\a.ts", r"c:\repo"), "C:/repo/src/a.ts");
    }

    #[test]
    fn wsl_linux_paths_translate_to_the_host_form() {
        assert_eq!(
            host_path("/home/u/api/src/a.ts", r"\\wsl.localhost\Ubuntu\home\u\api"),
            "//wsl.localhost/Ubuntu/home/u/api/src/a.ts"
        );
        assert_eq!(
            host_path("/etc/hosts", r"\\wsl$\Debian\home\u"),
            "//wsl$/Debian/etc/hosts"
        );
        assert_eq!(
            host_path("/mnt/d/acme-api/src/a.ts", r"D:\acme-api"),
            "D:/acme-api/src/a.ts"
        );
        // Not a drive mount: left alone.
        assert_eq!(host_path("/mnt/data/x", r"D:\acme-api"), "/mnt/data/x");
        // Relative under a UNC cwd joins like any other.
        assert_eq!(
            host_path("src/a.ts", r"\\wsl.localhost\Ubuntu\home\u\api"),
            "//wsl.localhost/Ubuntu/home/u/api/src/a.ts"
        );
    }
}
