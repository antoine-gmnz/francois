//! remote URL parsing, `github_repo_info` and `github_fetch`.

use super::gh::git_routed;
use super::{basename, resolve_scope, AheadBehind, GithubRepoInfo};
use crate::diff::GitHost;
use crate::ipc::AppError;
use crate::session::worktree::git::{
    current_branch, default_branch, fetch_with_timeout, remote_name,
};
use crate::wsl;

/// One parsed git remote URL: owner (absent for a host with no owner segment,
/// e.g. a bare `host/repo`), repo name, host, and the `https://` web URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteInfo {
    pub owner: Option<String>,
    pub name: String,
    pub host: String,
    pub web_url: String,
}

/// Parses `git@host:owner/repo.git` (scp-like), `ssh://[user@]host[:port]/owner/repo`,
/// and `https://[user@]host/owner/repo` into `RemoteInfo`. Pure — unit-tested against
/// all three forms git actually produces (`git remote get-url`).
pub(crate) fn parse_remote_url(url: &str) -> Option<RemoteInfo> {
    let url = url.trim();
    if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        let rest = rest.rsplit('@').next().unwrap_or(rest);
        let mut parts = rest.splitn(2, '/');
        let host = parts.next()?.to_string();
        return path_to_remote(host, parts.next().unwrap_or(""));
    }
    if let Some(rest) = url.strip_prefix("ssh://") {
        let rest = rest.rsplit('@').next().unwrap_or(rest);
        let mut parts = rest.splitn(2, '/');
        let host_port = parts.next()?;
        let host = host_port.split(':').next().unwrap_or(host_port).to_string();
        return path_to_remote(host, parts.next().unwrap_or(""));
    }
    // scp-like `[user@]host:path` — only when the colon comes before any '/'
    // (so an absolute local path like `/repo` or a Windows drive-letter path
    // like `D:\repo` never gets mistaken for one).
    if let Some(colon) = url.find(':') {
        if !url[..colon].contains('/') && !url[..colon].contains('\\') && colon > 1 {
            let host = url[..colon]
                .rsplit('@')
                .next()
                .unwrap_or(&url[..colon])
                .to_string();
            return path_to_remote(host, &url[colon + 1..]);
        }
    }
    None
}

fn path_to_remote(host: String, path: &str) -> Option<RemoteInfo> {
    if host.is_empty() {
        return None;
    }
    let path = path
        .trim_start_matches('/')
        .trim_end_matches(".git")
        .trim_end_matches('/');
    if path.is_empty() {
        return None;
    }
    let mut segs = path.rsplitn(2, '/');
    let name = segs.next()?.to_string();
    let owner = segs.next().map(str::to_string);
    if name.is_empty() {
        return None;
    }
    Some(RemoteInfo {
        web_url: format!("https://{host}/{path}"),
        owner,
        name,
        host,
    })
}

fn remote_get_url(host: &GitHost, root: &str, remote: &str) -> Option<String> {
    let out = git_routed(host, root, &["remote", "get-url", remote]);
    if out.code != 0 {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn upstream_ahead_behind(host: &GitHost, root: &str) -> Option<AheadBehind> {
    let out = git_routed(
        host,
        root,
        &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
    );
    if out.code != 0 {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.split_whitespace();
    let behind = parts.next()?.parse().ok()?;
    let ahead = parts.next()?.parse().ok()?;
    Some(AheadBehind { ahead, behind })
}

/// `mtime(.git/FETCH_HEAD)` in epoch ms — `None` when never fetched, or the
/// file cannot be resolved (a Wsl repo whose UNC root couldn't be derived).
fn fetch_head_mtime(host: &GitHost, root: &str) -> Option<i64> {
    let target = format!("{root}/.git/FETCH_HEAD");
    let path = match host {
        GitHost::Native => std::path::PathBuf::from(&target),
        GitHost::Wsl(distro) => {
            std::path::PathBuf::from(wsl::linux_to_wsl_unc(Some(distro), &target)?)
        }
    };
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(dur.as_millis() as i64)
}

pub(crate) fn compute_repo_info(cwd: &str) -> Result<GithubRepoInfo, AppError> {
    let (host, root, _) = resolve_scope(cwd)?;
    let remote = remote_name(&host, &root);
    let parsed = remote
        .as_deref()
        .and_then(|r| remote_get_url(&host, &root, r))
        .as_deref()
        .and_then(parse_remote_url);

    let default = default_branch(&host, &root, remote.as_deref());
    let current = current_branch(&host, &root);
    let name = parsed
        .as_ref()
        .map(|p| p.name.clone())
        .unwrap_or_else(|| basename(&root));
    let remote_host = parsed.as_ref().map(|p| p.host.clone());

    let gh = super::gh::gh_status_cached(&host, &root, remote_host.as_deref());
    let upstream = current
        .as_ref()
        .and_then(|_| upstream_ahead_behind(&host, &root));
    let last_fetched_at = fetch_head_mtime(&host, &root);

    Ok(GithubRepoInfo {
        root,
        owner: parsed.as_ref().and_then(|p| p.owner.clone()),
        name,
        remote_name: remote,
        remote_host,
        web_url: parsed.as_ref().map(|p| p.web_url.clone()),
        default_branch: default,
        upstream,
        current_branch: current,
        last_fetched_at,
        gh,
    })
}

pub(crate) fn do_fetch(cwd: &str) -> Result<GithubRepoInfo, AppError> {
    let (host, root, _) = resolve_scope(cwd)?;
    if let Some(remote) = remote_name(&host, &root) {
        fetch_with_timeout(&host, &root, &remote)?;
    }
    compute_repo_info(cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_scp_like_ssh_remote() {
        let r = parse_remote_url("git@github.com:antoine-gmnz/francois.git").unwrap();
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner.as_deref(), Some("antoine-gmnz"));
        assert_eq!(r.name, "francois");
        assert_eq!(r.web_url, "https://github.com/antoine-gmnz/francois");
    }

    #[test]
    fn parses_ssh_scheme_remote() {
        let r = parse_remote_url("ssh://git@github.com/antoine-gmnz/francois.git").unwrap();
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner.as_deref(), Some("antoine-gmnz"));
        assert_eq!(r.name, "francois");
    }

    #[test]
    fn parses_https_remote() {
        let r = parse_remote_url("https://github.com/antoine-gmnz/francois.git").unwrap();
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner.as_deref(), Some("antoine-gmnz"));
        assert_eq!(r.name, "francois");
        assert_eq!(r.web_url, "https://github.com/antoine-gmnz/francois");
    }

    #[test]
    fn parses_https_remote_with_embedded_credentials() {
        let r = parse_remote_url("https://x-access-token:tok@github.com/o/r.git").unwrap();
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner.as_deref(), Some("o"));
        assert_eq!(r.name, "r");
    }

    #[test]
    fn parses_a_ghe_host() {
        let r = parse_remote_url("git@github.example.com:team/repo.git").unwrap();
        assert_eq!(r.host, "github.example.com");
        assert_eq!(r.owner.as_deref(), Some("team"));
    }

    #[test]
    fn rejects_a_windows_drive_path_as_scp_like() {
        // A local path remote (`git remote add x D:\repo`) must not be parsed
        // as `user 'D' at host ':'` — the colon guard requires no backslash
        // before it either.
        assert_eq!(parse_remote_url("D:\\repo"), None);
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_remote_url(""), None);
        assert_eq!(parse_remote_url("not a url"), None);
    }
}
