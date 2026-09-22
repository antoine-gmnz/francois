//! `github_list_branches`, `github_worktree_disk_usage`, `github_create_worktree`,
//! `github_prune`.

use super::gh::git_routed;
use super::{
    resolve_scope, AheadBehind, BranchInfo, BranchLastCommit, BranchWorktree, PruneOutcome,
};
use crate::diff::GitHost;
use crate::ipc::{AppError, ErrorCode};
use crate::session::worktree::git::{
    branch_checked_out_at, current_branch, default_branch, remote_name, worktree_list_entries,
    WtEntry,
};
use crate::session::worktree::worktree_slug;
use std::collections::HashSet;
use std::time::{Duration, Instant};

// ---------- pure path helpers ----------

fn path_sep(p: &str) -> char {
    if p.contains('\\') && !p.contains('/') {
        '\\'
    } else {
        '/'
    }
}

fn parent_and_base(root: &str) -> (String, String) {
    let sep = path_sep(root);
    let trimmed = root.strip_suffix(sep).unwrap_or(root);
    match trimmed.rfind(['/', '\\']) {
        Some(i) => (trimmed[..i].to_string(), trimmed[i + 1..].to_string()),
        None => (trimmed.to_string(), trimmed.to_string()),
    }
}

/// FR-9 (create_worktree): `<parent-of-root>/<repo-name>-<branch-slug>`. Pure —
/// unit-tested directly, mirrors `session::worktree`'s own target-path shape
/// with a different (flatter) layout, since this worktree isn't nested under
/// `.francois-worktrees`.
pub(crate) fn create_target_path(root: &str, branch: &str) -> String {
    let (parent, base) = parent_and_base(root);
    let sep = path_sep(root);
    let slug = worktree_slug(branch);
    format!("{parent}{sep}{base}-{slug}")
}

fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_string()
}

fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(|h| norm(&h))
}

/// FR-10: `path` relative to `main_root`'s PARENT as `../x` when they are
/// direct siblings; `~/…` under `$HOME`; else the absolute path. Pure — the
/// home directory is injected so it's directly testable.
pub(crate) fn display_path_with_home(main_root: &str, path: &str, home: Option<&str>) -> String {
    let main = norm(main_root);
    let target = norm(path);
    if let Some(idx) = main.rfind('/') {
        let parent_prefix = format!("{}/", &main[..idx]);
        if let Some(rest) = target.strip_prefix(&parent_prefix) {
            // Only a direct sibling (one path segment, no nested `/'`) reads as
            // `../x` — a deeper descendant of the parent (e.g. a
            // `.francois-worktrees/<repo>/<slug>` tree) falls through to the
            // home-relative/absolute branches below instead.
            if !rest.is_empty() && !rest.contains('/') {
                return format!("../{rest}");
            }
        }
    }
    if let Some(home) = home {
        let home = norm(home);
        if target == home {
            return "~".to_string();
        }
        if let Some(rest) = target.strip_prefix(&format!("{home}/")) {
            return format!("~/{rest}");
        }
    }
    path.to_string()
}

fn display_path(main_root: &str, path: &str) -> String {
    display_path_with_home(main_root, path, home_dir().as_deref())
}

fn worktree_dirty(host: &GitHost, path: &str) -> bool {
    let out = git_routed(host, path, &["status", "--porcelain"]);
    out.code == 0
        && String::from_utf8_lossy(&out.stdout)
            .lines()
            .any(|l| !l.trim().is_empty())
}

fn to_local_fs_path(host: &GitHost, path: &str) -> Option<String> {
    match host {
        GitHost::Native => Some(path.to_string()),
        GitHost::Wsl(distro) => crate::wsl::linux_to_wsl_unc(Some(distro), path),
    }
}

// ---------- branches ----------

fn ahead_behind(host: &GitHost, root: &str, default: &str, branch: &str) -> AheadBehind {
    let out = git_routed(
        host,
        root,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{default}...{branch}"),
        ],
    );
    if out.code != 0 {
        return AheadBehind {
            ahead: 0,
            behind: 0,
        };
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.split_whitespace();
    let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    AheadBehind { ahead, behind }
}

/// Parses the output of `git for-each-ref
/// --format=%(refname:short)%09%(ahead-behind:<default>) refs/heads`. The
/// `ahead-behind` atom (git >= 2.41) renders as two whitespace-separated
/// integers, **ahead then behind** (the opposite order from `rev-list
/// --left-right --count <default>...<branch>`, which is behind-then-ahead).
/// Returns `None` on any malformed row so the caller falls back to the
/// per-branch `rev-list` loop rather than silently reporting zeros — an
/// installed git that doesn't support the atom exits non-zero before this is
/// ever called, but a row-level parse failure is treated the same way out of
/// caution.
fn parse_ahead_behind_bulk(text: &str) -> Option<std::collections::HashMap<String, AheadBehind>> {
    let mut map = std::collections::HashMap::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut fields = line.splitn(2, '\t');
        let name = fields.next()?.to_string();
        let rest = fields.next()?;
        let mut nums = rest.split_whitespace();
        let ahead: u32 = nums.next()?.parse().ok()?;
        let behind: u32 = nums.next()?.parse().ok()?;
        map.insert(name, AheadBehind { ahead, behind });
    }
    Some(map)
}

/// Attempts the single-call `for-each-ref` form of ahead/behind for every
/// local branch at once. Returns `None` when the installed git predates the
/// `ahead-behind` atom (2.41) or the output didn't parse, so the caller can
/// fall back to the O(branches) `rev-list` loop.
fn try_bulk_ahead_behind(
    host: &GitHost,
    root: &str,
    default: &str,
) -> Option<std::collections::HashMap<String, AheadBehind>> {
    let out = git_routed(
        host,
        root,
        &[
            "for-each-ref",
            &format!("--format=%(refname:short)%09%(ahead-behind:{default})"),
            "refs/heads",
        ],
    );
    if out.code != 0 {
        return None;
    }
    parse_ahead_behind_bulk(&String::from_utf8_lossy(&out.stdout))
}

struct RefRow {
    name: String,
    short_sha: String,
    subject: String,
    committed_at: i64,
}

fn parse_for_each_ref(text: &str) -> Vec<RefRow> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\t');
            let name = parts.next()?.to_string();
            let short_sha = parts.next()?.to_string();
            let subject = parts.next()?.to_string();
            let ts: i64 = parts.next().unwrap_or("0").trim().parse().unwrap_or(0);
            Some(RefRow {
                name,
                short_sha,
                subject,
                committed_at: ts * 1000,
            })
        })
        .collect()
}

pub(crate) fn do_list_branches(cwd: &str) -> Result<Vec<BranchInfo>, AppError> {
    let (host, root, _) = resolve_scope(cwd)?;
    let remote = remote_name(&host, &root);
    let default = default_branch(&host, &root, remote.as_deref());
    let current = current_branch(&host, &root);

    let out = git_routed(
        &host,
        &root,
        &[
            "for-each-ref",
            "--format=%(refname:short)%09%(objectname:short)%09%(subject)%09%(committerdate:unix)",
            "refs/heads",
        ],
    );
    if out.code != 0 {
        return Err(AppError::new(
            ErrorCode::GitError,
            if out.stderr.is_empty() {
                "git for-each-ref failed".to_string()
            } else {
                out.stderr
            },
        ));
    }
    let refs = parse_for_each_ref(&String::from_utf8_lossy(&out.stdout));

    let merged_out = git_routed(
        &host,
        &root,
        &["branch", "--merged", &default, "--format=%(refname:short)"],
    );
    let merged: HashSet<String> = if merged_out.code == 0 {
        String::from_utf8_lossy(&merged_out.stdout)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        HashSet::new()
    };

    let entries = worktree_list_entries(&host, &root);
    let main_path = entries
        .first()
        .map(|e| e.path.clone())
        .unwrap_or_else(|| root.clone());

    let bulk_ahead_behind = try_bulk_ahead_behind(&host, &root, &default);

    let mut branches: Vec<BranchInfo> = refs
        .into_iter()
        .map(|r| {
            let is_default = r.name == default;
            let worktree_entry = entries
                .iter()
                .find(|e| e.branch.as_deref() == Some(r.name.as_str()));
            let worktree = worktree_entry.map(|e: &WtEntry| BranchWorktree {
                is_main: norm(&e.path) == norm(&main_path),
                dirty: worktree_dirty(&host, &e.path),
                display_path: display_path(&main_path, &e.path),
                path: e.path.clone(),
            });
            let vs_default = match &bulk_ahead_behind {
                Some(map) => map.get(&r.name).cloned().unwrap_or(AheadBehind {
                    ahead: 0,
                    behind: 0,
                }),
                None => ahead_behind(&host, &root, &default, &r.name),
            };
            BranchInfo {
                is_current: current.as_deref() == Some(r.name.as_str()),
                vs_default,
                merged: !is_default && merged.contains(&r.name),
                worktree,
                last_commit: BranchLastCommit {
                    short_sha: r.short_sha,
                    subject: r.subject,
                    committed_at: r.committed_at,
                },
                is_default,
                name: r.name,
            }
        })
        .collect();

    branches.sort_by_key(|b| (!b.is_default, -b.last_commit.committed_at));
    Ok(branches)
}

// ---------- worktree disk usage ----------

const DISK_USAGE_BUDGET: Duration = Duration::from_secs(2);

/// Bounded, non-symlink-following walk of `dir`, adding file sizes into
/// `total`. Returns `false` when the deadline was exceeded mid-walk (the
/// caller reports `bytes: None` in that case).
fn walk_dir_bounded(dir: &std::path::Path, deadline: Instant, total: &mut u64) -> bool {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if Instant::now() >= deadline {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            if Instant::now() >= deadline {
                return false;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() {
                if let Ok(meta) = entry.metadata() {
                    *total += meta.len();
                }
            }
        }
    }
    true
}

pub(crate) fn do_worktree_disk_usage(cwd: &str) -> Result<(Option<u64>, u32), AppError> {
    let (host, root, _) = resolve_scope(cwd)?;
    let entries = worktree_list_entries(&host, &root);
    let count = entries.len() as u32;
    let deadline = Instant::now() + DISK_USAGE_BUDGET;
    let mut total: u64 = 0;
    for e in &entries {
        let Some(local) = to_local_fs_path(&host, &e.path) else {
            return Ok((None, count));
        };
        if !walk_dir_bounded(std::path::Path::new(&local), deadline, &mut total) {
            return Ok((None, count));
        }
    }
    Ok((Some(total), count))
}

// ---------- create worktree ----------

pub(crate) fn do_create_worktree(cwd: &str, branch: &str) -> Result<BranchWorktree, AppError> {
    let (host, root, _) = resolve_scope(cwd)?;
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(AppError::new(ErrorCode::InvalidInput, "branch is empty"));
    }
    if branch.starts_with('-') {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "branch must not start with '-'",
        ));
    }
    if let Some(path) = branch_checked_out_at(&host, &root, branch) {
        return Err(AppError::with_detail(
            ErrorCode::WorktreeBranchInUse,
            "that branch is already checked out elsewhere",
            serde_json::json!({ "path": path }),
        ));
    }
    let target = create_target_path(&root, branch);
    let out = git_routed(&host, &root, &["worktree", "add", &target, branch]);
    if out.code != 0 {
        return Err(AppError::new(
            ErrorCode::WorktreeCreateFailed,
            if out.stderr.is_empty() {
                "git worktree add failed".to_string()
            } else {
                out.stderr
            },
        ));
    }
    let entries = worktree_list_entries(&host, &root);
    let main_path = entries
        .first()
        .map(|e| e.path.clone())
        .unwrap_or_else(|| root.clone());
    Ok(BranchWorktree {
        display_path: display_path(&main_path, &target),
        is_main: false,
        dirty: false,
        path: target,
    })
}

// ---------- prune ----------

pub(crate) fn do_prune(cwd: &str, branches: &[String]) -> Result<Vec<PruneOutcome>, AppError> {
    let (host, root, _) = resolve_scope(cwd)?;
    let remote = remote_name(&host, &root);
    let default = default_branch(&host, &root, remote.as_deref());
    let current = current_branch(&host, &root);

    let merged_out = git_routed(
        &host,
        &root,
        &["branch", "--merged", &default, "--format=%(refname:short)"],
    );
    let merged: HashSet<String> = if merged_out.code == 0 {
        String::from_utf8_lossy(&merged_out.stdout)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        HashSet::new()
    };
    let entries = worktree_list_entries(&host, &root);

    let outcomes = branches
        .iter()
        .map(|branch| {
            prune_one(
                &host,
                &root,
                branch,
                &default,
                current.as_deref(),
                &merged,
                &entries,
            )
        })
        .collect();
    Ok(outcomes)
}

#[allow(clippy::too_many_arguments)]
fn prune_one(
    host: &GitHost,
    root: &str,
    branch: &str,
    default: &str,
    current: Option<&str>,
    merged: &HashSet<String>,
    entries: &[WtEntry],
) -> PruneOutcome {
    let skip = |reason: &str| PruneOutcome {
        branch: branch.to_string(),
        removed: false,
        reason: Some(reason.to_string()),
    };
    if branch.starts_with('-') {
        return skip("branch must not start with '-'");
    }
    if branch == default {
        return skip("the default branch is never pruned");
    }
    if current == Some(branch) {
        return skip("the current branch is never pruned");
    }
    if !merged.contains(branch) {
        return skip("not merged into the default branch");
    }
    if let Some(e) = entries.iter().find(|e| e.branch.as_deref() == Some(branch)) {
        if worktree_dirty(host, &e.path) {
            return skip("the worktree has uncommitted changes");
        }
        let rm = git_routed(host, root, &["worktree", "remove", "--", &e.path]);
        if rm.code != 0 {
            return skip(if rm.stderr.is_empty() {
                "could not remove the worktree"
            } else {
                &rm.stderr
            });
        }
    }
    let del = git_routed(host, root, &["branch", "-d", "--", branch]);
    if del.code == 0 {
        PruneOutcome {
            branch: branch.to_string(),
            removed: true,
            reason: None,
        }
    } else {
        skip(if del.stderr.is_empty() {
            "could not delete the branch"
        } else {
            &del.stderr
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_target_path_is_a_sibling_with_a_slugged_branch() {
        assert_eq!(
            create_target_path("/home/u/orbit", "feat/Add Retry"),
            "/home/u/orbit-feat-add-retry"
        );
        assert_eq!(
            create_target_path("D:\\repos\\orbit", "feat/x"),
            "D:\\repos\\orbit-feat-x"
        );
    }

    #[test]
    fn display_path_prefers_sibling_relative() {
        assert_eq!(
            display_path_with_home("/home/u/orbit", "/home/u/orbit-feat-x", None),
            "../orbit-feat-x"
        );
    }

    #[test]
    fn display_path_falls_back_to_home_relative() {
        assert_eq!(
            display_path_with_home(
                "/home/u/orbit",
                "/home/u/.francois-worktrees/orbit/x",
                Some("/home/u")
            ),
            "~/.francois-worktrees/orbit/x"
        );
        assert_eq!(
            display_path_with_home("/home/u/orbit", "/home/u", Some("/home/u")),
            "~"
        );
    }

    #[test]
    fn display_path_falls_back_to_absolute() {
        assert_eq!(
            display_path_with_home("/home/u/orbit", "/mnt/other/x", Some("/root")),
            "/mnt/other/x"
        );
    }

    #[test]
    fn parse_for_each_ref_reads_tab_separated_rows() {
        let text = "main\tabc1234\tinitial commit\t1700000000\nfeat/x\tdef5678\twip\t1700000100\n";
        let rows = parse_for_each_ref(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "main");
        assert_eq!(rows[0].short_sha, "abc1234");
        assert_eq!(rows[0].committed_at, 1700000000000);
        assert_eq!(rows[1].name, "feat/x");
    }

    #[test]
    fn parse_ahead_behind_bulk_reads_ahead_then_behind() {
        let text = "main\t0 0\nfeat/x\t3 1\n";
        let map = parse_ahead_behind_bulk(text).expect("should parse");
        assert_eq!(map.len(), 2);
        let x = map.get("feat/x").unwrap();
        assert_eq!(x.ahead, 3);
        assert_eq!(x.behind, 1);
        let m = map.get("main").unwrap();
        assert_eq!(m.ahead, 0);
        assert_eq!(m.behind, 0);
    }

    #[test]
    fn parse_ahead_behind_bulk_ignores_blank_lines() {
        let text = "main\t0 0\n\nfeat/x\t3 1\n";
        let map = parse_ahead_behind_bulk(text).expect("should parse");
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn parse_ahead_behind_bulk_returns_none_on_malformed_row() {
        assert!(parse_ahead_behind_bulk("main\tnot-numbers\n").is_none());
        assert!(parse_ahead_behind_bulk("main-with-no-tab\n").is_none());
    }

    #[test]
    fn prune_one_skips_the_default_and_current_branch() {
        let host = GitHost::Native;
        let merged: HashSet<String> = ["main".into()].into_iter().collect();
        let o = prune_one(&host, "/repo", "main", "main", None, &merged, &[]);
        assert!(!o.removed);
        assert_eq!(
            o.reason.as_deref(),
            Some("the default branch is never pruned")
        );

        let o = prune_one(
            &host,
            "/repo",
            "feat/x",
            "main",
            Some("feat/x"),
            &merged,
            &[],
        );
        assert!(!o.removed);
        assert_eq!(
            o.reason.as_deref(),
            Some("the current branch is never pruned")
        );
    }

    #[test]
    fn prune_one_rejects_a_branch_starting_with_dash() {
        let host = GitHost::Native;
        let merged: HashSet<String> = ["-x".into()].into_iter().collect();
        let o = prune_one(&host, "/repo", "-x", "main", None, &merged, &[]);
        assert!(!o.removed);
        assert_eq!(o.reason.as_deref(), Some("branch must not start with '-'"));
    }

    #[test]
    fn prune_one_skips_an_unmerged_branch() {
        let host = GitHost::Native;
        let merged: HashSet<String> = ["main".into()].into_iter().collect();
        let o = prune_one(&host, "/repo", "feat/unmerged", "main", None, &merged, &[]);
        assert!(!o.removed);
        assert_eq!(
            o.reason.as_deref(),
            Some("not merged into the default branch")
        );
    }
}
