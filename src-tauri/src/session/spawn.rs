//! process-spawn plumbing shared by every turn/probe/create-time spawn: the
//! session-config validators, the claude argv/runtime wrapper, and the PATH /
//! window-flag helpers a spawned `claude` (or `wsl.exe`) child needs.
//!
//! `no_window` itself is NOT redefined here — session/mod.rs used to carry its
//! own copy (a third one, alongside wsl.rs's and diff/git.rs's), now deleted in
//! favor of the single `crate::process_util` copy. It is merely re-exported so
//! every existing `crate::session::no_window` caller — including usage.rs,
//! which this refactor does not own — keeps resolving unchanged.
//!
//! `spawn_claude` itself stays in turn.rs: it is turn-shaped (stdin/stdout
//! wiring, the NDJSON user line) rather than argv/env plumbing.

#[cfg(not(windows))]
use std::process::Command;

pub(crate) use crate::process_util::no_window;

pub(crate) fn valid_effort(e: &str) -> bool {
    matches!(e, "low" | "medium" | "high" | "xhigh" | "max")
}

/// contract/common.ts PermissionMode. The CLI's `auto`/`dontAsk` are deliberately
/// excluded (auto aborts headless -p runs on classifier blocks; dontAsk needs a
/// paired allowedTools list).
pub(crate) fn valid_permission_mode(m: &str) -> bool {
    matches!(m, "default" | "plan" | "acceptEdits" | "bypassPermissions")
}

/// contract/common.ts ClaudeRuntime. 'wsl' is only accepted on Windows (create-time check).
pub(crate) fn valid_runtime(r: &str) -> bool {
    matches!(r, "native" | "wsl")
}

/// `--permission-mode` args for a turn. 'default' adds NOTHING — the turn inherits
/// the user's ~/.claude settings (permissions.defaultMode / allow rules), exactly
/// the pre-feature behavior. The flag does not persist across --resume, so every
/// invocation passes it explicitly.
pub(crate) fn permission_args(mode: &str) -> Vec<String> {
    match mode {
        "plan" | "acceptEdits" | "bypassPermissions" => {
            vec!["--permission-mode".into(), mode.into()]
        }
        _ => Vec::new(),
    }
}

/// (program, argv) launching `claude <claude_args>` under a session's runtime.
/// wsl: `wsl.exe [-d <distro>] --cd <dir> -- claude …` via `wsl_base_args` — a
/// WSL UNC cwd targets the distro named in the path (bare wsl.exe hits the
/// DEFAULT distro, wrong on multi-distro machines) with its pre-translated Linux
/// path (`--cd '\\wsl.localhost\…'` fails with Wsl/E_INVALIDARG — verified
/// live); a drive-letter cwd passes verbatim (wsl.exe maps it to /mnt/… itself).
/// native: plain `claude …`; the caller sets current_dir.
pub(crate) fn claude_invocation(
    runtime: &str,
    cwd: &str,
    claude_args: Vec<String>,
) -> (String, Vec<String>) {
    if runtime == "wsl" {
        let mut argv = crate::wsl::wsl_base_args(cwd);
        argv.push("--".to_string());
        argv.push("claude".to_string());
        argv.extend(claude_args);
        ("wsl.exe".into(), argv)
    } else {
        ("claude".into(), claude_args)
    }
}

/// A GUI app launched from Finder/Dock/Spotlight (not a terminal) inherits
/// launchd's minimal default PATH, not the interactive shell's — so a `claude`
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

/// The PATH to spawn `claude` with: the login shell's PATH (memoized, resolved
/// at most once per run) prefixed onto the process's own, so directories only
/// a shell rc file adds are searched too. `None` when unresolvable — callers
/// then leave the spawn's PATH untouched.
pub(crate) fn claude_path_env() -> Option<String> {
    let shell_path = SHELL_PATH.get_or_init(login_shell_path).as_ref()?;
    let current = std::env::var("PATH").unwrap_or_default();
    Some(if current.is_empty() {
        shell_path.clone()
    } else {
        format!("{shell_path}:{current}")
    })
}

/// wsl.exe children need `TERM` forwarded across the distro boundary explicitly:
/// setting it on this (Windows-side) process's own env does not cross wsl.exe's
/// boundary; `WSLENV` with the `/u` flag does. Append (':'-joined) to any existing
/// `WSLENV` list rather than overwrite it — the inherited environment may already
/// carry one. Shared by shell-terminal's `shell_ensure` (main.rs) and
/// remote-control's PTY host (remote.rs) — for the wsl runtime, remote-control's
/// PTY stream is the feature's ONLY url source (spec §7 #7), so a missing `TERM`
/// there breaks it outright, not just cosmetically.
pub(crate) fn wsl_term_env() -> String {
    let wslenv = std::env::var("WSLENV").ok().filter(|v| !v.is_empty());
    match wslenv {
        // Already forwarded (any flag variant counts) → leave the list untouched;
        // otherwise trim a trailing ':' so we never emit an empty entry.
        Some(existing)
            if existing
                .split(':')
                .any(|e| e == "TERM/u" || e.starts_with("TERM/")) =>
        {
            existing
        }
        Some(existing) => format!("{}:TERM/u", existing.trim_end_matches(':')),
        None => "TERM/u".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_args_only_for_explicit_modes() {
        assert!(permission_args("default").is_empty()); // inherit ~/.claude settings — no flag
        assert!(permission_args("garbage").is_empty());
        assert_eq!(permission_args("plan"), vec!["--permission-mode", "plan"]);
        assert_eq!(
            permission_args("acceptEdits"),
            vec!["--permission-mode", "acceptEdits"]
        );
        assert_eq!(
            permission_args("bypassPermissions"),
            vec!["--permission-mode", "bypassPermissions"]
        );
    }

    #[test]
    fn claude_invocation_wraps_wsl() {
        let (prog, args) = claude_invocation("native", "D:\\repo", vec!["-p".into(), "hi".into()]);
        assert_eq!(prog, "claude");
        assert_eq!(args, vec!["-p", "hi"]);
        // wsl + drive cwd: wsl.exe maps it to /mnt/… itself — passed verbatim,
        // no -d (no distro info → default distro is the only sane target)
        let (prog, args) = claude_invocation("wsl", "D:\\repo", vec!["--version".into()]);
        assert_eq!(prog, "wsl.exe");
        assert_eq!(args, vec!["--cd", "D:\\repo", "--", "claude", "--version"]);
        // wsl + WSL UNC cwd: MUST pre-translate (`--cd \\wsl…` = Wsl/E_INVALIDARG
        // live) AND target the distro named in the path — bare wsl.exe hits the
        // default distro, which need not be the one holding the repo.
        let (prog, args) = claude_invocation(
            "wsl",
            "\\\\wsl.localhost\\Ubuntu\\home\\u\\api",
            vec!["-p".into(), "hi".into()],
        );
        assert_eq!(prog, "wsl.exe");
        assert_eq!(
            args,
            vec![
                "-d",
                "Ubuntu",
                "--cd",
                "/home/u/api",
                "--",
                "claude",
                "-p",
                "hi"
            ]
        );
    }
}
