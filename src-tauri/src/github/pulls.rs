//! `github_list_pulls` / `github_get_pull` / `github_update_pull_branch` — PR
//! data from `gh pr list`/`gh pr view`, mapped into the contract's
//! `PullSummary`/`PullDetail`. JSON -> contract mapping stays in small pure
//! functions, unit-tested against captured sample JSON.

use super::gh::{gh_failed, gh_json, gh_routed, gh_status_cached, gh_unavailable};
use super::{
    parse_rfc3339_ms, remote_owner_name_host, resolve_scope, CheckRollup, CheckRun, CheckState,
    GhStatus, PullDetail, PullFile, PullState, PullSummary, ReviewComment, ReviewDecision,
};
use crate::diff::GitHost;
use crate::ipc::AppError;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const LIST_FIELDS: &str = "number,title,headRefName,baseRefName,state,isDraft,author,createdAt,updatedAt,mergedAt,mergedBy,statusCheckRollup,reviewDecision,latestReviews,url";
const VIEW_FIELDS: &str = "number,title,headRefName,baseRefName,state,isDraft,author,createdAt,updatedAt,mergedAt,mergedBy,statusCheckRollup,reviewDecision,latestReviews,url,additions,deletions,files,reviewRequests,labels,milestone,headRefOid,mergeable,mergeStateStatus";

// ---------- gh JSON shapes ----------

#[derive(Deserialize, Clone, Debug)]
struct GhUser {
    login: String,
}

#[derive(Deserialize, Clone, Debug)]
struct GhLabel {
    name: String,
}

#[derive(Deserialize, Clone, Debug)]
struct GhMilestone {
    title: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
struct GhCheckItem {
    name: Option<String>,
    context: Option<String>,
    conclusion: Option<String>,
    status: Option<String>,
    state: Option<String>,
    #[serde(rename = "startedAt")]
    started_at: Option<String>,
    #[serde(rename = "completedAt")]
    completed_at: Option<String>,
    #[serde(rename = "detailsUrl")]
    details_url: Option<String>,
    #[serde(rename = "targetUrl")]
    target_url: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
struct GhReview {
    author: Option<GhUser>,
    state: String,
    body: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
struct GhReviewRequest {
    login: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
struct GhFile {
    path: String,
    additions: u64,
    deletions: u64,
}

#[derive(Deserialize, Clone, Debug)]
struct GhPr {
    number: u64,
    title: String,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    #[serde(rename = "baseRefName")]
    base_ref_name: String,
    state: String,
    #[serde(rename = "isDraft", default)]
    is_draft: bool,
    author: Option<GhUser>,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "mergedAt")]
    merged_at: Option<String>,
    #[serde(rename = "mergedBy")]
    merged_by: Option<GhUser>,
    #[serde(rename = "statusCheckRollup", default)]
    status_check_rollup: Vec<GhCheckItem>,
    #[serde(rename = "reviewDecision")]
    review_decision: Option<String>,
    #[serde(rename = "latestReviews", default)]
    latest_reviews: Vec<GhReview>,
    url: String,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default)]
    files: Vec<GhFile>,
    #[serde(rename = "reviewRequests", default)]
    review_requests: Vec<GhReviewRequest>,
    #[serde(default)]
    labels: Vec<GhLabel>,
    milestone: Option<GhMilestone>,
    #[serde(rename = "headRefOid")]
    head_ref_oid: Option<String>,
    mergeable: Option<String>,
    #[serde(rename = "mergeStateStatus")]
    merge_state_status: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
struct GhInlineComment {
    user: Option<GhUser>,
    path: Option<String>,
    line: Option<i64>,
    original_line: Option<i64>,
    body: String,
    created_at: String,
    html_url: String,
}

// ---------- pure JSON -> contract mapping ----------

fn item_check_state(item: &GhCheckItem) -> CheckState {
    if let Some(state) = &item.state {
        return match state.as_str() {
            "SUCCESS" => CheckState::Passed,
            "PENDING" => CheckState::Pending,
            "ERROR" | "FAILURE" => CheckState::Failed,
            _ => CheckState::Pending,
        };
    }
    match item.status.as_deref() {
        Some("COMPLETED") => match item.conclusion.as_deref() {
            Some("SUCCESS") | Some("NEUTRAL") => CheckState::Passed,
            Some("SKIPPED") => CheckState::Skipped,
            Some("FAILURE")
            | Some("CANCELLED")
            | Some("TIMED_OUT")
            | Some("ACTION_REQUIRED")
            | Some("STARTUP_FAILURE") => CheckState::Failed,
            _ => CheckState::Pending,
        },
        _ => CheckState::Pending,
    }
}

fn check_rollup(items: &[GhCheckItem]) -> CheckRollup {
    let mut r = CheckRollup::default();
    for item in items {
        r.total += 1;
        match item_check_state(item) {
            CheckState::Passed | CheckState::Skipped => r.passed += 1,
            CheckState::Failed => r.failed += 1,
            CheckState::Pending => r.pending += 1,
        }
    }
    r
}

fn map_check_runs(items: &[GhCheckItem]) -> Vec<CheckRun> {
    items
        .iter()
        .map(|item| {
            let duration_ms = match (&item.started_at, &item.completed_at) {
                (Some(s), Some(c)) => match (parse_rfc3339_ms(s), parse_rfc3339_ms(c)) {
                    (Some(s), Some(c)) if c >= s => Some((c - s) as u64),
                    _ => None,
                },
                _ => None,
            };
            CheckRun {
                name: item
                    .name
                    .clone()
                    .or_else(|| item.context.clone())
                    .unwrap_or_default(),
                state: item_check_state(item),
                duration_ms,
                summary: None,
                details_url: item.details_url.clone().or_else(|| item.target_url.clone()),
            }
        })
        .collect()
}

fn review_decision(s: Option<&str>) -> ReviewDecision {
    match s {
        Some("APPROVED") => ReviewDecision::Approved,
        Some("CHANGES_REQUESTED") => ReviewDecision::ChangesRequested,
        Some("REVIEW_REQUIRED") => ReviewDecision::ReviewRequired,
        _ => ReviewDecision::None,
    }
}

fn pull_state(state: &str, is_draft: bool) -> PullState {
    match state {
        "MERGED" => PullState::Merged,
        "CLOSED" => PullState::Closed,
        _ if is_draft => PullState::Draft,
        _ => PullState::Open,
    }
}

/// gh's `mergeStateStatus`/`mergeable` -> the contract's flattened enum.
fn map_mergeable(mergeable: Option<&str>, merge_state: Option<&str>) -> String {
    if mergeable == Some("CONFLICTING") {
        return "conflicting".to_string();
    }
    match merge_state {
        Some("CLEAN") => "clean",
        Some("BEHIND") => "behind",
        Some("DIRTY") => "conflicting",
        Some("BLOCKED") | Some("UNSTABLE") | Some("DRAFT") | Some("HAS_HOOKS") => "blocked",
        _ => "unknown",
    }
    .to_string()
}

fn map_pull_summary(pr: &GhPr, viewer: Option<&str>) -> PullSummary {
    let author = pr
        .author
        .as_ref()
        .map(|a| a.login.clone())
        .unwrap_or_default();
    let author_is_viewer = viewer.map(|v| v == author).unwrap_or(false);
    let merged_by = pr.merged_by.as_ref().map(|u| u.login.clone());
    let merged_by_viewer = merged_by.as_deref().zip(viewer).map(|(a, b)| a == b);
    let changes_requested = pr
        .latest_reviews
        .iter()
        .filter(|r| r.state == "CHANGES_REQUESTED")
        .count() as u32;
    PullSummary {
        number: pr.number,
        title: pr.title.clone(),
        head: pr.head_ref_name.clone(),
        base: pr.base_ref_name.clone(),
        state: pull_state(&pr.state, pr.is_draft),
        author,
        author_is_viewer,
        created_at: parse_rfc3339_ms(&pr.created_at).unwrap_or(0),
        updated_at: parse_rfc3339_ms(&pr.updated_at).unwrap_or(0),
        merged_at: pr.merged_at.as_deref().and_then(parse_rfc3339_ms),
        merged_by,
        merged_by_viewer,
        checks: check_rollup(&pr.status_check_rollup),
        review: review_decision(pr.review_decision.as_deref()),
        changes_requested,
        url: pr.url.clone(),
    }
}

/// Open + draft first by `updatedAt` desc, then merged/closed by their date
/// (mergedAt, falling back to updatedAt) desc.
fn sort_pulls(pulls: &mut [PullSummary]) {
    pulls.sort_by_key(|p| {
        let open = matches!(p.state, PullState::Open | PullState::Draft);
        if open {
            (0u8, -p.updated_at)
        } else {
            (1u8, -p.merged_at.unwrap_or(p.updated_at))
        }
    });
}

fn map_inline_comments(items: &[GhInlineComment]) -> Vec<ReviewComment> {
    items
        .iter()
        .map(|c| ReviewComment {
            author: c.user.as_ref().map(|u| u.login.clone()).unwrap_or_default(),
            path: c.path.clone(),
            line: c
                .line
                .or(c.original_line)
                .and_then(|l| u64::try_from(l).ok()),
            body: c.body.clone(),
            created_at: parse_rfc3339_ms(&c.created_at).unwrap_or(0),
            url: c.html_url.clone(),
        })
        .collect()
}

fn map_pull_detail(
    pr: &GhPr,
    viewer: Option<&str>,
    inline_comments: Vec<ReviewComment>,
) -> PullDetail {
    let summary = map_pull_summary(pr, viewer);
    let mut files: Vec<PullFile> = pr
        .files
        .iter()
        .map(|f| PullFile {
            path: f.path.clone(),
            additions: f.additions,
            deletions: f.deletions,
            comments: 0,
        })
        .collect();
    files.sort_by(|a, b| (b.additions + b.deletions).cmp(&(a.additions + a.deletions)));

    let mut comments = inline_comments;
    // CHANGES_REQUESTED review bodies join the unresolved comment list (FR-5).
    // A review carries no timestamp on `gh pr view`'s JSON — the PR's own
    // updatedAt is the best available ordering anchor.
    for review in &pr.latest_reviews {
        if review.state != "CHANGES_REQUESTED" {
            continue;
        }
        let Some(body) = review.body.as_ref().filter(|b| !b.trim().is_empty()) else {
            continue;
        };
        comments.push(ReviewComment {
            author: review
                .author
                .as_ref()
                .map(|u| u.login.clone())
                .unwrap_or_default(),
            path: None,
            line: None,
            body: body.clone(),
            created_at: summary.updated_at,
            url: pr.url.clone(),
        });
    }
    comments.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    for c in &comments {
        if let Some(p) = &c.path {
            if let Some(f) = files.iter_mut().find(|f| &f.path == p) {
                f.comments += 1;
            }
        }
    }

    let reviewers: Vec<String> = pr
        .review_requests
        .iter()
        .filter_map(|r| r.login.clone())
        .map(|login| {
            if viewer == Some(login.as_str()) {
                "you".to_string()
            } else {
                login
            }
        })
        .collect();

    PullDetail {
        additions: pr.additions,
        deletions: pr.deletions,
        files,
        check_runs: map_check_runs(&pr.status_check_rollup),
        comments,
        reviewers,
        labels: pr.labels.iter().map(|l| l.name.clone()).collect(),
        milestone: pr.milestone.as_ref().map(|m| m.title.clone()),
        head_sha: pr
            .head_ref_oid
            .as_deref()
            .map(|s| s.chars().take(7).collect())
            .unwrap_or_default(),
        mergeable: map_mergeable(pr.mergeable.as_deref(), pr.merge_state_status.as_deref()),
        summary,
    }
}

// ---------- viewer login cache ----------

static VIEWER_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn viewer_login(host: &GitHost, root: &str) -> Option<String> {
    let cache = VIEWER_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(v) = cache.lock().unwrap().get(root) {
        return Some(v.clone());
    }
    let out = gh_routed(host, root, &["api", "user", "--jq", ".login"]);
    if out.code != 0 {
        return None;
    }
    let login = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if login.is_empty() {
        return None;
    }
    cache
        .lock()
        .unwrap()
        .insert(root.to_string(), login.clone());
    Some(login)
}

fn require_gh(host: &GitHost, root: &str, remote_host: Option<&str>) -> Result<(), AppError> {
    let status = gh_status_cached(host, root, remote_host);
    if status != GhStatus::Ok {
        return Err(gh_unavailable(status));
    }
    Ok(())
}

// ---------- commands' impls ----------

pub(crate) fn do_list_pulls(cwd: &str, limit: u32) -> Result<Vec<PullSummary>, AppError> {
    let (host, root, remote_host) = resolve_scope(cwd)?;
    require_gh(&host, &root, remote_host.as_deref())?;
    let limit = limit.clamp(1, 100);
    let prs: Vec<GhPr> = gh_json(
        &host,
        &root,
        &[
            "pr",
            "list",
            "--state",
            "all",
            "--limit",
            &limit.to_string(),
            "--json",
            LIST_FIELDS,
        ],
    )?;
    let viewer = viewer_login(&host, &root);
    let mut summaries: Vec<PullSummary> = prs
        .iter()
        .map(|pr| map_pull_summary(pr, viewer.as_deref()))
        .collect();
    sort_pulls(&mut summaries);
    Ok(summaries)
}

pub(crate) fn do_get_pull(cwd: &str, number: u64) -> Result<PullDetail, AppError> {
    let (host, root, remote_host) = resolve_scope(cwd)?;
    require_gh(&host, &root, remote_host.as_deref())?;
    let pr: GhPr = gh_json(
        &host,
        &root,
        &["pr", "view", &number.to_string(), "--json", VIEW_FIELDS],
    )?;
    let viewer = viewer_login(&host, &root);

    let inline_comments = match remote_owner_name_host(&host, &root) {
        Some((owner, name, _)) => {
            let path = format!("repos/{owner}/{name}/pulls/{number}/comments");
            match gh_json::<Vec<GhInlineComment>>(&host, &root, &["api", &path]) {
                Ok(items) => map_inline_comments(&items),
                Err(_) => Vec::new(),
            }
        }
        None => Vec::new(),
    };

    Ok(map_pull_detail(&pr, viewer.as_deref(), inline_comments))
}

pub(crate) fn do_update_pull_branch(cwd: &str, number: u64) -> Result<(), AppError> {
    let (host, root, remote_host) = resolve_scope(cwd)?;
    require_gh(&host, &root, remote_host.as_deref())?;
    let out = gh_routed(&host, &root, &["pr", "update-branch", &number.to_string()]);
    if out.code != 0 {
        return Err(gh_failed(&out));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_pr(json: &str) -> GhPr {
        serde_json::from_str(json).expect("valid sample PR JSON")
    }

    #[test]
    fn maps_an_open_pr_with_passing_checks() {
        let pr = sample_pr(
            r#"{
                "number": 42, "title": "Add retry", "headRefName": "feat/retry",
                "baseRefName": "main", "state": "OPEN", "isDraft": false,
                "author": {"login": "alice"}, "createdAt": "2024-03-01T10:00:00Z",
                "updatedAt": "2024-03-02T10:00:00Z", "mergedAt": null, "mergedBy": null,
                "statusCheckRollup": [
                    {"name": "unit tests", "status": "COMPLETED", "conclusion": "SUCCESS"},
                    {"name": "lint", "status": "COMPLETED", "conclusion": "FAILURE"}
                ],
                "reviewDecision": "CHANGES_REQUESTED",
                "latestReviews": [{"author": {"login": "bob"}, "state": "CHANGES_REQUESTED", "body": "please fix"}],
                "url": "https://github.com/o/r/pull/42"
            }"#,
        );
        let s = map_pull_summary(&pr, Some("alice"));
        assert_eq!(s.state, PullState::Open);
        assert!(s.author_is_viewer);
        assert_eq!(s.checks.total, 2);
        assert_eq!(s.checks.passed, 1);
        assert_eq!(s.checks.failed, 1);
        assert_eq!(s.review, ReviewDecision::ChangesRequested);
        assert_eq!(s.changes_requested, 1);
    }

    #[test]
    fn maps_a_draft_pr() {
        let pr = sample_pr(
            r#"{
                "number": 7, "title": "wip", "headRefName": "wip", "baseRefName": "main",
                "state": "OPEN", "isDraft": true, "author": null,
                "createdAt": "2024-01-01T00:00:00Z", "updatedAt": "2024-01-01T00:00:00Z",
                "url": "https://github.com/o/r/pull/7"
            }"#,
        );
        assert_eq!(pull_state(&pr.state, pr.is_draft), PullState::Draft);
    }

    #[test]
    fn maps_a_merged_pr_by_the_viewer() {
        let pr = sample_pr(
            r#"{
                "number": 1, "title": "t", "headRefName": "h", "baseRefName": "main",
                "state": "MERGED", "isDraft": false, "author": {"login": "alice"},
                "createdAt": "2024-01-01T00:00:00Z", "updatedAt": "2024-01-02T00:00:00Z",
                "mergedAt": "2024-01-03T00:00:00Z", "mergedBy": {"login": "alice"},
                "url": "https://github.com/o/r/pull/1"
            }"#,
        );
        let s = map_pull_summary(&pr, Some("alice"));
        assert_eq!(s.state, PullState::Merged);
        assert_eq!(s.merged_by.as_deref(), Some("alice"));
        assert_eq!(s.merged_by_viewer, Some(true));
    }

    #[test]
    fn sorts_open_pulls_before_merged_by_their_own_dates() {
        let older_open = PullSummary {
            number: 1,
            title: "a".into(),
            head: "h".into(),
            base: "main".into(),
            state: PullState::Open,
            author: "a".into(),
            author_is_viewer: false,
            created_at: 0,
            updated_at: 100,
            merged_at: None,
            merged_by: None,
            merged_by_viewer: None,
            checks: CheckRollup::default(),
            review: ReviewDecision::None,
            changes_requested: 0,
            url: "u".into(),
        };
        let newer_open = PullSummary {
            updated_at: 200,
            ..older_open.clone()
        };
        let merged = PullSummary {
            state: PullState::Merged,
            merged_at: Some(500),
            ..older_open.clone()
        };
        let mut pulls = vec![older_open.clone(), merged.clone(), newer_open.clone()];
        sort_pulls(&mut pulls);
        assert_eq!(pulls[0].updated_at, 200); // newer open first
        assert_eq!(pulls[1].updated_at, 100); // older open second
        assert_eq!(pulls[2].state, PullState::Merged); // merged last, regardless of date
    }

    #[test]
    fn mergeable_maps_gh_state_to_contract_bucket() {
        assert_eq!(map_mergeable(Some("MERGEABLE"), Some("CLEAN")), "clean");
        assert_eq!(map_mergeable(Some("MERGEABLE"), Some("BEHIND")), "behind");
        assert_eq!(
            map_mergeable(Some("CONFLICTING"), Some("DIRTY")),
            "conflicting"
        );
        assert_eq!(map_mergeable(Some("MERGEABLE"), Some("BLOCKED")), "blocked");
        assert_eq!(map_mergeable(Some("UNKNOWN"), None), "unknown");
    }

    #[test]
    fn inline_comments_attach_to_their_file_and_review_body_joins_unresolved() {
        let pr = sample_pr(
            r#"{
                "number": 1, "title": "t", "headRefName": "h", "baseRefName": "main",
                "state": "OPEN", "isDraft": false, "author": {"login": "a"},
                "createdAt": "2024-01-01T00:00:00Z", "updatedAt": "2024-01-02T00:00:00Z",
                "files": [{"path": "src/a.ts", "additions": 3, "deletions": 1}],
                "latestReviews": [{"author": {"login": "bob"}, "state": "CHANGES_REQUESTED", "body": "fix this"}],
                "url": "https://github.com/o/r/pull/1"
            }"#,
        );
        let inline = vec![ReviewComment {
            author: "carol".into(),
            path: Some("src/a.ts".into()),
            line: Some(10),
            body: "nit".into(),
            created_at: 5,
            url: "https://github.com/o/r/pull/1#discussion".into(),
        }];
        let detail = map_pull_detail(&pr, Some("bob"), inline);
        assert_eq!(detail.files[0].comments, 1);
        // review body is present, newest (updatedAt) first
        assert!(detail.comments.iter().any(|c| c.body == "fix this"));
    }
}
