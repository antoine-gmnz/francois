// wsl.rs — WSL filesystem integration (specs/wsl-filesystem.md). Pure path
// vocabulary + the FR-3 UNC root cache, shared by diff.rs (git routing, FR-5..9)
// and main.rs/session.rs (shell + Engine, FR-10..14). Mirrors
// contract/wsl-filesystem.ts EXACTLY (is_wsl_unc_path <-> isWslUncPath,
// wsl_unc_to_linux <-> wslUncToLinux) — keep both in lockstep;
// contract/wsl-filesystem.test.ts pins the cases this file's tests mirror.
//
// NO IPC command, NO event member, NO ErrorCode is defined here (spec §5) — this
// module only changes behavior behind the existing diff/shell channels.

use std::collections::{HashMap, HashSet};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

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
    WSL_PREFIXES
        .iter()
        .any(|pre| n.starts_with(*pre) && n.len() > pre.len())
}

/// `\\wsl$\Ubuntu\home\u\api` -> `("Ubuntu", "/home/u/api")`. Distro case is
/// preserved (only the prefix match is case-insensitive); a root-only path (with
/// or without a trailing separator) maps to `"/"`; trailing separators elsewhere
/// are tolerated. `None` for anything that is not a WSL UNC path. Mirrors
/// contract/wsl-filesystem.ts::wslUncToLinux EXACTLY (FR-2).
pub fn wsl_unc_to_linux(p: &str) -> Option<(String, String)> {
    let n = backslashed(p); // original case preserved
    let lower = n.to_lowercase();
    let pre = WSL_PREFIXES
        .iter()
        .copied()
        .find(|pre| lower.starts_with(*pre) && n.len() > pre.len())?;
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

// ---------- distro targeting (multi-distro remediation) ----------

/// The `wsl.exe` argv prefix positioning a spawn in a session's cwd. For a WSL
/// UNC cwd this targets the distro NAMED IN THE PATH — `-d <distro> --cd
/// <linux-path>` — because bare `wsl.exe` hits the DEFAULT distro, which on many
/// machines (docker-desktop after a Docker Desktop install, multi-distro setups)
/// is not where the repo lives; `--cd` would then point at a directory that does
/// not exist there. For any other cwd: `--cd <cwd>` verbatim (wsl.exe maps a
/// drive-letter path to `/mnt/…` itself — verified live; a WSL UNC path handed
/// to `--cd` raw is rejected with Wsl/E_INVALIDARG, hence the pre-translation).
pub fn wsl_base_args(cwd: &str) -> Vec<String> {
    match wsl_unc_to_linux(cwd) {
        Some((distro, linux)) => vec!["-d".into(), distro, "--cd".into(), linux],
        None => vec!["--cd".into(), cwd.to_string()],
    }
}

/// Decode output from a `wsl.exe` spawn for human display. wsl.exe reports its
/// OWN failures (unknown distro, bad `--cd`, WSL not installed) in UTF-16LE —
/// the same trap as `wsl -l -q` — while anything a program INSIDE the distro
/// prints is UTF-8. A UTF-8 read of the former shows NUL-interleaved garbage, so
/// sniff for NULs and decode accordingly. Also strips a leading BOM.
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    let s = if bytes.contains(&0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_string()
}

// ---------- FR-3: UNC root discovery (per distro) ----------

/// UNC roots by distro, keyed lowercase ("" = the default distro). Only
/// SUCCESSES are cached: a probe that fails while WSL is still booting (cold
/// start) must not degrade the whole app run, so failures retry on the next
/// call. `WSL_ROOT_LOGGED` keeps the failure eprintln to once per distro.
static WSL_UNC_ROOTS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static WSL_ROOT_LOGGED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn log_root_failure_once(key: &str, what: &str) {
    let logged = WSL_ROOT_LOGGED.get_or_init(|| Mutex::new(HashSet::new()));
    if logged.lock().unwrap().insert(key.to_string()) {
        eprintln!("wsl-filesystem: {what}; WSL UNC root unavailable (will retry)");
    }
}

/// A distro's UNC root, resolved via `wsl.exe [-d <distro>] -- wslpath -w /`
/// (e.g. `\\wsl.localhost\Ubuntu\`) and cached per distro (FR-3). `None` = the
/// default distro. UTF-8 stdout — this is WHY we don't parse `wsl.exe -l
/// -q`/`-v`, which prints UTF-16LE (spec §7's "never parsed" trap). `None` on
/// any failure (wsl.exe missing, non-zero exit, empty output) — WSL-dependent
/// operations then take their §7 degraded path instead of erroring the session.
pub fn wsl_unc_root(distro: Option<&str>) -> Option<String> {
    let key = distro.map(str::to_lowercase).unwrap_or_default();
    let cache = WSL_UNC_ROOTS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(root) = cache.lock().unwrap().get(&key).cloned() {
        return Some(root);
    }
    let mut cmd = Command::new("wsl.exe");
    if let Some(d) = distro {
        cmd.args(["-d", d]);
    }
    cmd.args(["--", "wslpath", "-w", "/"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    no_window(&mut cmd);
    match cmd.output() {
        Ok(out) if out.status.success() => {
            let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if root.is_empty() {
                log_root_failure_once(&key, "`wslpath -w /` returned empty output");
                None
            } else {
                cache.lock().unwrap().insert(key, root.clone());
                Some(root)
            }
        }
        Ok(out) => {
            log_root_failure_once(
                &key,
                &format!("`wslpath -w /` exited {:?}", out.status.code()),
            );
            None
        }
        Err(e) => {
            log_root_failure_once(&key, &format!("could not spawn wsl.exe ({e})"));
            None
        }
    }
}

/// Join an already-resolved UNC root (as returned by `wsl_unc_root()`, ending in
/// `\`) with a Linux path: strip the leading `/` and flip the remaining
/// separators. Kept separate from the `OnceLock` global purely so this join logic
/// is unit-testable without spawning `wsl.exe`.
fn join_unc_root(root: &str, linux_path: &str) -> String {
    let stripped = linux_path.strip_prefix('/').unwrap_or(linux_path);
    format!("{root}{}", stripped.replace('/', "\\"))
}

/// Reverse of `wsl_unc_to_linux` (FR-3): `/home/u/api` ->
/// `\\wsl.localhost\Ubuntu\home\u\api`, in the given distro (`None` = default).
/// `None` if the FR-3 root could not be discovered.
pub fn linux_to_wsl_unc(distro: Option<&str>, linux_path: &str) -> Option<String> {
    wsl_unc_root(distro).map(|root| join_unc_root(&root, linux_path))
}

/// The distro a session's shell/claude lands in (FR-12's wsl `shellName`): for a
/// WSL UNC cwd the distro named in the path (pure — no spawn); otherwise the
/// DEFAULT distro's name from its FR-3 root. `None` if the root could not be
/// discovered (caller falls back to the literal `"wsl"` per spec §7).
pub fn wsl_distro_name(cwd: &str) -> Option<String> {
    if let Some((distro, _)) = wsl_unc_to_linux(cwd) {
        return Some(distro);
    }
    wsl_unc_to_linux(&wsl_unc_root(None)?).map(|(distro, _)| distro)
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
        assert_eq!(
            wsl_unc_to_linux("\\\\wsl$\\Ubuntu"),
            Some(("Ubuntu".to_string(), "/".to_string()))
        );
        assert_eq!(
            wsl_unc_to_linux("\\\\wsl$\\Ubuntu\\"),
            Some(("Ubuntu".to_string(), "/".to_string()))
        );
    }

    #[test]
    fn wsl_unc_to_linux_tolerates_trailing_separators_and_forward_slashes() {
        assert_eq!(
            wsl_unc_to_linux("//wsl$/Ubuntu/home/u/"),
            Some(("Ubuntu".to_string(), "/home/u".to_string()))
        );
    }

    #[test]
    fn wsl_unc_to_linux_returns_none_for_non_wsl_paths() {
        assert_eq!(wsl_unc_to_linux("D:\\francois"), None);
        assert_eq!(wsl_unc_to_linux("\\\\server\\share"), None);
        assert_eq!(wsl_unc_to_linux("/mnt/c/repo"), None);
    }

    // ---- wsl_base_args (multi-distro remediation) ----

    #[test]
    fn wsl_base_args_targets_the_distro_named_in_a_unc_cwd() {
        // Bare wsl.exe hits the DEFAULT distro — for a UNC cwd the distro is in
        // the path and MUST be passed via -d, or a machine whose default distro
        // is docker-desktop (or any other distro) chdirs into nowhere.
        assert_eq!(
            wsl_base_args("\\\\wsl$\\Ubuntu\\home\\u\\api"),
            vec!["-d", "Ubuntu", "--cd", "/home/u/api"]
        );
        assert_eq!(
            wsl_base_args("\\\\wsl.localhost\\Debian\\srv\\x"),
            vec!["-d", "Debian", "--cd", "/srv/x"]
        );
    }

    #[test]
    fn wsl_base_args_passes_non_unc_cwds_verbatim_to_the_default_distro() {
        // Drive path: wsl.exe maps it to /mnt/… itself (confirmed live); no -d —
        // there is no distro information, the default is the only sane target.
        assert_eq!(wsl_base_args("D:\\acme-api"), vec!["--cd", "D:\\acme-api"]);
    }

    // ---- decode_wsl_output ----

    #[test]
    fn decode_wsl_output_reads_utf8_and_utf16le() {
        assert_eq!(decode_wsl_output(b"fatal: not a git repository\n"), "fatal: not a git repository");
        // wsl.exe's own errors are UTF-16LE (the `wsl -l -q` trap): every char
        // interleaved with a NUL under a UTF-8 read.
        let utf16: Vec<u8> = "\u{feff}There is no distribution with the supplied name.\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(
            decode_wsl_output(&utf16),
            "There is no distribution with the supplied name."
        );
        assert_eq!(decode_wsl_output(b""), "");
    }

    // ---- FR-3 helpers (root discovery itself is impure — not spawned in tests) ----

    #[test]
    fn join_unc_root_strips_leading_slash_and_flips_separators() {
        assert_eq!(
            join_unc_root("\\\\wsl.localhost\\Ubuntu\\", "/home/u/api"),
            "\\\\wsl.localhost\\Ubuntu\\home\\u\\api"
        );
        assert_eq!(
            join_unc_root("\\\\wsl.localhost\\Ubuntu\\", "/"),
            "\\\\wsl.localhost\\Ubuntu\\"
        );
    }

    #[test]
    fn distro_name_extraction_matches_the_live_root_shape() {
        // wsl_distro_name() itself needs a live wsl_unc_root() (not spawned in
        // tests); its distro-extraction step is exactly wsl_unc_to_linux applied to
        // the root string — exercised directly here against the exact shape
        // `wsl.exe -- wslpath -w /` returns (confirmed live on a dev machine:
        // `\\wsl.localhost\Debian\`).
        assert_eq!(
            wsl_unc_to_linux("\\\\wsl.localhost\\Debian\\").map(|(d, _)| d),
            Some("Debian".to_string())
        );
    }
}
