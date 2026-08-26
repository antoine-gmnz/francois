// Shared process-spawn helpers, and — since core-architecture-wave3 FR-7 — the
// spawn FACADE every child process in this app is started through. `no_window`
// used to be duplicated verbatim in wsl.rs, diff/git.rs and session/mod.rs;
// this is the single copy all three now reach (session/mod.rs's went with the
// FR-7 migration, and `session::spawn` merely re-exports this one).
//
// The facade exists because the four spawn concerns below were applied BY
// CONVENTION at 55 call sites, and ext-path-resolution already proved that a
// convention loses: the sites that forgot the login-shell PATH were invisible
// until a user on nvm reported that a tool call could not find its own binary.
// `scripts/quality/conventions.mjs` (FR-8) now fails the build on a bare
// `Command::new` anywhere outside this file.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};

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
pub fn resolve_program(bin: &str) -> Option<PathBuf> {
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

// ---------- core-architecture-wave3 FR-9: the vendor-CLI program resolvers ----------
//
// `codex_program` / `grok_program` used to live in their session adapters, which
// meant `account/codex.rs` said `crate::session::codex_program()` to answer
// "which file do I spawn to sign in?" — a question about a file on PATH, asked
// of the session engine. Both were already thin wrappers over
// `resolve_program` above; they live beside it now, and their adapters
// re-export them, so nothing that calls them changed.

/// `codex`'s executable base name, before any platform-specific extension.
pub const CODEX_BIN: &str = "codex";

/// `grok`'s, same.
pub const GROK_BIN: &str = "grok";

/// The program string to actually spawn for `codex` (multi-provider-codex §7).
///
/// **Why this is not just `CODEX_BIN`.** `claude` installs as a real native
/// binary, so a bare name finds it on any platform. `codex` is normally
/// installed by npm, which on Windows ships **shims, not an exe**: `codex` (sh),
/// `codex.cmd`, `codex.ps1`. Rust resolves a bare name on Windows by appending
/// `.exe` ONLY — so spawning `codex` fails with `NotFound` even though
/// `codex --version` works in every terminal, and the user gets told to install
/// something that is already installed.
///
/// Verified on this platform: bare `codex` → `NotFound`; `codex.cmd` → runs.
/// Rust executes `.cmd`/`.bat` targets fine once the extension is explicit (it
/// applies its own batch-argument escaping, the CVE-2024-24576 fix), so naming
/// the extension is the whole fix.
///
/// Returns a full path when one is found — unambiguous, and it cannot be
/// re-resolved differently between the login spawn and the turn spawn. Falls
/// back to the bare name so a genuinely missing CLI still produces `NotFound`
/// and the "install it" message that is then correct.
pub fn codex_program() -> String {
    static RESOLVED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    RESOLVED
        .get_or_init(|| resolve_cli_program(CODEX_BIN))
        .clone()
}

/// The same, for `grok` — `npm i -g @xai-official/grok` ships `grok.cmd` on
/// Windows and hits the identical trap.
pub fn grok_program() -> String {
    static RESOLVED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    RESOLVED
        .get_or_init(|| resolve_cli_program(GROK_BIN))
        .clone()
}

/// One implementation for both, which is what moving them here bought: the
/// second one used to be a copy of the first with the constant swapped.
fn resolve_cli_program(bin: &str) -> String {
    // Non-Windows installs are a real binary (or a shebang script, which
    // `execvp` handles); the bare name is correct and PATH does the work.
    if !cfg!(windows) {
        return bin.to_string();
    }
    resolve_program(bin)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| bin.to_string())
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
pub fn filter_absolute_path_entries(path: &str) -> Option<String> {
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

// ---------- core-architecture-wave3 FR-7: the spawn facade ----------
//
// Four concerns apply to every child this app starts, and each one used to be
// remembered (or not) per call site:
//
//  1. **PATH resolution.** A GUI app inherits launchd's minimal PATH on macOS,
//     so a bare `argv0` installed by nvm/Homebrew/pnpm/cargo is invisible to
//     `Command::new` even though it runs in every terminal.
//  2. **Window suppression.** On Windows a console child flashes a black box
//     over the app unless `CREATE_NO_WINDOW` is set.
//  3. **Environment.** A child either inherits this process's environment or is
//     scrubbed to an allowlist; there is no third answer, and which one applies
//     must be a decision at the call site rather than an omission.
//  4. **Stdio.** Nothing may inherit the app's stdin: a CLI that mis-parses a
//     flag and drops into a TUI would otherwise sit forever on a terminal that
//     does not exist.
//
// `spawn()` applies the safe answer to all four by construction; the builder's
// methods are how a site *names* a different one. There is no way to obtain a
// `Command` from this module with the defaults un-applied, which is the whole
// point — `into_command()` hands back one that has already been through them.

/// The allowlist a scrubbed child keeps. Everything else — API keys, tokens,
/// `ANTHROPIC_*`, the user's whole shell environment — is dropped, so a
/// third-party binary this app spawns on the user's behalf cannot read a
/// credential out of its own environment. `PATH` is a member, so overriding it
/// with the login shell's is a value change rather than a widening.
pub const ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "TMPDIR",
    "SystemRoot",
    "windir",
    "PATHEXT",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
];

/// The pure half of the scrub: keep only `ENV_ALLOWLIST` members, in order.
pub fn scrub_env<I: IntoIterator<Item = (String, String)>>(vars: I) -> Vec<(String, String)> {
    vars.into_iter()
        .filter(|(k, _)| ENV_ALLOWLIST.contains(&k.as_str()))
        .collect()
}

/// A `Command` with the four spawn concerns already applied. Build it with
/// [`spawn`]; every method mirrors the `Command` method of the same name, so a
/// migrated call site reads exactly as it did before.
pub struct CommandBuilder {
    cmd: Command,
    /// Whether the call site named its own stdout/stderr. `Command::output()`
    /// only pipes a stream the caller left UNSET — an explicit `Stdio::null()`
    /// wins over it, so a facade that defaulted both to null would silently
    /// hand every `.output()` site an empty `stdout`. These two flags are how
    /// [`CommandBuilder::output`] restores std's own default in that case,
    /// while `start()`/`status()` keep the null default they want.
    stdout_set: bool,
    stderr_set: bool,
}

/// Start `program` with all four concerns applied:
///
///  * `PATH` set to [`login_shell_path_env`] when it resolves (untouched when
///    it does not — an unresolvable login shell must not blank a child's PATH),
///  * `CREATE_NO_WINDOW` on Windows,
///  * this process's environment inherited (call [`CommandBuilder::scrubbed_env`]
///    for the allowlist instead),
///  * stdin, stdout and stderr all null (call the matching method to pipe one;
///    `output()` pipes the two it needs, exactly as `Command::output` does).
pub fn spawn(program: impl AsRef<OsStr>) -> CommandBuilder {
    let mut cmd = Command::new(program);
    if let Some(path) = login_shell_path_env() {
        cmd.env("PATH", path);
    }
    no_window(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    CommandBuilder {
        cmd,
        stdout_set: false,
        stderr_set: false,
    }
}

impl CommandBuilder {
    pub fn arg(mut self, arg: impl AsRef<OsStr>) -> Self {
        self.cmd.arg(arg);
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.cmd.args(args);
        self
    }

    pub fn current_dir(mut self, dir: impl AsRef<Path>) -> Self {
        self.cmd.current_dir(dir);
        self
    }

    pub fn env(mut self, key: impl AsRef<OsStr>, val: impl AsRef<OsStr>) -> Self {
        self.cmd.env(key, val);
        self
    }

    pub fn envs<I, K, V>(mut self, vars: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.cmd.envs(vars);
        self
    }

    pub fn stdin(mut self, cfg: Stdio) -> Self {
        self.cmd.stdin(cfg);
        self
    }

    pub fn stdout(mut self, cfg: Stdio) -> Self {
        self.cmd.stdout(cfg);
        self.stdout_set = true;
        self
    }

    pub fn stderr(mut self, cfg: Stdio) -> Self {
        self.cmd.stderr(cfg);
        self.stderr_set = true;
        self
    }

    /// Concern 3, the other answer: drop the inherited environment and keep
    /// only [`ENV_ALLOWLIST`]. `path_override` replaces the scrubbed `PATH`
    /// (pass the output of [`filter_absolute_path_entries`] — a repo-controlled
    /// `cwd` must never make a bare `argv0` resolve inside the open repo);
    /// `None` keeps whatever `PATH` survived the scrub.
    ///
    /// This is the ONLY `env_clear()` in the tree. Everything a scrubbed child
    /// needs beyond the allowlist has to be named with [`Self::env`] *after*
    /// this call, which is what makes the widening visible in review.
    pub fn scrubbed_env(mut self, path_override: Option<&str>) -> Self {
        self.cmd.env_clear();
        for (k, v) in scrub_env(std::env::vars()) {
            self.cmd.env(k, v);
        }
        if let Some(path) = path_override {
            self.cmd.env("PATH", path);
        }
        self
    }

    /// The escape hatch for a platform concern this facade does not own —
    /// `pre_exec`, `creation_flags`, a process group. Deliberately a closure
    /// over `&mut Command` rather than a `DerefMut`: a site that needs one of
    /// these is naming it, and the four defaults are already applied.
    pub fn configure(mut self, f: impl FnOnce(&mut Command)) -> Self {
        f(&mut self.cmd);
        self
    }

    /// Run to completion and collect the output. A stream the call site did not
    /// name is piped here — `Output` with a null `stdout` is never what a caller
    /// of this method means, and `Command::output()` cannot make that choice
    /// itself once a default has been set on it.
    pub fn output(mut self) -> std::io::Result<Output> {
        if !self.stdout_set {
            self.cmd.stdout(Stdio::piped());
        }
        if !self.stderr_set {
            self.cmd.stderr(Stdio::piped());
        }
        self.cmd.output()
    }

    pub fn status(mut self) -> std::io::Result<std::process::ExitStatus> {
        self.cmd.status()
    }

    pub fn start(mut self) -> std::io::Result<Child> {
        self.cmd.spawn()
    }
}

#[cfg(test)]
mod facade_tests {
    use super::*;

    /// The scrub is the security-relevant half: a secret in this process's
    /// environment must not reach a child spawned on the user's behalf.
    #[test]
    fn scrubbing_keeps_the_allowlist_and_drops_everything_else() {
        let kept = scrub_env([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "sk-leak".to_string()),
            ("HOME".to_string(), "/home/u".to_string()),
        ]);
        assert_eq!(
            kept,
            vec![
                ("PATH".to_string(), "/usr/bin".to_string()),
                ("HOME".to_string(), "/home/u".to_string()),
            ]
        );
    }

    /// Concern 4 by construction: a child that names no stdio still cannot read
    /// the app's stdin. Proven by running one — a `Command` exposes none of its
    /// configuration for inspection, so behaviour is the only observable. With
    /// an inherited (or piped, never written) stdin this blocks forever, which
    /// is the bug the default exists to make impossible.
    #[test]
    fn a_default_spawn_gets_no_stdin() {
        let (program, args): (&str, Vec<&str>) = if cfg!(windows) {
            ("cmd", vec!["/C", "more"])
        } else {
            ("/bin/sh", vec!["-c", "read line"])
        };
        assert!(spawn(program).args(args).status().is_ok());
    }

    /// And the environment default is the other one: an inherited variable
    /// reaches an unscrubbed child, so migrating a site to the facade cannot
    /// silently starve it of the environment it had.
    #[test]
    fn an_unscrubbed_child_still_inherits_the_environment() {
        std::env::set_var("FRANCOIS_FACADE_TEST_VAR", "inherited");
        let (program, args): (&str, Vec<&str>) = if cfg!(windows) {
            ("cmd", vec!["/C", "echo %FRANCOIS_FACADE_TEST_VAR%"])
        } else {
            (
                "/bin/sh",
                vec!["-c", "printf %s \"$FRANCOIS_FACADE_TEST_VAR\""],
            )
        };
        let out = spawn(program).args(args).output();
        std::env::remove_var("FRANCOIS_FACADE_TEST_VAR");
        let out = out.expect("the probe ran");
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        assert!(stdout.contains("inherited"), "stdout: {stdout:?}");
    }

    /// ext-path-resolution FR-4, raised to the whole crate by FR-7: the scrub
    /// is a security boundary, and a second implementation of it is how such a
    /// boundary drifts. `scrubbed_env` is the only `env_clear()` in the tree, so
    /// there is exactly one answer to "what can a child this app spawns read?".
    ///
    /// Asserted per FILE rather than per line: this file may name `env_clear()`
    /// as often as it likes (here, in the doc comments, in a future test), and
    /// what matters is that no OTHER file does. Source-scanning rather than
    /// type-enforced because `Command::env_clear` is std's, callable from
    /// anywhere; the FR-8 conventions rule catches the same class from the other
    /// side by refusing a bare `Command::new`.
    #[test]
    fn the_facade_holds_the_only_env_clear_in_the_crate() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files: Vec<String> = Vec::new();
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("the source tree must be readable") {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                if std::fs::read_to_string(&path)
                    .unwrap()
                    .contains("env_clear()")
                {
                    files.push(path.display().to_string());
                }
            }
        }
        assert_eq!(
            files.len(),
            1,
            "env_clear() may only appear in the facade's own file: {files:?}"
        );
        assert!(files[0].ends_with("process_util.rs"), "{files:?}");
    }

    #[test]
    fn a_scrubbed_child_does_not_see_a_secret() {
        std::env::set_var("FRANCOIS_FACADE_TEST_SECRET", "leak-me-not");
        let (program, args): (&str, Vec<&str>) = if cfg!(windows) {
            ("cmd", vec!["/C", "set"])
        } else {
            ("/usr/bin/env", vec![])
        };
        let out = spawn(program).args(args).scrubbed_env(None).output();
        std::env::remove_var("FRANCOIS_FACADE_TEST_SECRET");
        if let Ok(out) = out {
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            assert!(!text.contains("FRANCOIS_FACADE_TEST_SECRET"), "{text}");
        }
    }
}
