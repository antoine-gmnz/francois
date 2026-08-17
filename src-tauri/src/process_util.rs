// Shared process-spawn helpers. `no_window` was duplicated verbatim in wsl.rs,
// diff/git.rs, and session/mod.rs — this is the single copy those first two now
// import (session/mod.rs keeps its own for now; see the refactor follow-up note).

use std::path::Path;
use std::process::Command;

#[cfg(windows)]
pub(crate) fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash
}
#[cfg(not(windows))]
pub(crate) fn no_window(_cmd: &mut Command) {}

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

    #[test]
    fn drops_empty_and_relative_entries_keeping_order() {
        assert_eq!(
            filter_absolute_path_entries(":/abs:.:node_modules/.bin:/other"),
            Some("/abs:/other".to_string())
        );
    }

    #[test]
    fn an_all_relative_input_yields_no_override() {
        assert_eq!(filter_absolute_path_entries(".:node_modules/.bin:"), None);
    }

    #[test]
    fn a_single_absolute_entry_survives() {
        assert_eq!(
            filter_absolute_path_entries("/usr/bin"),
            Some("/usr/bin".to_string())
        );
    }
}
