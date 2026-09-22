//! the routed `git`/`gh` runner (native or WSL, like `diff::git_routed`, but
//! with a hard timeout — a hung `gh` call must never hang a github-page
//! command) and `gh` status detection (missing / unauthenticated / not a
//! GitHub remote), cached per repo root for ~60s.

use super::GhStatus;
use crate::diff::{wsl_cd_target, GitHost, GitOut};
use crate::ipc::{AppError, ErrorCode};
use crate::wsl;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub(crate) const GH_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const GIT_TIMEOUT: Duration = Duration::from_secs(15);
/// Generous: a `gh pr view` with a large diffstat, or a `git show` on a big
/// commit, can run past a tighter cap.
const OUTPUT_CAP: usize = 8 * 1024 * 1024;

/// Pure: the exact (program, argv) `run_routed` spawns for `program`
/// ('git'/'gh') against `dir` under `host` — mirrors `diff::git_program`,
/// generalized over the program name.
pub(crate) fn program_argv(
    program: &str,
    host: &GitHost,
    dir: &str,
    args: &[&str],
) -> (String, Vec<String>) {
    match host {
        GitHost::Native => (
            program.to_string(),
            args.iter().map(|s| s.to_string()).collect(),
        ),
        GitHost::Wsl(distro) => {
            let mut argv = vec![
                "-d".to_string(),
                distro.clone(),
                "--cd".to_string(),
                wsl_cd_target(dir),
                "--".to_string(),
                program.to_string(),
            ];
            argv.extend(args.iter().map(|s| s.to_string()));
            ("wsl.exe".to_string(), argv)
        }
    }
}

/// Runs `program` against `dir` under `host`, bounded by `timeout`. WSL output
/// decoding mirrors `diff::git_routed` (wsl.exe's own failures are UTF-16LE,
/// on stdout).
pub(crate) fn run_routed(
    program: &str,
    host: &GitHost,
    dir: &str,
    args: &[&str],
    timeout: Duration,
) -> GitOut {
    let (bin, argv) = program_argv(program, host, dir, args);
    let mut builder = crate::process_util::spawn(&bin).args(&argv);
    if matches!(host, GitHost::Native) {
        builder = builder.current_dir(dir);
    }
    let run = builder.run_bounded(timeout, OUTPUT_CAP);
    if run.spawn_failed {
        return GitOut {
            code: -1,
            stdout: Vec::new(),
            stderr: format!("{program}: failed to start"),
        };
    }
    if run.timed_out {
        return GitOut {
            code: -1,
            stdout: Vec::new(),
            stderr: format!("{program} timed out"),
        };
    }
    let code = run.status.and_then(|s| s.code()).unwrap_or(-1);
    let wsl_host = matches!(host, GitHost::Wsl(_));
    let mut stderr = if wsl_host {
        wsl::decode_wsl_output(&run.stderr)
    } else {
        String::from_utf8_lossy(&run.stderr).trim().to_string()
    };
    if wsl_host && code != 0 && stderr.is_empty() && run.stdout.contains(&0) {
        stderr = wsl::decode_wsl_output(&run.stdout);
    }
    GitOut {
        code,
        stdout: run.stdout,
        stderr,
    }
}

pub(crate) fn git_routed(host: &GitHost, dir: &str, args: &[&str]) -> GitOut {
    run_routed("git", host, dir, args, GIT_TIMEOUT)
}

pub(crate) fn gh_routed(host: &GitHost, dir: &str, args: &[&str]) -> GitOut {
    run_routed("gh", host, dir, args, GH_TIMEOUT)
}

// ---------- gh status detection ----------

fn gh_on_path(host: &GitHost, dir: &str) -> bool {
    run_routed("gh", host, dir, &["--version"], GH_TIMEOUT).code == 0
}

fn gh_auth_ok(host: &GitHost, dir: &str, hostname: &str) -> bool {
    gh_routed(host, dir, &["auth", "status", "--hostname", hostname]).code == 0
}

/// Pure decision given the two probes below (unit-tested directly): `gh`
/// missing -> Missing; a non-github.com remote whose host isn't an
/// authenticated GHE host -> NotGithub; otherwise Unauthenticated/Ok per the
/// `auth status` probe against the relevant host (github.com when the repo
/// has no known remote host).
fn decide_gh_status(
    installed: bool,
    remote_host: Option<&str>,
    auth_ok_for: impl Fn(&str) -> bool,
) -> GhStatus {
    if !installed {
        return GhStatus::Missing;
    }
    match remote_host {
        Some(h) if h != "github.com" => {
            if auth_ok_for(h) {
                GhStatus::Ok
            } else {
                GhStatus::NotGithub
            }
        }
        Some(h) => {
            if auth_ok_for(h) {
                GhStatus::Ok
            } else {
                GhStatus::Unauthenticated
            }
        }
        None => {
            if auth_ok_for("github.com") {
                GhStatus::Ok
            } else {
                GhStatus::Unauthenticated
            }
        }
    }
}

fn detect_gh_status(host: &GitHost, root: &str, remote_host: Option<&str>) -> GhStatus {
    decide_gh_status(gh_on_path(host, root), remote_host, |h| {
        gh_auth_ok(host, root, h)
    })
}

struct CacheEntry {
    status: GhStatus,
    at: Instant,
}

static GH_STATUS_CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
const GH_STATUS_TTL: Duration = Duration::from_secs(60);

/// `gh` status for `root`, cached ~60s — every gh-backed command probes
/// availability before spending its own timeout budget on a doomed call.
pub(crate) fn gh_status_cached(host: &GitHost, root: &str, remote_host: Option<&str>) -> GhStatus {
    let cache = GH_STATUS_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(entry) = cache.lock().unwrap().get(root) {
        if entry.at.elapsed() < GH_STATUS_TTL {
            return entry.status;
        }
    }
    let status = detect_gh_status(host, root, remote_host);
    cache.lock().unwrap().insert(
        root.to_string(),
        CacheEntry {
            status,
            at: Instant::now(),
        },
    );
    status
}

// ---------- errors ----------

pub(crate) fn gh_unavailable(status: GhStatus) -> AppError {
    AppError::with_detail(
        ErrorCode::GhUnavailable,
        "the GitHub CLI is not available for this repository",
        json!({ "status": status }),
    )
}

/// The last 20 lines of `stderr` — a `gh` failure's stack/hint can run long,
/// and the wire only needs enough to render a useful message.
fn stderr_tail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().collect();
    let start = lines.len().saturating_sub(20);
    lines[start..].join("\n")
}

pub(crate) fn gh_failed(out: &GitOut) -> AppError {
    AppError::with_detail(
        ErrorCode::GhFailed,
        if out.stderr.is_empty() {
            "gh exited with an error".to_string()
        } else {
            out.stderr.clone()
        },
        json!({ "code": out.code, "stderr": stderr_tail(&out.stderr) }),
    )
}

pub(crate) fn gh_json<T: serde::de::DeserializeOwned>(
    host: &GitHost,
    root: &str,
    args: &[&str],
) -> Result<T, AppError> {
    let out = gh_routed(host, root, args);
    if out.code != 0 {
        return Err(gh_failed(&out));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| {
        AppError::new(
            ErrorCode::GhFailed,
            format!("could not parse gh output: {e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_argv_native_passes_args_through() {
        let (bin, argv) = program_argv("gh", &GitHost::Native, "D:\\repo", &["pr", "list"]);
        assert_eq!(bin, "gh");
        assert_eq!(argv, vec!["pr", "list"]);
    }

    #[test]
    fn program_argv_wsl_wraps_with_distro_and_cd() {
        let (bin, argv) = program_argv(
            "gh",
            &GitHost::Wsl("Ubuntu".into()),
            "\\\\wsl$\\Ubuntu\\home\\u\\api",
            &["pr", "list"],
        );
        assert_eq!(bin, "wsl.exe");
        assert_eq!(
            argv,
            vec![
                "-d",
                "Ubuntu",
                "--cd",
                "/home/u/api",
                "--",
                "gh",
                "pr",
                "list"
            ]
        );
    }

    #[test]
    fn decide_gh_status_missing_when_not_installed() {
        assert_eq!(
            decide_gh_status(false, Some("github.com"), |_| true),
            GhStatus::Missing
        );
    }

    #[test]
    fn decide_gh_status_unauthenticated_on_github_with_no_auth() {
        assert_eq!(
            decide_gh_status(true, Some("github.com"), |_| false),
            GhStatus::Unauthenticated
        );
        assert_eq!(
            decide_gh_status(true, None, |_| false),
            GhStatus::Unauthenticated
        );
    }

    #[test]
    fn decide_gh_status_ok_on_github_when_authenticated() {
        assert_eq!(
            decide_gh_status(true, Some("github.com"), |_| true),
            GhStatus::Ok
        );
        assert_eq!(decide_gh_status(true, None, |_| true), GhStatus::Ok);
    }

    #[test]
    fn decide_gh_status_not_github_for_an_unauthenticated_ghe_remote() {
        assert_eq!(
            decide_gh_status(true, Some("github.example.com"), |_| false),
            GhStatus::NotGithub
        );
    }

    #[test]
    fn decide_gh_status_ok_for_an_authenticated_ghe_remote() {
        assert_eq!(
            decide_gh_status(true, Some("github.example.com"), |_| true),
            GhStatus::Ok
        );
    }

    #[test]
    fn stderr_tail_keeps_only_the_last_20_lines() {
        let long = (1..=30)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let tail = stderr_tail(&long);
        assert_eq!(tail.lines().count(), 20);
        assert!(tail.starts_with("line 11"));
        assert!(tail.ends_with("line 30"));
    }
}
