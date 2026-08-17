// Shared process-spawn helpers. `no_window` was duplicated verbatim in wsl.rs,
// diff/git.rs, and session/mod.rs — this is the single copy those first two now
// import (session/mod.rs keeps its own for now; see the refactor follow-up note).

use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
pub(crate) fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash
}
#[cfg(not(windows))]
pub(crate) fn no_window(_cmd: &mut Command) {}

/// The executable `bin` resolves to on PATH, or `None` when it is not installed.
///
/// **Not how a spawn finds its program** — `Command::new("claude")` already does
/// a PATH lookup. This exists for the two questions a spawn cannot answer:
///
///  1. *Is this CLI installed at all?* There is no process to run and no exit
///     code to read; the only honest answer is a file on PATH. `Command` can
///     only tell you by failing, which costs a spawn per probe and cannot
///     distinguish "missing" from "present but broken".
///  2. *Which file is it on Windows?* An npm-installed CLI is a `.cmd` shim, and
///     `CreateProcessW` appends `.exe` only — see `codex_program`'s note, where
///     that difference made an installed `codex` report as missing.
///
/// PATH is taken from `claude_path_env()` when it resolves, so a macOS app
/// launched from Finder searches the login shell's PATH rather than launchd's
/// minimal one — otherwise every CLI installed by a shell-configured npm prefix
/// would read as "not installed" in exactly the GUI case this app ships as.
pub(crate) fn resolve_program(bin: &str) -> Option<PathBuf> {
    let path = crate::session::claude_path_env()
        .map(std::ffi::OsString::from)
        .or_else(|| std::env::var_os("PATH"))?;
    std::env::split_paths(&path).find_map(|dir| {
        program_candidates(&dir, bin)
            .into_iter()
            .find(|c| is_executable(c))
    })
}

/// `.exe` first — a native install beats a shim and skips a `cmd.exe` hop.
/// `.ps1` is deliberately absent: it is not directly executable.
#[cfg(windows)]
fn program_candidates(dir: &Path, bin: &str) -> Vec<PathBuf> {
    ["exe", "cmd", "bat"]
        .iter()
        .map(|ext| dir.join(format!("{bin}.{ext}")))
        .collect()
}
#[cfg(not(windows))]
fn program_candidates(dir: &Path, bin: &str) -> Vec<PathBuf> {
    vec![dir.join(bin)]
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}
/// The executable bit matters here, not just existence: `~/.local/bin/claude`
/// left non-executable by a half-finished install is not an install, and
/// reporting it as one would offer a "sign in" that can only fail.
#[cfg(not(windows))]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The negative case is the one worth pinning: a name no PATH entry can
    /// hold must resolve to `None` rather than to a bare-name fallback, because
    /// the whole point of the helper is answering "installed?" without a spawn.
    #[test]
    fn an_impossible_name_resolves_to_nothing() {
        assert_eq!(resolve_program("francois-no-such-binary-9f3a2b"), None);
    }

    /// And the positive case against a binary every supported platform ships,
    /// so the candidate list and the executable-bit check are both exercised on
    /// whichever OS is running the suite.
    #[test]
    fn a_binary_every_platform_ships_resolves_to_a_real_file() {
        let bin = if cfg!(windows) { "cmd" } else { "sh" };
        let resolved = resolve_program(bin).expect("every platform has this on PATH");
        assert!(
            resolved.is_file(),
            "resolved to something that exists: {}",
            resolved.display()
        );
    }
}
