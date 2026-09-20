//! pi-runtime-distribution FR-1/FR-2/FR-8: how a candidate Pi binary is
//! actually reached and read — the bounded spawn, native vs. WSL resolution,
//! and turning raw `--version` output into a version string. Split out of
//! `discovery.rs` (CLAUDE.md's ~1000-line file cap) as its own concern:
//! `discovery.rs` decides what a resolved version MEANS (the manifest
//! allowlist, the wire shape); this module only decides how to GET one.

use crate::process_util::BoundedRun;
use std::ffi::OsStr;
use std::time::Duration;

const PI_BIN: &str = "pi";
const NODE_BIN: &str = "node";
/// FR-2: the version probe's deadline.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// FR-2: the version probe's output cap.
const OUTPUT_CAP: usize = 64 * 1024;

// ---------------------------------------------------------------- bounded spawn
//
// The bounded-spawn + concurrent pipe-drain machinery itself lives in
// `process_util::CommandBuilder::run_bounded` — shared with
// `account/cli_tools.rs::probe_version`, which has the same "bounded
// `--version` probe" shape. This module only wires the FR-2 deadline/cap into
// it.

fn run_bounded(program: impl AsRef<OsStr>, args: &[&str], env: ProbeEnv<'_>) -> BoundedRun {
    run_bounded_with(program, args, PROBE_TIMEOUT, env)
}

/// The environment a probe spawn runs under (PR #142 §5). `None` is the
/// ambient one — what `francois:runtime:installation` has always used, since
/// it nominates no account and only reads a version banner. `Some` is an
/// ACCOUNT's environment (`account::pi_account_env`), applied with
/// `exact_env` exactly as a real Pi session's spawn applies it, so a probe run
/// on an account's behalf resolves the same directory its sessions will.
pub(crate) type ProbeEnv<'a> = Option<&'a [(String, String)]>;

/// Timeout injected as a parameter — same reason `process_util`'s
/// `login_shell_path_with` splits the deadline out of `login_shell_path`: a
/// test proving the FR-2 deadline is enforced must not actually wait 5s.
fn run_bounded_with(
    program: impl AsRef<OsStr>,
    args: &[&str],
    timeout: Duration,
    env: ProbeEnv<'_>,
) -> BoundedRun {
    let mut cmd = crate::process_util::spawn(program).args(args);
    if let Some(env) = env {
        cmd = cmd.exact_env(env.iter().cloned());
    }
    cmd.run_bounded(timeout, OUTPUT_CAP)
}

// ---------------------------------------------------------------- resolution

/// What a bounded probe spawn settled on, before any manifest comparison.
pub(crate) enum ResolutionOutcome {
    /// No binary resolved on PATH (native) or in the distro (wsl).
    Missing,
    /// The ENVIRONMENT itself could not be reached (WSL not installed) —
    /// distinct from "Pi is not installed in an otherwise-working WSL".
    Unavailable(String),
    /// Resolved, but the probe spawn itself failed to execute.
    SpawnFailed,
    TimedOut,
    Found {
        path: String,
        version_output: String,
    },
}

/// FR-1/FR-2: native resolution — `process_util::resolve_program` already
/// applies the login-shell PATH, filters relative/empty entries, and (on
/// Windows) returns the `.cmd`/`.exe` shim with its extension explicit, which
/// is what makes spawning it argv-safe with no shell interpolation (the same
/// reasoning `process_util::codex_program` documents).
pub(crate) fn probe_native(env: ProbeEnv<'_>) -> ResolutionOutcome {
    match crate::process_util::resolve_program(PI_BIN) {
        None => ResolutionOutcome::Missing,
        Some(path) => probe_binary_at(&path, env),
    }
}

/// The PATH-independent half of native resolution: spawn an ALREADY-RESOLVED
/// absolute path. Split out so it is unit-testable against a real temp
/// script/shim without mutating process-wide `PATH` (mirrors `probe_native`
/// calling `resolve_program` — that half is `process_util`'s own, already
/// tested there against spaces/Unicode/npm-shim fixtures).
fn probe_binary_at(path: &std::path::Path, env: ProbeEnv<'_>) -> ResolutionOutcome {
    let run = run_bounded(path, &["--version"], env);
    if run.timed_out {
        return ResolutionOutcome::TimedOut;
    }
    if run.spawn_failed {
        return ResolutionOutcome::SpawnFailed;
    }
    ResolutionOutcome::Found {
        path: path.to_string_lossy().into_owned(),
        version_output: preferred_text(&run),
    }
}

pub(crate) fn probe_node_at_native(env: ProbeEnv<'_>) -> Option<String> {
    let path = crate::process_util::resolve_program(NODE_BIN)?;
    let run = run_bounded(&path, &["--version"], env);
    (!run.timed_out && !run.spawn_failed).then(|| preferred_text(&run))
}

/// stdout when it said anything, stderr otherwise — a `--version` banner
/// occasionally lands on stderr (npm wrapper warnings ahead of it do too, but
/// those are exactly what `looks_like_version` is for).
fn preferred_text(run: &BoundedRun) -> String {
    let out = String::from_utf8_lossy(&run.stdout).into_owned();
    if out.trim().is_empty() {
        String::from_utf8_lossy(&run.stderr).into_owned()
    } else {
        out
    }
}

/// FR-1/FR-8: WSL resolution, targeting the EXPLICIT distro named in the
/// request — never the ambient default (spec: "no implicit cross-environment
/// fallback"). One spawn does both jobs (`command -v pi` then `pi --version`,
/// `&&`-chained) so the FR-2 deadline is paid once, not twice.
pub(crate) fn probe_wsl(distro: &str, env: ProbeEnv<'_>) -> ResolutionOutcome {
    let run = run_bounded(
        "wsl.exe",
        &[
            "-d",
            distro,
            "--",
            "sh",
            "-lc",
            "command -v pi && pi --version",
        ],
        env,
    );
    if run.spawn_failed {
        return ResolutionOutcome::Unavailable(
            "WSL is not available. Install it (wsl --install) or use the native runtime.".into(),
        );
    }
    if run.timed_out {
        return ResolutionOutcome::TimedOut;
    }
    let ok_exit = run.status.map(|s| s.success()).unwrap_or(false);
    let decoded = crate::wsl::decode_wsl_output(&run.stdout);
    let decoded = if decoded.trim().is_empty() {
        crate::wsl::decode_wsl_output(&run.stderr)
    } else {
        decoded
    };
    if !ok_exit {
        return ResolutionOutcome::Missing;
    }
    match parse_wsl_probe_output(&decoded) {
        None => ResolutionOutcome::Missing,
        Some((linux_path, version_output)) => {
            let path = crate::wsl::linux_to_wsl_unc(Some(distro), &linux_path)
                .unwrap_or_else(|| linux_path.clone());
            ResolutionOutcome::Found {
                path,
                version_output,
            }
        }
    }
}

/// Pure: split `command -v pi && pi --version`'s combined, already-decoded
/// output into (linux path, the rest verbatim). `None` when the first line is
/// blank — an empty `command -v` result the shell somehow still chained past.
fn parse_wsl_probe_output(decoded: &str) -> Option<(String, String)> {
    let mut lines = decoded.lines();
    let path = lines.next().map(str::trim).filter(|l| !l.is_empty())?;
    let rest = lines.collect::<Vec<_>>().join("\n");
    Some((path.to_string(), rest))
}

pub(crate) fn probe_node_wsl(distro: &str, env: ProbeEnv<'_>) -> Option<String> {
    let run = run_bounded("wsl.exe", &["-d", distro, "--", NODE_BIN, "--version"], env);
    if run.timed_out || run.spawn_failed || run.status.map(|s| !s.success()).unwrap_or(true) {
        return None;
    }
    let decoded = crate::wsl::decode_wsl_output(&run.stdout);
    (!decoded.trim().is_empty()).then_some(decoded)
}

// ---------------------------------------------------------------- version parsing

/// The first non-blank line, 'v'-stripped, bounded, and shaped like a version
/// (leading digit — after the strip — so a banner's usage/error text does not
/// masquerade as one). `None` is FR-7's "malformed version" case.
pub(crate) fn parse_version_line(output: &str) -> Option<String> {
    let line = output.lines().map(str::trim).find(|l| !l.is_empty())?;
    let stripped = line.strip_prefix('v').unwrap_or(line);
    looks_like_version(stripped).then(|| stripped.chars().take(80).collect())
}

fn looks_like_version(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 40
        && s.starts_with(|c: char| c.is_ascii_digit())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    // ---- parse_version_line / looks_like_version (FR-7 malformed case) ----

    #[test]
    fn a_version_line_is_the_first_nonblank_line_v_stripped() {
        assert_eq!(
            parse_version_line("\n\nv0.85.1\nextra\n").as_deref(),
            Some("0.85.1")
        );
        assert_eq!(parse_version_line("0.85.1").as_deref(), Some("0.85.1"));
    }

    #[test]
    fn banner_text_that_is_not_a_version_is_malformed() {
        assert_eq!(parse_version_line("Usage: pi [options]"), None);
        assert_eq!(parse_version_line(""), None);
        assert_eq!(parse_version_line("   \n  "), None);
    }

    // ---- parse_wsl_probe_output (FR-1/FR-8 WSL path fixtures) ----

    #[test]
    fn wsl_probe_output_splits_the_path_line_from_the_version_lines() {
        let decoded = "/home/u/.nvm/versions/node/v22.19.0/bin/pi\n0.85.1\n";
        let (path, version) = parse_wsl_probe_output(decoded).unwrap();
        assert_eq!(path, "/home/u/.nvm/versions/node/v22.19.0/bin/pi");
        assert_eq!(version, "0.85.1");
    }

    #[test]
    fn wsl_probe_output_with_a_blank_first_line_is_none() {
        assert!(parse_wsl_probe_output("\n0.85.1\n").is_none());
        assert!(parse_wsl_probe_output("").is_none());
    }

    // ---- run_bounded_with / probe_binary_at: real bounded spawns ----

    /// A directory whose name carries a space and a non-ASCII character — the
    /// FR-1 fixture class acceptance criterion #1 asks for ("spaces, Unicode").
    /// `resolve_program` itself already proves PATH lookup against such
    /// directories (process_util.rs); this proves THIS module's spawn/parse
    /// pipeline is equally untroubled once handed such a path directly. Built
    /// by hand (temp_dir + uuid), same as `process_util.rs`'s own PATH-timeout
    /// tests — no tempdir crate in this workspace.
    struct FakeScript {
        dir: std::path::PathBuf,
        path: std::path::PathBuf,
    }
    impl Drop for FakeScript {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    fn fake_script(contents_unix: &str, contents_windows_cmd: &str) -> FakeScript {
        let dir = std::env::temp_dir().join(format!(
            "francois-pi-discovery-\u{00e9}migr\u{00e9} space-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = if cfg!(windows) {
            let p = dir.join("pi.cmd");
            std::fs::write(&p, contents_windows_cmd).unwrap();
            p
        } else {
            let p = dir.join("pi");
            std::fs::write(&p, contents_unix).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            p
        };
        FakeScript { dir, path }
    }

    /// PR #142 §5: the probe must run in the ACCOUNT's environment, not this
    /// process's. Proven end to end against a real spawn: the fake binary
    /// prints what `PI_CODING_AGENT_DIR` holds, and it holds what was passed —
    /// not whatever the test runner inherited.
    #[test]
    fn a_probe_spawn_runs_in_the_environment_it_was_given() {
        let script = fake_script(
            "#!/bin/sh\necho \"$PI_CODING_AGENT_DIR\"\n",
            "@echo off\r\necho %PI_CODING_AGENT_DIR%\r\n",
        );
        let dir = std::env::temp_dir().join("francois-probe-env-fixture");
        // Over the REAL ambient snapshot (plus a stale directory to displace):
        // the OS baseline has to survive the FR-5 scrub for the child to start
        // at all on Windows, which is half of what this proves.
        let ambient: Vec<(String, String)> = std::env::vars()
            .chain([(
                "PI_CODING_AGENT_DIR".to_string(),
                "/ambient/other".to_string(),
            )])
            .collect();
        let env =
            crate::account::pi_account_env(&ambient, &dir.to_string_lossy(), false, "native", &[]);
        match probe_binary_at(&script.path, Some(&env)) {
            ResolutionOutcome::Found { version_output, .. } => assert_eq!(
                version_output.trim(),
                dir.to_string_lossy(),
                "the account's directory, never the ambient one"
            ),
            _ => panic!("expected Found"),
        }
    }

    #[test]
    fn probe_binary_at_reads_a_version_banner_from_a_path_with_spaces_and_unicode() {
        let script = fake_script("#!/bin/sh\necho 0.85.1\n", "@echo off\r\necho 0.85.1\r\n");
        match probe_binary_at(&script.path, None) {
            ResolutionOutcome::Found { version_output, .. } => {
                assert_eq!(
                    parse_version_line(&version_output).as_deref(),
                    Some("0.85.1")
                );
            }
            _ => panic!("expected Found"),
        }
    }

    #[test]
    fn probe_binary_at_surfaces_a_nonzero_exit_banner_as_a_found_output_still() {
        // A CLI that exits nonzero but still prints something recognizable is
        // still classified by its OUTPUT, not its exit code — mirrors
        // account::cli_tools's "the version probe answers even for a CLI that
        // fails otherwise" stance.
        let script = fake_script(
            "#!/bin/sh\necho 0.85.1\nexit 1\n",
            "@echo off\r\necho 0.85.1\r\nexit /b 1\r\n",
        );
        match probe_binary_at(&script.path, None) {
            ResolutionOutcome::Found { version_output, .. } => {
                assert_eq!(
                    parse_version_line(&version_output).as_deref(),
                    Some("0.85.1")
                );
            }
            _ => panic!("expected Found"),
        }
    }

    #[test]
    fn a_binary_that_never_exits_is_timed_out_within_the_injected_deadline() {
        let script = fake_script(
            "#!/bin/sh\nwhile true; do sleep 1; done\n",
            "@echo off\r\n:loop\r\ngoto loop\r\n",
        );
        let started = Instant::now();
        let run = run_bounded_with(
            &script.path,
            &["--version"],
            Duration::from_millis(80),
            None,
        );
        assert!(run.timed_out);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn output_past_the_cap_is_truncated_not_unbounded() {
        if cfg!(windows) {
            // `head`/`/dev/zero` are POSIX-only; the cap itself is
            // platform-independent code, exercised on the unix runner.
            return;
        }
        // 200000 bytes is well past `OUTPUT_CAP` (64 KiB): once the pump reads
        // its cap it drops its end of the pipe, `tr` gets a broken pipe on its
        // next write and dies well inside the deadline — proving both halves
        // of the CRITICAL fix: the output is truncated exactly at the cap,
        // and the run is NOT reported as timed out.
        let script = fake_script("#!/bin/sh\nhead -c 200000 /dev/zero | tr '\\0' 'a'\n", "");
        let started = Instant::now();
        let run = run_bounded_with(&script.path, &[], Duration::from_secs(5), None);
        assert_eq!(run.stdout.len(), OUTPUT_CAP);
        assert!(!run.timed_out);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
