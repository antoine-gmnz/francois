//! the `francois:github:<verb>` Tauri command surface (contract/github-page.ts).
//! Every command takes a `cwd`-scoped request and resolves an `IpcResult` —
//! domain failures never reject across the bridge (§Conventions).

use super::branches::{do_create_worktree, do_list_branches, do_prune, do_worktree_disk_usage};
use super::commits::{do_get_commit, do_list_commits};
use super::pulls::{do_get_pull, do_list_pulls, do_merge_pull, do_update_pull_branch};
use super::repo::{compute_repo_info, do_fetch};
use super::{
    remote_host_of, resolve_scope, BranchInfo, BranchWorktree, CommitDetail, CommitPage,
    GithubRepoInfo, MergeOutcome, PruneOutcome, PullDetail, PullSummary,
};
use crate::ipc::{err, ok, AppError, ErrorCode, IpcResult};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubScope {
    pub cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubListPullsRequest {
    pub cwd: String,
    #[serde(default)]
    pub limit: Option<u32>,
    /// `"open"` or `"all"` (default).
    #[serde(default)]
    pub state: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubGetPullRequest {
    pub cwd: String,
    pub number: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubMergePullRequest {
    pub cwd: String,
    pub number: u64,
    pub method: String,
    #[serde(default)]
    pub delete_branch: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubListCommitsRequest {
    pub cwd: String,
    #[serde(default, rename = "ref")]
    pub ref_: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubGetCommitRequest {
    pub cwd: String,
    pub sha: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCreateWorktreeRequest {
    pub cwd: String,
    pub branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPruneRequest {
    pub cwd: String,
    pub branches: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubOpenUrlRequest {
    pub cwd: String,
    pub url: String,
}

#[tauri::command(async)]
pub fn github_repo_info(req: GithubScope) -> IpcResult<GithubRepoInfo> {
    compute_repo_info(&req.cwd).into()
}

#[tauri::command(async)]
pub fn github_fetch(req: GithubScope) -> IpcResult<GithubRepoInfo> {
    do_fetch(&req.cwd).into()
}

#[tauri::command(async)]
pub fn github_list_pulls(req: GithubListPullsRequest) -> IpcResult<Vec<PullSummary>> {
    let open_only = req.state.as_deref() == Some("open");
    do_list_pulls(&req.cwd, req.limit.unwrap_or(30), open_only).into()
}

#[tauri::command(async)]
pub fn github_get_pull(req: GithubGetPullRequest) -> IpcResult<PullDetail> {
    do_get_pull(&req.cwd, req.number).into()
}

#[tauri::command(async)]
pub fn github_update_pull_branch(req: GithubGetPullRequest) -> IpcResult<Option<()>> {
    match do_update_pull_branch(&req.cwd, req.number) {
        Ok(()) => ok(None),
        Err(e) => e.into(),
    }
}

#[tauri::command(async)]
pub fn github_merge_pull(req: GithubMergePullRequest) -> IpcResult<MergeOutcome> {
    do_merge_pull(&req.cwd, req.number, &req.method, req.delete_branch).into()
}

#[tauri::command(async)]
pub fn github_list_commits(req: GithubListCommitsRequest) -> IpcResult<CommitPage> {
    do_list_commits(&req.cwd, req.ref_.as_deref(), req.limit.unwrap_or(50)).into()
}

#[tauri::command(async)]
pub fn github_get_commit(req: GithubGetCommitRequest) -> IpcResult<CommitDetail> {
    do_get_commit(&req.cwd, &req.sha).into()
}

#[tauri::command(async)]
pub fn github_list_branches(req: GithubScope) -> IpcResult<Vec<BranchInfo>> {
    do_list_branches(&req.cwd).into()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiskUsage {
    bytes: Option<u64>,
    worktrees: u32,
}

#[tauri::command(async)]
pub fn github_worktree_disk_usage(req: GithubScope) -> IpcResult<WorktreeDiskUsage> {
    match do_worktree_disk_usage(&req.cwd) {
        Ok((bytes, worktrees)) => ok(WorktreeDiskUsage { bytes, worktrees }),
        Err(e) => e.into(),
    }
}

#[tauri::command(async)]
pub fn github_create_worktree(req: GithubCreateWorktreeRequest) -> IpcResult<BranchWorktree> {
    do_create_worktree(&req.cwd, &req.branch).into()
}

#[tauri::command(async)]
pub fn github_prune(req: GithubPruneRequest) -> IpcResult<Vec<PruneOutcome>> {
    do_prune(&req.cwd, &req.branches).into()
}

// ---------- open_url ----------

/// Pure: is `url` an `https://` URL whose host matches `repo_host` exactly?
/// Unit-tested directly.
pub(crate) fn is_allowed_repo_url(url: &str, repo_host: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host_part = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host_part.split(':').next().unwrap_or(host_part);
    !host.is_empty() && host.eq_ignore_ascii_case(repo_host)
}

#[cfg(target_os = "windows")]
fn open_browser(url: &str) -> std::io::Result<()> {
    crate::process_util::spawn("cmd")
        .args(["/c", "start", "", url])
        .start()
        .map(|_| ())
}
#[cfg(target_os = "macos")]
fn open_browser(url: &str) -> std::io::Result<()> {
    crate::process_util::spawn("open")
        .arg(url)
        .start()
        .map(|_| ())
}
#[cfg(all(unix, not(target_os = "macos")))]
fn open_browser(url: &str) -> std::io::Result<()> {
    crate::process_util::spawn("xdg-open")
        .arg(url)
        .start()
        .map(|_| ())
}

fn do_open_url(cwd: &str, url: &str) -> Result<(), AppError> {
    let (host, root, _) = resolve_scope(cwd)?;
    let Some(repo_host) = remote_host_of(&host, &root) else {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "this repository has no remote",
        ));
    };
    if !is_allowed_repo_url(url, &repo_host) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "url must be an https URL on the repository's remote host",
        ));
    }
    open_browser(url)
        .map_err(|e| AppError::new(ErrorCode::Internal, format!("could not open browser: {e}")))
}

#[tauri::command(async)]
pub fn github_open_url(req: GithubOpenUrlRequest) -> IpcResult<Option<()>> {
    match do_open_url(&req.cwd, &req.url) {
        Ok(()) => ok(None),
        Err(e) => err(e.code, e.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_an_https_url_on_the_repo_host() {
        assert!(is_allowed_repo_url(
            "https://github.com/o/r/pull/1",
            "github.com"
        ));
        assert!(is_allowed_repo_url(
            "https://github.example.com/o/r/pull/1",
            "github.example.com"
        ));
    }

    #[test]
    fn rejects_a_mismatched_host_or_scheme() {
        assert!(!is_allowed_repo_url("http://github.com/o/r", "github.com"));
        assert!(!is_allowed_repo_url(
            "https://evil.example/o/r",
            "github.com"
        ));
        assert!(!is_allowed_repo_url(
            "https://github.com.evil.com/x",
            "github.com"
        ));
        assert!(!is_allowed_repo_url("javascript:alert(1)", "github.com"));
    }
}
