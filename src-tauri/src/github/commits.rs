//! `github_list_commits` / `github_get_commit` — `git log` parsed with a
//! NUL/unit-separator format, plus (best-effort, gh-gated) check runs and the
//! owning PR number on the detail call.

use super::actions::fetch_actions_check_runs;
use super::gh::{gh_json, gh_status_cached, git_routed};
use super::{
    remote_owner_name_host, resolve_scope, CheckRun, CommitDetail, CommitFile, CommitPage,
    CommitSummary, GhStatus, SignedState,
};
use crate::diff::GitHost;
use crate::ipc::{AppError, ErrorCode};
use crate::session::worktree::git::{default_branch, remote_name};
use serde::Deserialize;

/// `%H` full sha, `%h` short sha, `%s` subject, `%an` author name, `%ae`
/// author email, `%ct` committer epoch seconds, then every `Co-Authored-By`
/// trailer value joined with `\x1d` (never `\n` — a trailer value is never
/// expected to carry one, and this keeps the whole commit on one `\x1f`-joined
/// record). Each record ends with `\x00`.
const LOG_FORMAT: &str = "%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%ct%x1f%(trailers:key=Co-Authored-By,valueonly,separator=%x1d)%x00";

fn git_config_user_email(host: &GitHost, root: &str) -> Option<String> {
    let out = git_routed(host, root, &["config", "--get", "user.email"]);
    if out.code != 0 {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Pure: parses `LOG_FORMAT`'s output into `CommitSummary`s. Unit-tested
/// directly against a hand-built buffer — no live git spawn needed.
pub(crate) fn parse_commit_log(data: &[u8], viewer_email: Option<&str>) -> Vec<CommitSummary> {
    let text = String::from_utf8_lossy(data);
    text.split('\0')
        .map(|rec| rec.trim_start_matches('\n'))
        .filter(|rec| !rec.is_empty())
        .map(|rec| {
            let mut f = rec.split('\u{1f}');
            let sha = f.next().unwrap_or("").to_string();
            let short_sha = f.next().unwrap_or("").to_string();
            let subject = f.next().unwrap_or("").to_string();
            let author = f.next().unwrap_or("").to_string();
            let email = f.next().unwrap_or("");
            let ts: i64 = f.next().unwrap_or("0").trim().parse().unwrap_or(0);
            let coauthors = f.next().unwrap_or("");
            let by_agent = coauthors
                .split('\u{1d}')
                .any(|c| c.to_lowercase().contains("claude"));
            let author_is_viewer = viewer_email
                .map(|v| v.eq_ignore_ascii_case(email))
                .unwrap_or(false);
            CommitSummary {
                sha,
                short_sha,
                subject,
                author,
                author_is_viewer,
                committed_at: ts * 1000,
                by_agent,
            }
        })
        .collect()
}

pub(crate) fn do_list_commits(
    cwd: &str,
    req_ref: Option<&str>,
    limit: u32,
) -> Result<CommitPage, AppError> {
    let (host, root, _) = resolve_scope(cwd)?;
    let remote = remote_name(&host, &root);
    let default = default_branch(&host, &root, remote.as_deref());
    let r = req_ref
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&default)
        .to_string();
    if r.starts_with('-') {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "ref must not start with '-'",
        ));
    }
    let limit = limit.clamp(1, 200).to_string();
    let viewer_email = git_config_user_email(&host, &root);
    let format_arg = format!("--format={LOG_FORMAT}");
    let out = git_routed(&host, &root, &["log", &r, "-n", &limit, &format_arg]);
    if out.code != 0 {
        return Err(AppError::new(
            ErrorCode::GitError,
            if out.stderr.is_empty() {
                "git log failed".to_string()
            } else {
                out.stderr
            },
        ));
    }
    let commits = parse_commit_log(&out.stdout, viewer_email.as_deref());

    let total_out = git_routed(&host, &root, &["rev-list", "--count", &r]);
    let total_count = if total_out.code == 0 {
        String::from_utf8_lossy(&total_out.stdout)
            .trim()
            .parse()
            .unwrap_or(commits.len() as u64)
    } else {
        commits.len() as u64
    };

    Ok(CommitPage {
        ref_: r,
        total_count,
        commits,
    })
}

fn parse_numstat_files(data: &[u8]) -> Vec<CommitFile> {
    let text = String::from_utf8_lossy(data);
    let mut files: Vec<CommitFile> = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let add = parts.next()?;
            let del = parts.next()?;
            let path = parts.next()?;
            if path.is_empty() {
                return None;
            }
            Some(CommitFile {
                path: path.to_string(),
                additions: if add == "-" {
                    0
                } else {
                    add.parse().unwrap_or(0)
                },
                deletions: if del == "-" {
                    0
                } else {
                    del.parse().unwrap_or(0)
                },
            })
        })
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.additions + f.deletions));
    files
}

fn map_signed(code: &str) -> SignedState {
    match code.trim() {
        "G" => SignedState::Verified,
        "N" => SignedState::None,
        _ => SignedState::Unverified,
    }
}

fn fetch_check_runs(
    host: &GitHost,
    root: &str,
    owner: &str,
    name: &str,
    sha: &str,
) -> Option<Vec<CheckRun>> {
    fetch_actions_check_runs(host, root, owner, name, sha).ok()
}

#[derive(Deserialize)]
struct GhSearchedPr {
    number: u64,
}

fn fetch_pull_number(host: &GitHost, root: &str, sha: &str) -> Option<u64> {
    let items: Vec<GhSearchedPr> = gh_json(
        host,
        root,
        &[
            "pr", "list", "--search", sha, "--state", "all", "--json", "number", "--limit", "1",
        ],
    )
    .ok()?;
    items.first().map(|p| p.number)
}

pub(crate) fn do_get_commit(cwd: &str, sha: &str) -> Result<CommitDetail, AppError> {
    if sha.trim().is_empty() || sha.starts_with('-') {
        return Err(AppError::new(ErrorCode::InvalidInput, "sha is invalid"));
    }
    let (host, root, remote_host) = resolve_scope(cwd)?;
    let viewer_email = git_config_user_email(&host, &root);
    let format_arg = format!("--format={LOG_FORMAT}");
    let out = git_routed(&host, &root, &["log", "-1", sha, &format_arg]);
    if out.code != 0 {
        return Err(AppError::new(ErrorCode::GitError, "no such commit"));
    }
    let Some(summary) = parse_commit_log(&out.stdout, viewer_email.as_deref())
        .into_iter()
        .next()
    else {
        return Err(AppError::new(ErrorCode::GitError, "no such commit"));
    };

    let body_out = git_routed(&host, &root, &["log", "-1", "--format=%b", sha]);
    let body = String::from_utf8_lossy(&body_out.stdout)
        .trim_end()
        .to_string();

    let parents_out = git_routed(&host, &root, &["log", "-1", "--format=%P", sha]);
    let parents: Vec<String> = String::from_utf8_lossy(&parents_out.stdout)
        .split_whitespace()
        .map(|p| p.chars().take(7).collect())
        .collect();

    let sig_out = git_routed(&host, &root, &["log", "-1", "--format=%G?", sha]);
    let signed = map_signed(&String::from_utf8_lossy(&sig_out.stdout));

    let remote = remote_name(&host, &root);
    let default = default_branch(&host, &root, remote.as_deref());
    let br_out = git_routed(
        &host,
        &root,
        &["branch", "--contains", sha, "--format=%(refname:short)"],
    );
    let mut branches: Vec<String> = String::from_utf8_lossy(&br_out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let on_default_branch = branches.iter().any(|b| b == &default);
    branches.sort_by_key(|b| if b == &default { 0 } else { 1 });

    let numstat_out = git_routed(&host, &root, &["show", "--numstat", "--format=", sha]);
    let files = parse_numstat_files(&numstat_out.stdout);

    let first_file_diff = files.first().map(|f| {
        let patch_out = git_routed(&host, &root, &["show", sha, "--", &f.path]);
        crate::diff::file_diff_from_patch(&String::from_utf8_lossy(&patch_out.stdout))
    });

    let gh_ok = gh_status_cached(&host, &root, remote_host.as_deref()) == GhStatus::Ok;
    let (check_runs, pull_number) = if gh_ok {
        match remote_owner_name_host(&host, &root) {
            Some((owner, name, _)) => (
                fetch_check_runs(&host, &root, &owner, &name, &summary.sha),
                fetch_pull_number(&host, &root, &summary.sha),
            ),
            None => (None, None),
        }
    } else {
        (None, None)
    };

    Ok(CommitDetail {
        summary,
        body,
        parents,
        signed,
        branches,
        on_default_branch,
        files,
        first_file_diff,
        check_runs,
        pull_number,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(fields: &[&str]) -> String {
        format!("{}\0", fields.join("\u{1f}"))
    }

    #[test]
    fn parses_a_single_record() {
        let data = rec(&[
            "abc123full",
            "abc123",
            "fix: retry",
            "Alice",
            "alice@example.com",
            "1700000000",
            "",
        ]);
        let commits = parse_commit_log(data.as_bytes(), Some("alice@example.com"));
        assert_eq!(commits.len(), 1);
        let c = &commits[0];
        assert_eq!(c.sha, "abc123full");
        assert_eq!(c.short_sha, "abc123");
        assert_eq!(c.subject, "fix: retry");
        assert_eq!(c.author, "Alice");
        assert!(c.author_is_viewer);
        assert_eq!(c.committed_at, 1700000000000);
        assert!(!c.by_agent);
    }

    #[test]
    fn detects_a_claude_coauthor_trailer_case_insensitively() {
        let data = rec(&[
            "s",
            "s",
            "subject",
            "Bot",
            "bot@example.com",
            "0",
            "Claude <noreply@anthropic.com>",
        ]);
        let commits = parse_commit_log(data.as_bytes(), None);
        assert!(commits[0].by_agent);
    }

    #[test]
    fn multiple_records_split_on_nul_and_leading_newline_is_trimmed() {
        let data = format!(
            "{}\n{}",
            rec(&["a", "a", "one", "A", "a@x.com", "0", ""]),
            rec(&["b", "b", "two", "B", "b@x.com", "0", ""])
        );
        let commits = parse_commit_log(data.as_bytes(), None);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].sha, "a");
        assert_eq!(commits[1].sha, "b");
    }

    #[test]
    fn numstat_files_sort_by_churn_desc_and_treat_dash_as_zero() {
        let data = b"1\t1\ta.txt\n10\t0\tb.txt\n-\t-\tbin.dat\n";
        let files = parse_numstat_files(data);
        assert_eq!(files[0].path, "b.txt");
        assert_eq!(files[1].path, "a.txt");
        assert_eq!(files[2].path, "bin.dat");
        assert_eq!(files[2].additions, 0);
        assert_eq!(files[2].deletions, 0);
    }

    #[test]
    fn maps_signed_codes() {
        assert_eq!(map_signed("G"), SignedState::Verified);
        assert_eq!(map_signed("N"), SignedState::None);
        assert_eq!(map_signed("B"), SignedState::Unverified);
        assert_eq!(map_signed("U"), SignedState::Unverified);
    }
}
