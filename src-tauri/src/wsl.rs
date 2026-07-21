// wsl.rs — WSL filesystem integration (specs/wsl-filesystem.md). Pure path
// vocabulary + the FR-3 UNC root cache, shared by diff.rs (git routing, FR-5..9)
// and main.rs/session.rs (shell + Engine, FR-10..14). Mirrors
// contract/wsl-filesystem.ts EXACTLY (is_wsl_unc_path <-> isWslUncPath,
// wsl_unc_to_linux <-> wslUncToLinux) — keep both in lockstep;
// contract/wsl-filesystem.test.ts pins the cases this file's tests mirror.
//
// NO IPC command, NO event member, NO ErrorCode is defined here (spec §5) — this
// module only changes behavior behind the existing diff/shell channels.

use std::process::{Command, Stdio};
use std::sync::OnceLock;

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash (wsl.exe)
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

// ---------- FR-1/FR-2: path vocabulary (mirrors contract/wsl-filesystem.ts) ----------

const WSL_PREFIXES: [&str; 2] = ["\\\\wsl$\\", "\\\\wsl.localhost\\"];

fn backslashed(p: &str) -> String {
    p.replace('/', "\\")
}

/// True for `\\wsl$\<distro>\…` and `\\wsl.localhost\<distro>\…` (case-insensitive
/// prefix; forward slashes tolerated on input). Everything else — including
/// `/mnt/...`-style strings and drive letters — is false. Mirrors
/// contract/wsl-filesystem.ts::isWslUncPath EXACTLY (FR-1).
pub fn is_wsl_unc_path(p: &str) -> bool {
    let n = backslashed(p).to_lowercase();
    WSL_PREFIXES.iter().any(|pre| n.starts_with(*pre) && n.len() > pre.len())
}

/// `\\wsl$\Ubuntu\home\u\api` -> `("Ubuntu", "/home/u/api")`. Distro case is
/// preserved (only the prefix match is case-insensitive); a root-only path (with
/// or without a trailing separator) maps to `"/"`; trailing separators elsewhere
/// are tolerated. `None` for anything that is not a WSL UNC path. Mirrors
/// contract/wsl-filesystem.ts::wslUncToLinux EXACTLY (FR-2).
pub fn wsl_unc_to_linux(p: &str) -> Option<(String, String)> {
    let n = backslashed(p); // original case preserved
    let lower = n.to_lowercase();
    let pre = WSL_PREFIXES.iter().copied().find(|pre| lower.starts_with(*pre) && n.len() > pre.len())?;
    let rest = &n[pre.len()..]; // ASCII prefix — byte offset == char offset in n too
    let sep = rest.find('\\');
    let distro = match sep {
        Some(i) => &rest[..i],
        None => rest,
    };
    if distro.is_empty() {
        return None;
    }
    let tail = match sep {
        Some(i) => &rest[i + 1..],
        None => "",
    };
    let segments: Vec<&str> = tail.split('\\').filter(|s| !s.is_empty()).collect();
    Some((distro.to_string(), format!("/{}", segments.join("/"))))
}

// ---------- FR-3: UNC root discovery ----------

static WSL_UNC_ROOT: OnceLock<Option<String>> = OnceLock::new();

/// The default distro's UNC root, resolved **once per app run** via
/// `wsl.exe -- wslpath -w /` (e.g. `\\wsl.localhost\Ubuntu\`) and cached (FR-3).
/// UTF-8 stdout — this is WHY we don't parse `wsl.exe -l -q`/`-v`, which prints
/// UTF-16LE (confirmed live: every character comes back interleaved with a NUL,
/// garbage under a UTF-8 read — spec §7's "never parsed" trap). `None` on any
/// failure (wsl.exe missing, non-zero exit, empty output) — WSL-dependent
/// operations then take their §7 degraded path instead of erroring the whole
/// session. Logged once via eprintln (the OnceLock guarantees the probe itself
/// only runs once).
pub fn wsl_unc_root() -> Option<&'static str> {
    WSL_UNC_ROOT
        .get_or_init(|| {
            let mut cmd = Command::new("wsl.exe");
            cmd.args(["--", "wslpath", "-w", "/"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
            no_window(&mut cmd);
            match cmd.output() {
                Ok(out) if out.status.success() => {
                    let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if root.is_empty() {
                        eprintln!("wsl-filesystem: `wsl.exe -- wslpath -w /` returned empty output; WSL UNC root unavailable");
                        None
                    } else {
                        Some(root)
                    }
                }
                Ok(out) => {
                    eprintln!(
                        "wsl-filesystem: `wsl.exe -- wslpath -w /` exited {:?}; WSL UNC root unavailable",
                        out.status.code()
                    );
                    None
                }
                Err(e) => {
                    eprintln!("wsl-filesystem: could not spawn wsl.exe ({e}); WSL UNC root unavailable");
                    None
                }
            }
        })
        .as_deref()
}

/// Join an already-resolved UNC root (as returned by `wsl_unc_root()`, ending in
/// `\`) with a Linux path: strip the leading `/` and flip the remaining
/// separators. Kept separate from the `OnceLock` global purely so this join logic
/// is unit-testable without spawning `wsl.exe`.
fn join_unc_root(root: &str, linux_path: &str) -> String {
    let stripped = linux_path.strip_prefix('/').unwrap_or(linux_path);
    format!("{root}{}", stripped.replace('/', "\\"))
}

/// Reverse of `wsl_unc_to_linux` for the default distro (FR-3): `/home/u/api` ->
/// `\\wsl.localhost\Ubuntu\home\u\api`. `None` if the FR-3 root could not be
/// discovered.
pub fn linux_to_wsl_unc(linux_path: &str) -> Option<String> {
    wsl_unc_root().map(|root| join_unc_root(root, linux_path))
}

/// The default distro's name (e.g. `Ubuntu`), derived from the FR-3 root. Used for
/// FR-12's wsl `shellName`. `None` if the root could not be discovered (caller
/// falls back to the literal `"wsl"` per spec §7).
pub fn wsl_distro_name() -> Option<String> {
    wsl_unc_to_linux(wsl_unc_root()?).map(|(distro, _)| distro)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- is_wsl_unc_path (mirrors contract/wsl-filesystem.test.ts describe('isWslUncPath')) ----

    #[test]
    fn is_wsl_unc_path_recognizes_both_prefixes() {
        assert!(is_wsl_unc_path("\\\\wsl$\\Ubuntu\\home\\u\\api"));
        assert!(is_wsl_unc_path("\\\\wsl.localhost\\Ubuntu\\home\\u"));
    }

    #[test]
    fn is_wsl_unc_path_case_insensitive_and_slash_tolerant() {
        assert!(is_wsl_unc_path("\\\\WSL$\\Ubuntu"));
        assert!(is_wsl_unc_path("\\\\Wsl.LocalHost\\Debian\\srv"));
        assert!(is_wsl_unc_path("//wsl$/Ubuntu/home/u"));
    }

    #[test]
    fn is_wsl_unc_path_requires_a_distro_segment() {
        assert!(!is_wsl_unc_path("\\\\wsl$\\"));
        assert!(!is_wsl_unc_path("\\\\wsl$"));
    }

    #[test]
    fn is_wsl_unc_path_rejects_non_wsl_paths() {
        assert!(!is_wsl_unc_path("D:\\francois"));
        assert!(!is_wsl_unc_path("C:\\Users\\u\\wsl$\\trick"));
        assert!(!is_wsl_unc_path("\\\\server\\share\\repo"));
        assert!(!is_wsl_unc_path("/mnt/c/Users/u"));
        assert!(!is_wsl_unc_path("/home/u/api"));
        assert!(!is_wsl_unc_path(""));
    }

    // ---- wsl_unc_to_linux (mirrors describe('wslUncToLinux')) ----

    #[test]
    fn wsl_unc_to_linux_translates_nested_path_preserving_distro_case() {
        assert_eq!(
            wsl_unc_to_linux("\\\\wsl$\\Ubuntu\\home\\u\\api"),
            Some(("Ubuntu".to_string(), "/home/u/api".to_string()))
        );
        assert_eq!(
            wsl_unc_to_linux("\\\\wsl.localhost\\Ubuntu-22.04\\srv\\x"),
            Some(("Ubuntu-22.04".to_string(), "/srv/x".to_string()))
        );
    }

    #[test]
    fn wsl_unc_to_linux_maps_root_only_path_to_slash() {
        assert_eq!(wsl_unc_to_linux("\\\\wsl$\\Ubuntu"), Some(("Ubuntu".to_string(), "/".to_string())));
        assert_eq!(wsl_unc_to_linux("\\\\wsl$\\Ubuntu\\"), Some(("Ubuntu".to_string(), "/".to_string())));
    }

    #[test]
    fn wsl_unc_to_linux_tolerates_trailing_separators_and_forward_slashes() {
        assert_eq!(wsl_unc_to_linux("//wsl$/Ubuntu/home/u/"), Some(("Ubuntu".to_string(), "/home/u".to_string())));
    }

    #[test]
    fn wsl_unc_to_linux_returns_none_for_non_wsl_paths() {
        assert_eq!(wsl_unc_to_linux("D:\\francois"), None);
        assert_eq!(wsl_unc_to_linux("\\\\server\\share"), None);
        assert_eq!(wsl_unc_to_linux("/mnt/c/repo"), None);
    }

    // ---- FR-3 helpers (root discovery itself is impure — not spawned in tests) ----

    #[test]
    fn join_unc_root_strips_leading_slash_and_flips_separators() {
        assert_eq!(join_unc_root("\\\\wsl.localhost\\Ubuntu\\", "/home/u/api"), "\\\\wsl.localhost\\Ubuntu\\home\\u\\api");
        assert_eq!(join_unc_root("\\\\wsl.localhost\\Ubuntu\\", "/"), "\\\\wsl.localhost\\Ubuntu\\");
    }

    #[test]
    fn distro_name_extraction_matches_the_live_root_shape() {
        // wsl_distro_name() itself needs a live wsl_unc_root() (not spawned in
        // tests); its distro-extraction step is exactly wsl_unc_to_linux applied to
        // the root string — exercised directly here against the exact shape
        // `wsl.exe -- wslpath -w /` returns (confirmed live on a dev machine:
        // `\\wsl.localhost\Debian\`).
        assert_eq!(wsl_unc_to_linux("\\\\wsl.localhost\\Debian\\").map(|(d, _)| d), Some("Debian".to_string()));
    }
}
