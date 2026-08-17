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
/// PATH is taken from `login_shell_path_env()` when it resolves, so a macOS app
/// launched from Finder searches the login shell's PATH rather than launchd's
/// minimal one — otherwise every CLI installed by a shell-configured npm prefix
/// would read as "not installed" in exactly the GUI case this app ships as.
pub(crate) fn resolve_program(bin: &str) -> Option<PathBuf> {
    let path = login_shell_path_env()
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

// ---------- ext-path-resolution FR-1: the login-shell PATH resolver ----------
//
// Moved verbatim from `session::spawn::claude_path_env` (was `claude`-specific
// in name and doc only — the mechanism was always generic) so extension
// provider spawns can share it with the eight `claude` spawn sites instead of
// re-implementing PATH resolution on their own.

/// A GUI app launched from Finder/Dock/Spotlight (not a terminal) inherits
/// launchd's minimal default PATH, not the interactive shell's — so a binary
/// installed via nvm/homebrew/~/.local/bin/etc. is invisible to `Command::new`
/// even though it runs fine from a terminal. Ask the user's login shell for
/// its PATH once and merge it in ahead of every spawn. Markers rather than a
/// plain `echo $PATH` because an interactive shell (`-i`, needed since many
/// PATH exports live in .zshrc/.bashrc, not the non-interactive .zprofile)
/// may print MOTD/nvm-banner noise before its output.
#[cfg(not(windows))]
fn login_shell_path() -> Option<String> {
    const START: &str = "__francois_path_start__";
    const END: &str = "__francois_path_end__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = Command::new(shell)
        // `${PATH}` (not `$PATH`), so the shell doesn't read the marker's trailing
        // text as part of the variable name and expand it to nothing.
        .args(["-ilc", &format!("echo -n {START}${{PATH}}{END}")])
        .output()
        .ok()?;
    let text = String::from_utf8(out.stdout).ok()?;
    let start = text.find(START)? + START.len();
    let end = text[start..].find(END)? + start;
    let path = text[start..end].trim();
    (!path.is_empty()).then(|| path.to_string())
}
#[cfg(windows)]
fn login_shell_path() -> Option<String> {
    None // Windows GUI apps inherit the full user PATH from explorer.exe already.
}

static SHELL_PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// The PATH to spawn a child with: the login shell's PATH (memoized, resolved
/// at most once per run) prefixed onto the process's own, so directories only
/// a shell rc file adds are searched too. `None` when unresolvable — callers
/// then leave the spawn's PATH untouched.
pub(crate) fn login_shell_path_env() -> Option<String> {
    let shell_path = SHELL_PATH.get_or_init(login_shell_path).as_ref()?;
    let current = std::env::var("PATH").unwrap_or_default();
    Some(if current.is_empty() {
        shell_path.clone()
    } else {
        format!("{shell_path}:{current}")
    })
}

/// FR-5: drop every `':'`-separated entry that is empty or not absolute,
/// keeping the remaining entries' original order. A repo-controlled `cwd`
/// (e.g. a hostile clone with `./cohorte` or `node_modules/.bin/cohorte` and a
/// login-shell PATH containing `.` or a relative entry) must never make a
/// bare `argv0` resolve inside the open repo. Returns `None` when filtering
/// leaves nothing, so the caller can fall back to the unfiltered PATH.
pub(crate) fn filter_absolute_path_entries(path: &str) -> Option<String> {
    let filtered = path
        .split(':')
        .filter(|entry| !entry.is_empty() && Path::new(entry).is_absolute())
        .collect::<Vec<_>>()
        .join(":");
    (!filtered.is_empty()).then_some(filtered)
}

#[cfg(test)]
mod path_filter_tests {
    use super::*;

    // POSIX fixtures: `/abs`-style entries are only absolute per `Path::is_absolute()`
    // on unix — on Windows the same string has no drive/prefix and is relative, so
    // these fixtures would assert something false there. Gated `#[cfg(unix)]`, with
    // a drive-letter counterpart below covering the same behaviour on Windows.
    #[cfg(unix)]
    #[test]
    fn drops_empty_and_relative_entries_keeping_order() {
        assert_eq!(
            filter_absolute_path_entries(":/abs:.:node_modules/.bin:/other"),
            Some("/abs:/other".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_single_absolute_entry_survives() {
        assert_eq!(
            filter_absolute_path_entries("/usr/bin"),
            Some("/usr/bin".to_string())
        );
    }

    // The function splits on `':'` unconditionally (it only ever sees real data
    // from `login_shell_path_env`, which is unix-only — Windows's `login_shell_path`
    // is `None` by design, see spec §2 non-goals). A drive-letter fixture like
    // `C:\abs` would misparse here since the drive's own `:` collides with the
    // splitter, so these Windows fixtures use UNC paths (`\\server\share\...`),
    // which `Path::is_absolute()` also accepts on Windows and contain no `:`.
    #[cfg(windows)]
    #[test]
    fn drops_empty_and_relative_entries_keeping_order() {
        assert_eq!(
            filter_absolute_path_entries(r":\\server\abs:.:node_modules\.bin:\\server\other"),
            Some(r"\\server\abs:\\server\other".to_string())
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_single_absolute_entry_survives() {
        assert_eq!(
            filter_absolute_path_entries(r"\\server\share"),
            Some(r"\\server\share".to_string())
        );
    }

    // `.` and `node_modules/.bin` are relative on every platform — no `#[cfg]` split
    // needed.
    #[test]
    fn an_all_relative_input_yields_no_override() {
        assert_eq!(filter_absolute_path_entries(".:node_modules/.bin:"), None);
    }
}
