// github-page core — the `github` domain (specs/github-page.md): the app-bar
// GitHub view's pull requests, commits and branches/worktrees. Local git data
// is always available; PR data (reviews, checks) needs the `gh` CLI and is
// gated behind `GhStatus` (contract/github-page.ts).
//
// Every git/gh invocation routes through `gh::git_routed`/`gh::gh_routed`
// (WSL-aware, like `diff::git_routed`, but with a hard timeout — see `gh.rs`)
// and reuses `diff`'s `GitHost`/repo-root resolution and
// `session::worktree::git`'s helpers (remote name, default branch, worktree
// listing, fetch-with-timeout, branch slug) rather than duplicating them.
//
// mod.rs owns the shared serialized model (mirrors contract/github-page.ts
// EXACTLY) and the pure timestamp helper every child needs; each child owns
// one concern:
//  * gh       — the gh/git routed runner, gh status detection, JSON exec.
//  * repo     — remote URL parsing, `github_repo_info` / `github_fetch`.
//  * pulls    — `github_list_pulls` / `github_get_pull` / `github_update_pull_branch`.
//  * commits  — `github_list_commits` / `github_get_commit`.
//  * branches — `github_list_branches`, worktree disk usage, create, prune.
//  * commands — the `#[tauri::command]` surface, `github_open_url`.

mod branches;
mod commands;
mod commits;
mod gh;
mod pulls;
mod repo;

pub use commands::*;

use crate::diff::{is_git_repo, repo_root, GitHost};
use crate::ipc::{AppError, ErrorCode};
use crate::session::worktree::git::remote_name;
use serde::Serialize;

pub(crate) const NOT_A_REPO_MSG: &str =
    "not a git repository — initialize with `git init` in the shell";

// ---------- shared serialized shapes (contract/github-page.ts) ----------

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum GhStatus {
    Ok,
    Missing,
    Unauthenticated,
    NotGithub,
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoInfo {
    pub root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
    pub default_branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_branch: Option<String>,
    pub upstream: Option<AheadBehind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_fetched_at: Option<i64>,
    pub gh: GhStatus,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum CheckState {
    Passed,
    Failed,
    Pending,
    Skipped,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    pub name: String,
    pub state: CheckState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details_url: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CheckRollup {
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum PullState {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
    None,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PullSummary {
    pub number: u64,
    pub title: String,
    pub head: String,
    pub base: String,
    pub state: PullState,
    pub author: String,
    pub author_is_viewer: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_by_viewer: Option<bool>,
    pub checks: CheckRollup,
    pub review: ReviewDecision,
    pub changes_requested: u32,
    pub url: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PullFile {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
    pub comments: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    pub body: String,
    pub created_at: i64,
    pub url: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PullDetail {
    #[serde(flatten)]
    pub summary: PullSummary,
    pub additions: u64,
    pub deletions: u64,
    pub files: Vec<PullFile>,
    pub check_runs: Vec<CheckRun>,
    pub comments: Vec<ReviewComment>,
    pub reviewers: Vec<String>,
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestone: Option<String>,
    pub head_sha: String,
    pub mergeable: String, // 'clean' | 'blocked' | 'conflicting' | 'behind' | 'unknown'
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    pub author_is_viewer: bool,
    pub committed_at: i64,
    pub by_agent: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitPage {
    #[serde(rename = "ref")]
    pub ref_: String,
    pub total_count: u64,
    pub commits: Vec<CommitSummary>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SignedState {
    Verified,
    Unverified,
    None,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    #[serde(flatten)]
    pub summary: CommitSummary,
    pub body: String,
    pub parents: Vec<String>,
    pub signed: SignedState,
    pub branches: Vec<String>,
    pub on_default_branch: bool,
    pub files: Vec<CommitFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_file_diff: Option<crate::diff::FileDiff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_runs: Option<Vec<CheckRun>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull_number: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchWorktree {
    pub path: String,
    pub display_path: String,
    pub is_main: bool,
    pub dirty: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchLastCommit {
    pub short_sha: String,
    pub subject: String,
    pub committed_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_default: bool,
    pub is_current: bool,
    pub vs_default: AheadBehind,
    pub merged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<BranchWorktree>,
    pub last_commit: BranchLastCommit,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PruneOutcome {
    pub branch: String,
    pub removed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// ---------- shared pure helpers ----------

/// RFC3339 (gh's timestamp format) -> epoch ms. `None` on anything unparseable.
pub(crate) fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s.trim())
        .ok()
        .map(|t| t.timestamp_millis())
}

/// `basename(path)`, forward- or backslash aware — used when a repo has no
/// remote to derive `GithubRepoInfo.name` from (contract: falls back to
/// `basename(root)`).
pub(crate) fn basename(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_string()
}

/// Every github-page call is scoped by a directory inside a repo
/// (`GithubScope.cwd` — the active project's root, or a session's cwd).
/// Resolves the (possibly-WSL) host, the repo root, and the remote's host
/// (for `gh` status detection) in one place, so every command/child module
/// shares one NOT_A_GIT_REPO check.
pub(crate) fn resolve_scope(cwd: &str) -> Result<(GitHost, String, Option<String>), AppError> {
    let host = GitHost::of(cwd);
    if !is_git_repo(&host, cwd) {
        return Err(AppError::new(ErrorCode::NotAGitRepo, NOT_A_REPO_MSG));
    }
    let root = repo_root(&host, cwd);
    let remote_host = remote_host_of(&host, &root);
    Ok((host, root, remote_host))
}

/// The host segment of the repo's remote URL (`github.com`, a GHE host, …),
/// or `None` when there is no remote or it doesn't parse. Used both by
/// `resolve_scope` (gh status detection) and to build a repo's `owner/name`.
pub(crate) fn remote_host_of(host: &GitHost, root: &str) -> Option<String> {
    remote_owner_name_host(host, root).map(|r| r.2)
}

/// `(owner, name, host)` parsed from the repo's remote URL, when there is one
/// and it parses AND names an owner (a bare `host/repo` remote has none).
pub(crate) fn remote_owner_name_host(
    host: &GitHost,
    root: &str,
) -> Option<(String, String, String)> {
    let remote = remote_name(host, root)?;
    let out = gh::git_routed(host, root, &["remote", "get-url", &remote]);
    if out.code != 0 {
        return None;
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let parsed = repo::parse_remote_url(&url)?;
    Some((parsed.owner?, parsed.name, parsed.host))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rfc3339_ms_reads_a_gh_timestamp() {
        assert_eq!(
            parse_rfc3339_ms("2024-03-05T12:34:56Z"),
            Some(1709642096000)
        );
        assert_eq!(parse_rfc3339_ms("not a date"), None);
    }

    #[test]
    fn basename_handles_both_separators() {
        assert_eq!(basename("D:\\repos\\orbit"), "orbit");
        assert_eq!(basename("/home/u/orbit"), "orbit");
        assert_eq!(basename("orbit"), "orbit");
    }
}
