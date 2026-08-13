//! session-worktree: git-shell helpers — every function here spawns `git`
//! (or `wsl.exe` on its behalf) via `crate::diff::git_routed`/`git_program`,
//! routed through the `GitHost` the caller derived (mod.rs's `resolve_worktree`
//! / `session_worktree_probe`). Split out of `worktree.rs` (quality remediation,
//! §Conventions ~1000-line cap) — the pure path helpers and the command
//! handlers stay in `mod.rs`.

use super::WorktreeStatusData;
use crate::diff::{git_program, git_routed, wsl_cd_target, GitHost};
use crate::process_util::no_window;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// FR-7: best-effort fetch budget.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// LOW remediation: `path_exists`'s WSL `test -e` probe gets the same
/// spawn+poll+timeout budget as `fetch_with_timeout` rather than blocking
/// forever on a wedged `wsl.exe`. Existence checks are near-instant in
/// practice, so a much shorter budget than the fetch timeout is enough.
const WSL_STAT_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn check_ref_format(host: &GitHost, dir: &str, branch: &str) -> Result<(), String> {
    match git_routed(host, dir, &["check-ref-format", "--branch", branch]) {
        Ok(o) if o.code == 0 => Ok(()),
        Ok(o) => Err(if o.stderr.is_empty() {
            format!("'{branch}' is not a valid branch name")
        } else {
            o.stderr
        }),
        Err(e) => Err(e.to_string()),
    }
}

pub(crate) fn branch_exists(host: &GitHost, repo_root: &str, branch: &str) -> bool {
    matches!(
        git_routed(
            host,
            repo_root,
            &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")],
        ),
        Ok(o) if o.code == 0
    )
}

/// Whether `rev` resolves to a commit in `repo_root`.
///
/// Callers only ever pass a FULLY QUALIFIED ref (`refs/heads/…`, `refs/remotes/…`), so no
/// value here can start with `-` and be mistaken for an option — `rev-parse` takes no `--`
/// separator for revisions.
pub(crate) fn rev_exists(host: &GitHost, repo_root: &str, rev: &str) -> bool {
    matches!(
        git_routed(
            host,
            repo_root,
            &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")],
        ),
        Ok(o) if o.code == 0
    )
}

/// Whether `ancestor` is reachable from `descendant` (`git merge-base --is-ancestor`).
/// Fully-qualified refs only, same reason as `rev_exists`.
pub(crate) fn is_ancestor(
    host: &GitHost,
    repo_root: &str,
    ancestor: &str,
    descendant: &str,
) -> bool {
    matches!(
        git_routed(host, repo_root, &["merge-base", "--is-ancestor", ancestor, descendant]),
        Ok(o) if o.code == 0
    )
}

pub(crate) fn remote_name(host: &GitHost, repo_root: &str) -> Option<String> {
    let o = git_routed(host, repo_root, &["remote"]).ok()?;
    if o.code != 0 {
        return None;
    }
    let text = String::from_utf8_lossy(&o.stdout);
    let names: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if names.is_empty() {
        None
    } else if names.contains(&"origin") {
        Some("origin".to_string())
    } else {
        Some(names[0].to_string())
    }
}

pub(crate) fn default_branch(host: &GitHost, repo_root: &str, remote: Option<&str>) -> String {
    if let Some(r) = remote {
        if let Ok(o) = git_routed(
            host,
            repo_root,
            &["symbolic-ref", &format!("refs/remotes/{r}/HEAD")],
        ) {
            if o.code == 0 {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if let Some(name) = s.strip_prefix(&format!("refs/remotes/{r}/")) {
                    return name.to_string();
                }
            }
        }
    }
    if let Ok(o) = git_routed(host, repo_root, &["config", "--get", "init.defaultBranch"]) {
        if o.code == 0 {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    "main".to_string()
}

pub(crate) fn current_branch(host: &GitHost, cwd: &str) -> Option<String> {
    let o = git_routed(host, cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    if o.code != 0 {
        return None;
    }
    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
    (!s.is_empty() && s != "HEAD").then_some(s)
}

/// One `git worktree list --porcelain` entry.
///
/// attach-to-worktree FR-3: `head`/`detached`/`locked`/`prunable`/`bare` were added
/// alongside `path`/`branch` — the porcelain lines the parser used to discard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WtEntry {
    pub(crate) path: String,
    pub(crate) branch: Option<String>,
    /// Full sha; `None` when git reports no `HEAD <sha>` line (unborn HEAD).
    pub(crate) head: Option<String>,
    pub(crate) detached: bool,
    pub(crate) locked: bool,
    pub(crate) prunable: bool,
    pub(crate) bare: bool,
}

/// Parses `git worktree list --porcelain` (blank-line-separated blocks: a
/// `worktree <path>` header, then optional `bare`/`HEAD <sha>`/`branch
/// refs/heads/<name>`/`detached`/`locked[ <reason>]`/`prunable[ <reason>]`
/// lines). The FIRST entry is always the main working tree — used as
/// `sourceRepoRoot` when adopting (FR-12) and excluded from the
/// attach-to-worktree picker (FR-2). Pure; split out so it's directly
/// unit-testable without a live git spawn.
pub(crate) fn parse_worktree_porcelain(text: &str) -> Vec<WtEntry> {
    let mut entries = Vec::new();
    let mut cur: Option<WtEntry> = None;
    for line in text.lines() {
        if line.is_empty() {
            if let Some(e) = cur.take() {
                entries.push(e);
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(e) = cur.take() {
                entries.push(e);
            }
            cur = Some(WtEntry {
                path: path.to_string(),
                branch: None,
                head: None,
                detached: false,
                locked: false,
                prunable: false,
                bare: false,
            });
        } else if let Some(r) = line.strip_prefix("branch ") {
            if let Some(e) = cur.as_mut() {
                e.branch = Some(r.strip_prefix("refs/heads/").unwrap_or(r).to_string());
            }
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            if let Some(e) = cur.as_mut() {
                e.head = Some(h.to_string());
            }
        } else if line == "detached" {
            if let Some(e) = cur.as_mut() {
                e.detached = true;
            }
        } else if line == "bare" {
            if let Some(e) = cur.as_mut() {
                e.bare = true;
            }
        } else if line == "locked" || line.starts_with("locked ") {
            if let Some(e) = cur.as_mut() {
                e.locked = true;
            }
        } else if line == "prunable" || line.starts_with("prunable ") {
            if let Some(e) = cur.as_mut() {
                e.prunable = true;
            }
        }
    }
    if let Some(e) = cur.take() {
        entries.push(e);
    }
    entries
}

pub(crate) fn worktree_list_entries(host: &GitHost, dir: &str) -> Vec<WtEntry> {
    let Ok(o) = git_routed(host, dir, &["worktree", "list", "--porcelain"]) else {
        return Vec::new();
    };
    if o.code != 0 {
        return Vec::new();
    }
    parse_worktree_porcelain(&String::from_utf8_lossy(&o.stdout))
}

pub(crate) fn norm_path(p: &str) -> String {
    p.trim_end_matches(['/', '\\'])
        .replace('\\', "/")
        .to_lowercase()
}

/// FR-5/§7 last-resort race detection: the path git names when it refuses a
/// `worktree add` because the branch is held by another worktree. Two wordings
/// have shipped over git's history:
///
/// ```text
/// fatal: 'feat/x' is already checked out at '/home/u/wt'
/// fatal: 'feat/x' is already used by worktree at '/home/u/wt'
/// ```
///
/// Pure — unit-tested against both. `None` for any other failure, which stays a
/// generic `WORKTREE_CREATE_FAILED`.
pub(crate) fn in_use_path_from_stderr(stderr: &str) -> Option<String> {
    const MARKERS: [&str; 2] = [
        "is already checked out at ",
        "is already used by worktree at ",
    ];
    for line in stderr.lines() {
        for marker in MARKERS {
            let Some(i) = line.find(marker) else { continue };
            let path = line[i + marker.len()..]
                .trim()
                .trim_end_matches(['.', ';', ','])
                .trim()
                .trim_matches(['\'', '"']);
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

pub(crate) fn branch_checked_out_at(host: &GitHost, dir: &str, branch: &str) -> Option<String> {
    worktree_list_entries(host, dir)
        .into_iter()
        .find(|e| e.branch.as_deref() == Some(branch))
        .map(|e| e.path)
}

/// FR-7: `git fetch --prune <remote>` with `GIT_TERMINAL_PROMPT=0` and a 20s
/// budget — best-effort, so failures/timeouts are returned as `Err(reason)`
/// rather than propagated.
///
/// MEDIUM remediation: for a `Wsl` host, setting the env var on the OUTER
/// `wsl.exe` process (as the native branch does with `Command::env`) never
/// reaches the Linux `git` process — WSL does not forward the launcher's
/// environment across the boundary. Pass it through the invocation itself via
/// `env GIT_TERMINAL_PROMPT=0 git …`.
pub(crate) fn fetch_with_timeout(
    host: &GitHost,
    repo_root: &str,
    remote: &str,
) -> Result<(), String> {
    // CRITICAL remediation: `remote` is a git remote *name*, sourced from
    // `git remote` output — for an adopted/hostile repo that can be an
    // attacker-controlled `.git/config` section name (e.g.
    // `--upload-pack=touch /tmp/pwned`). Callers reject a leading `-` before
    // calling in, but a `--` separator is added here too as defense in depth
    // so this helper is safe to call with any string.
    let mut cmd = match host {
        GitHost::Native => {
            let (program, argv) = git_program(host, repo_root, &["fetch", "--prune", "--", remote]);
            let mut c = Command::new(program);
            c.args(&argv)
                .env("GIT_TERMINAL_PROMPT", "0")
                .current_dir(repo_root);
            c
        }
        GitHost::Wsl(distro) => {
            let mut c = Command::new("wsl.exe");
            c.args([
                "-d",
                distro,
                "--cd",
                &wsl_cd_target(repo_root),
                "--",
                "env",
                "GIT_TERMINAL_PROMPT=0",
                "git",
                "fetch",
                "--prune",
                "--",
                remote,
            ]);
            c
        }
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                use std::io::Read;
                let mut stderr = String::new();
                if let Some(mut se) = child.stderr.take() {
                    let _ = se.read_to_string(&mut stderr);
                }
                let stderr = stderr.trim();
                return Err(if stderr.is_empty() {
                    "git fetch failed".to_string()
                } else {
                    stderr.to_string()
                });
            }
            Ok(None) => {
                if start.elapsed() >= FETCH_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("git fetch timed out".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Pure: the exact argv `path_exists` hands `wsl.exe` to probe `path` inside
/// `distro`.
///
/// CRITICAL remediation: `path` is translated with `wsl_cd_target` exactly like
/// every sibling helper here (`fetch_with_timeout`'s `--cd`, `git_program`'s
/// internal translation). It used to be passed VERBATIM, and a
/// `\\wsl$\<distro>\…` UNC path — the form the folder picker produces for a
/// WSL-runtime session — matches nothing inside the distro, so `test -e` always
/// failed. FR-7's cwd precheck (`session/commands.rs`) runs before
/// `resolve_worktree`, so that rejected every WSL session creation with
/// INVALID_INPUT, worktree or not. Translation is idempotent, so a bare Linux
/// path (a cached repo root, FR-5's adopt cwd) passes straight through.
pub(crate) fn wsl_test_argv(distro: &str, path: &str) -> Vec<String> {
    vec![
        "-d".to_string(),
        distro.to_string(),
        "--".to_string(),
        "test".to_string(),
        "-e".to_string(),
        wsl_cd_target(path),
    ]
}

/// Whether `path` exists, resolved on the given host — a Windows-side
/// `std::fs` stat for `Native`, or `wsl.exe -d <distro> -- test -e <path>` for
/// `Wsl` (the path is a Linux path unreachable from the Windows filesystem).
///
/// LOW remediation: the `Wsl` branch used to block on `Command::status()` with
/// no timeout, unlike `fetch_with_timeout`'s 20s budget — a wedged `wsl.exe`
/// (cold-booting distro, etc.) would hang worktree creation/removal/status
/// indefinitely. Same spawn+poll+timeout shape, a shorter budget.
pub(crate) fn path_exists(host: &GitHost, path: &str) -> bool {
    match host {
        GitHost::Native => std::path::Path::new(path).exists(),
        GitHost::Wsl(distro) => {
            let mut c = Command::new("wsl.exe");
            c.args(wsl_test_argv(distro, path))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            no_window(&mut c);
            let Ok(mut child) = c.spawn() else {
                return false;
            };
            let start = Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => return status.success(),
                    Ok(None) => {
                        if start.elapsed() >= WSL_STAT_TIMEOUT {
                            let _ = child.kill();
                            let _ = child.wait();
                            return false;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => return false,
                }
            }
        }
    }
}

// ---------- FR-18: dirty/unpushed status, shared by worktreeStatus and the removal re-check ----------

/// `base_ref` is only meaningful as a fallback fork-point when the caller KNOWS
/// it (i.e. the worktree's branch was created off it — `created_branch: true`);
/// for an adopted/existing-branch worktree the contract says `base_ref` is
/// meaningless, so callers must pass `None` there. With no upstream AND no
/// reliable base we can't compute a real unpushed count — fail SAFE
/// (`unpushed: true`) rather than silently reporting 0 and letting FR-19's
/// removal guard sail through on an unreliable "clean" reading.
pub(crate) fn compute_status(
    host: &GitHost,
    path: &str,
    base_ref: Option<&str>,
) -> Result<WorktreeStatusData, (String, String)> {
    let dirty_count = match git_routed(host, path, &["status", "--porcelain"]) {
        Ok(o) if o.code == 0 => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .count() as u32,
        Ok(o) => {
            return Err((
                "GIT_ERROR".into(),
                if o.stderr.is_empty() {
                    "git status failed".into()
                } else {
                    o.stderr
                },
            ))
        }
        Err(e) => return Err(("GIT_ERROR".into(), e.to_string())),
    };
    let upstream = git_routed(
        host,
        path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .and_then(|o| {
        if o.code == 0 {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            (!s.is_empty()).then_some(s)
        } else {
            None
        }
    });
    let range = match &upstream {
        Some(u) => Some(format!("{u}..HEAD")),
        None => base_ref.map(|b| format!("{b}..HEAD")),
    };
    let (unpushed, unpushed_count) = match &range {
        Some(range) => match git_routed(host, path, &["rev-list", "--count", range]) {
            Ok(o) if o.code == 0 => {
                let n = String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .parse::<u32>()
                    .unwrap_or(0);
                (n > 0, n)
            }
            // rev-list itself failed against a range we believed was reliable —
            // fail safe rather than reporting clean.
            _ => (true, 0),
        },
        // No upstream and no reliable base ref: we cannot know. Fail safe.
        None => (true, 0),
    };
    Ok(WorktreeStatusData {
        dirty: dirty_count > 0,
        dirty_count,
        unpushed,
        unpushed_count,
        upstream,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as Cmd;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "francois-worktree-git-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        let status = Cmd::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git spawn");
        assert!(status.success(), "git {args:?} failed in {dir:?}");
    }

    fn init_repo(dir: &std::path::Path) {
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.email", "t@example.com"]);
        git(dir, &["config", "user.name", "Test"]);
        std::fs::write(dir.join("a.txt"), "hi").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", "init"]);
    }

    // ---------- worktree_list_entries parsing ----------

    #[test]
    fn parses_porcelain_blocks_including_the_main_worktree() {
        let porcelain = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo/.francois-worktrees/repo/feat-x\nHEAD def456\nbranch refs/heads/feat/x\n\n";
        let entries = parse_worktree_porcelain(porcelain);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "/repo");
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!(entries[0].head.as_deref(), Some("abc123"));
        assert_eq!(entries[1].branch.as_deref(), Some("feat/x"));
    }

    // ---------- attach-to-worktree FR-3: head/detached/locked/prunable/bare parsing ----------

    #[test]
    fn parses_a_detached_head_entry() {
        let porcelain = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo/.francois-worktrees/repo/wt\nHEAD def456\ndetached\n\n";
        let entries = parse_worktree_porcelain(porcelain);
        assert_eq!(entries.len(), 2);
        let wt = &entries[1];
        assert_eq!(wt.branch, None);
        assert_eq!(wt.head.as_deref(), Some("def456"));
        assert!(wt.detached);
        assert!(!wt.locked);
        assert!(!wt.prunable);
        assert!(!wt.bare);
    }

    #[test]
    fn parses_a_bare_entry() {
        let porcelain = "worktree /repo.git\nbare\n\n";
        let entries = parse_worktree_porcelain(porcelain);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].bare);
        assert_eq!(entries[0].head, None);
    }

    #[test]
    fn parses_locked_with_and_without_a_reason() {
        let porcelain = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /wt1\nHEAD def456\nbranch refs/heads/feat/x\nlocked\n\nworktree /wt2\nHEAD ghi789\nbranch refs/heads/feat/y\nlocked reason: mid-rebase\n\n";
        let entries = parse_worktree_porcelain(porcelain);
        assert_eq!(entries.len(), 3);
        assert!(entries[1].locked);
        assert!(entries[2].locked);
    }

    #[test]
    fn parses_prunable_with_and_without_a_reason() {
        let porcelain = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /wt1\nHEAD def456\nbranch refs/heads/feat/x\nprunable\n\nworktree /wt2\nHEAD ghi789\nbranch refs/heads/feat/y\nprunable gitdir file points to non-existent location\n\n";
        let entries = parse_worktree_porcelain(porcelain);
        assert_eq!(entries.len(), 3);
        assert!(entries[1].prunable);
        assert!(entries[2].prunable);
    }

    #[test]
    fn parses_an_unborn_head_with_no_head_line() {
        // No commit yet: no `HEAD <sha>` line, but the branch is still named.
        let porcelain = "worktree /repo\nbranch refs/heads/main\n\n";
        let entries = parse_worktree_porcelain(porcelain);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].head, None);
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert!(!entries[0].detached);
    }

    #[test]
    fn norm_path_ignores_case_slashes_and_trailing_separator() {
        assert_eq!(norm_path("D:\\Repo\\"), norm_path("d:/repo"));
    }

    #[test]
    fn in_use_path_is_extracted_from_gits_own_refusal() {
        // §7 race: the branch got checked out between the last probe and
        // `git worktree add`. Both wordings git has shipped are recognized.
        assert_eq!(
            in_use_path_from_stderr("fatal: 'feat/x' is already checked out at '/home/u/wt'\n")
                .as_deref(),
            Some("/home/u/wt")
        );
        assert_eq!(
            in_use_path_from_stderr(
                "fatal: 'feat/x' is already used by worktree at 'D:\\repo\\wt'."
            )
            .as_deref(),
            Some("D:\\repo\\wt")
        );
        assert!(in_use_path_from_stderr("fatal: invalid reference: nope").is_none());
        assert!(in_use_path_from_stderr("").is_none());
    }

    #[test]
    fn check_ref_format_rejects_an_invalid_branch_name() {
        let repo = tmp_dir("ref-format");
        init_repo(&repo);
        let cwd = repo.to_string_lossy().to_string();
        let host = GitHost::Native;
        assert!(check_ref_format(&host, &cwd, "not..a valid~name").is_err());
        assert!(check_ref_format(&host, &cwd, "feat/ok").is_ok());
    }

    #[test]
    fn status_reports_dirty_and_clean_worktrees() {
        use super::super::{resolve_worktree, WorktreeCreateInput};

        let repo = tmp_dir("status");
        init_repo(&repo);
        let cwd = repo.to_string_lossy().to_string();
        let opts = WorktreeCreateInput {
            branch: "feat/status".into(),
            base_ref: "main".into(),
            adopt: false,
        };
        let (worktree_path, _, _) = resolve_worktree(&cwd, &opts).expect("create ok");
        let host = GitHost::Native;

        let clean = compute_status(&host, &worktree_path, Some("main")).expect("status ok");
        assert!(!clean.dirty);
        assert_eq!(clean.dirty_count, 0);

        std::fs::write(std::path::Path::new(&worktree_path).join("b.txt"), "x").unwrap();
        let dirty = compute_status(&host, &worktree_path, Some("main")).expect("status ok");
        assert!(dirty.dirty);
        assert_eq!(dirty.dirty_count, 1);
    }

    #[test]
    fn wsl_test_argv_translates_unc_and_passes_linux_paths_through() {
        // CRITICAL regression: the `Wsl` arm of `path_exists` used to hand `path`
        // to `test -e` VERBATIM, unlike every sibling helper here. A
        // `\\wsl$\<distro>\…` UNC path — exactly what the folder picker yields
        // for a WSL-runtime session — means nothing inside the distro, so the
        // probe always answered "missing": FR-7's cwd precheck
        // (session/commands.rs) then failed INVALID_INPUT for EVERY WSL session,
        // worktree or not. Mirrors diff/git.rs's
        // `wsl_cd_target_translates_unc_and_passes_linux_paths_through`; wsl.exe
        // can't run in CI, so the argv itself is the assertion.
        assert_eq!(
            wsl_test_argv("Ubuntu", "\\\\wsl$\\Ubuntu\\home\\u\\api"),
            vec!["-d", "Ubuntu", "--", "test", "-e", "/home/u/api"]
        );
        // A bare Linux path (a cached repo root, or FR-5's adopt cwd read back
        // from `git worktree list --porcelain`) passes through untouched.
        assert_eq!(
            wsl_test_argv("Debian", "/home/u/.francois-worktrees/api/feat-x"),
            vec![
                "-d",
                "Debian",
                "--",
                "test",
                "-e",
                "/home/u/.francois-worktrees/api/feat-x"
            ]
        );
    }

    #[test]
    fn status_fails_safe_to_unpushed_true_with_no_upstream_and_no_reliable_base() {
        // Mirrors an adopted / existing-branch worktree: no upstream configured
        // and the caller (correctly) passes `None` because `created_branch` is
        // false — `base_ref` must never be trusted as a fallback range there.
        let repo = tmp_dir("status-no-base");
        init_repo(&repo);
        let cwd = repo.to_string_lossy().to_string();
        let host = GitHost::Native;

        let status = compute_status(&host, &cwd, None).expect("status ok");
        assert!(!status.dirty);
        assert!(
            status.unpushed,
            "no reliable base ⇒ fail safe (unpushed: true)"
        );
    }
}
