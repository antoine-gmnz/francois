//! GitLab provider adapter. Uses existing glab authentication, never stores credentials.
use super::*;
use crate::ipc::{AppError, ErrorCode};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

pub(crate) fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn fail(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::GhFailed, message)
}
fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, message)
}
pub(crate) fn classify_provider(
    host: Option<&str>,
    github_auth: bool,
    gitlab_auth: bool,
) -> &'static str {
    match host {
        Some("github.com") => "github",
        Some(h)
            if h == "gitlab.com"
                || h.split(['.', ':'])
                    .any(|part| part.eq_ignore_ascii_case("gitlab")) =>
        {
            "gitlab"
        }
        Some(_) if gitlab_auth => "gitlab",
        Some(_) if github_auth => "github",
        _ => "unknown",
    }
}
type ProviderCache = Mutex<HashMap<String, (String, GhStatus, Instant)>>;
static CACHE: OnceLock<ProviderCache> = OnceLock::new();
fn lock_cache(
    cache: &ProviderCache,
) -> MutexGuard<'_, HashMap<String, (String, GhStatus, Instant)>> {
    cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
pub(crate) fn provider_status(
    host: &GitHost,
    root: &str,
    hostname: Option<&str>,
) -> (String, GhStatus) {
    let key = format!("{host:?}|{root}|{hostname:?}");
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((provider, status, at)) = lock_cache(cache).get(&key) {
        if at.elapsed() < Duration::from_secs(60) {
            return (provider.clone(), *status);
        }
    }
    let known = classify_provider(hostname, false, false);
    let auth = |cli: &str| {
        hostname.is_some_and(|h| {
            gh::run_routed(
                cli,
                host,
                root,
                &["auth", "status", "--hostname", h],
                gh::GH_TIMEOUT,
            )
            .code
                == 0
        })
    };
    let provider = if known != "unknown" {
        known
    } else {
        classify_provider(hostname, auth("gh"), auth("glab"))
    };
    let status = if provider == "unknown" {
        GhStatus::NotGithub
    } else {
        let cli = if provider == "gitlab" { "glab" } else { "gh" };
        if gh::run_routed(cli, host, root, &["--version"], gh::GH_TIMEOUT).code != 0 {
            GhStatus::Missing
        } else if auth(cli) {
            GhStatus::Ok
        } else {
            GhStatus::Unauthenticated
        }
    };
    lock_cache(cache).insert(key, (provider.into(), status, Instant::now()));
    (provider.into(), status)
}
pub(crate) fn is_gitlab(cwd: &str) -> Result<bool, AppError> {
    let (host, root, remote) = resolve_scope(cwd)?;
    let (provider, status) = provider_status(&host, &root, remote.as_deref());
    if provider == "unknown" {
        return Err(AppError::new(
            ErrorCode::GhUnavailable,
            "Repository provider is unknown; local Git remains available",
        ));
    }
    if provider == "gitlab" && status != GhStatus::Ok {
        return Err(AppError::new(
            ErrorCode::GhUnavailable,
            format!(
                "glab is {status:?} for {}; run glab auth login --hostname {}",
                remote.as_deref().unwrap_or("GitLab"),
                remote.as_deref().unwrap_or("gitlab.com")
            ),
        ));
    }
    Ok(provider == "gitlab")
}
pub(crate) struct Gitlab {
    pub(crate) host: GitHost,
    pub(crate) root: String,
    pub(crate) hostname: String,
    pub(crate) project: String,
}
impl Gitlab {
    pub(crate) fn scope(cwd: &str) -> Result<Self, AppError> {
        if !is_gitlab(cwd)? {
            return Err(AppError::new(
                ErrorCode::GhUnavailable,
                "This is not a GitLab repository",
            ));
        }
        let (host, root, _) = resolve_scope(cwd)?;
        let (owner, name, hostname) = remote_owner_name_host(&host, &root)
            .ok_or_else(|| invalid("GitLab remote has no project namespace"))?;
        Ok(Self {
            host,
            root,
            hostname,
            project: encode(&format!("{owner}/{name}")),
        })
    }
    pub(crate) fn api(
        &self,
        path: &str,
        method: &str,
        fields: &[(&str, String)],
    ) -> Result<Value, AppError> {
        self.api_timeout(path, method, fields, gh::GH_TIMEOUT)
    }
    pub(crate) fn api_timeout(
        &self,
        path: &str,
        method: &str,
        fields: &[(&str, String)],
        timeout: Duration,
    ) -> Result<Value, AppError> {
        let mut args = vec![
            "api".into(),
            "--hostname".into(),
            self.hostname.clone(),
            "--method".into(),
            method.into(),
            path.into(),
        ];
        for (key, value) in fields {
            args.extend(["--raw-field".into(), format!("{key}={value}")]);
        }
        let refs: Vec<_> = args.iter().map(String::as_str).collect();
        let out = gh::run_routed_bounded(
            "glab",
            &self.host,
            &self.root,
            &refs,
            timeout,
            8 * 1024 * 1024,
        );
        if out.code != 0 || out.capped || out.timed_out {
            return Err(fail(
                "glab API request failed (check authentication, permissions and connectivity)",
            ));
        }
        if out.stdout.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&out.stdout).map_err(|_| fail("Could not parse glab API response"))
    }
    pub(crate) fn pages(&self, path: &str) -> Result<Vec<Value>, AppError> {
        self.pages_timeout(path, Duration::from_secs(30))
    }
    pub(crate) fn pages_timeout(
        &self,
        path: &str,
        timeout: Duration,
    ) -> Result<Vec<Value>, AppError> {
        let mut result = Vec::new();
        let started = Instant::now();
        for page in 1..=100 {
            if started.elapsed() >= timeout {
                return Err(fail("GitLab pagination timed out"));
            }
            let sep = if path.contains('?') { '&' } else { '?' };
            let data = self.api_timeout(
                &format!("{path}{sep}per_page=100&page={page}"),
                "GET",
                &[],
                timeout
                    .saturating_sub(started.elapsed())
                    .min(gh::GH_TIMEOUT),
            )?;
            let items = data
                .as_array()
                .ok_or_else(|| fail("Expected a GitLab list response"))?;
            result.extend(items.iter().cloned());
            if items.len() < 100 {
                return Ok(result);
            }
        }
        Err(fail("GitLab pagination exceeds 10,000 entries"))
    }
}
fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().into()
}
fn date(v: &Value, key: &str) -> Option<i64> {
    v[key].as_str().and_then(parse_rfc3339_ms)
}
fn username(v: &Value) -> String {
    text(v, "username")
}
fn rollup(runs: &[CheckRun]) -> CheckRollup {
    CheckRollup {
        total: runs.len() as u32,
        passed: runs
            .iter()
            .filter(|x| x.state == CheckState::Passed)
            .count() as u32,
        failed: runs
            .iter()
            .filter(|x| x.state == CheckState::Failed)
            .count() as u32,
        pending: runs
            .iter()
            .filter(|x| x.state == CheckState::Pending)
            .count() as u32,
    }
}
fn pipeline_rollup(pipeline: &Value) -> CheckRollup {
    let status = pipeline["status"].as_str().unwrap_or_default();
    CheckRollup {
        total: 1,
        passed: u32::from(status == "success"),
        failed: u32::from(matches!(status, "failed" | "canceled")),
        pending: u32::from(!matches!(
            status,
            "success" | "failed" | "canceled" | "skipped"
        )),
    }
}
fn summary(mr: &Value, viewer: &str) -> PullSummary {
    let state = match mr["state"].as_str() {
        Some("merged") => PullState::Merged,
        Some("opened")
            if mr["draft"].as_bool() == Some(true)
                || mr["work_in_progress"].as_bool() == Some(true) =>
        {
            PullState::Draft
        }
        Some("opened") => PullState::Open,
        _ => PullState::Closed,
    };
    let merged_by = mr
        .get("merge_user")
        .or_else(|| mr.get("merged_by"))
        .filter(|x| x.is_object())
        .map(username);
    PullSummary {
        number: mr["iid"].as_u64().unwrap_or_default(),
        title: text(mr, "title"),
        head: text(mr, "source_branch"),
        base: text(mr, "target_branch"),
        state,
        author: username(&mr["author"]),
        author_is_viewer: !viewer.is_empty() && username(&mr["author"]) == viewer,
        created_at: date(mr, "created_at").unwrap_or_default(),
        updated_at: date(mr, "updated_at").unwrap_or_default(),
        merged_at: date(mr, "merged_at"),
        merged_by_viewer: merged_by
            .as_ref()
            .map(|x| !viewer.is_empty() && x == viewer),
        merged_by,
        checks: rollup(&[]),
        review: match mr["detailed_merge_status"].as_str() {
            Some("not_approved") => ReviewDecision::ReviewRequired,
            Some("requested_changes") => ReviewDecision::ChangesRequested,
            _ => ReviewDecision::None,
        },
        changes_requested: u32::from(
            mr["detailed_merge_status"].as_str() == Some("requested_changes"),
        ),
        url: text(mr, "web_url"),
    }
}
pub(crate) fn merge_methods(project: &Value) -> Vec<String> {
    if !matches!(
        project["merge_method"].as_str(),
        Some("merge" | "ff" | "rebase_merge")
    ) {
        return vec![];
    }
    match project["squash_option"].as_str() {
        Some("always") => vec!["squash".into()],
        Some("never") => vec!["merge".into()],
        Some("default_on" | "default_off") => vec!["squash".into(), "merge".into()],
        _ => vec![],
    }
}
fn mergeable(mr: &Value) -> String {
    match mr["detailed_merge_status"].as_str() {
        Some("mergeable") => "clean",
        Some("conflict") => "conflicting",
        Some("need_rebase") => "behind",
        Some("checking" | "unchecked" | "preparing") | None => "unknown",
        _ => "blocked",
    }
    .into()
}
pub(crate) fn do_list_pulls(
    cwd: &str,
    limit: u32,
    open: bool,
) -> Result<Vec<PullSummary>, AppError> {
    let g = Gitlab::scope(cwd)?;
    let viewer = g
        .api("user", "GET", &[])
        .map(|v| username(&v))
        .unwrap_or_default();
    let state = if open { "opened" } else { "all" };
    let data = g.api(
        &format!(
            "projects/{}/merge_requests?state={state}&order_by=updated_at&sort=desc&per_page={}",
            g.project,
            limit.clamp(1, 100)
        ),
        "GET",
        &[],
    )?;
    let items = data
        .as_array()
        .ok_or_else(|| fail("Invalid merge request list"))?;
    let pipelines = g
        .api(
            &format!(
                "projects/{}/pipelines?order_by=id&sort=desc&per_page=100",
                g.project
            ),
            "GET",
            &[],
        )
        .unwrap_or(Value::Null);
    Ok(items
        .iter()
        .map(|m| {
            let mut result = summary(m, &viewer);
            let pipeline = if m["head_pipeline"].is_object() {
                Some(&m["head_pipeline"])
            } else {
                pipelines.as_array().and_then(|items| {
                    items
                        .iter()
                        .find(|p| p["sha"] == m["sha"] && m["sha"].is_string())
                })
            };
            if let Some(pipeline) = pipeline {
                result.checks = pipeline_rollup(pipeline);
            }
            result
        })
        .collect())
}
fn external_head_check(mr: &Value) -> Option<CheckRun> {
    let pipeline = &mr["head_pipeline"];
    if !pipeline.is_object() {
        return None;
    }
    let owner = pipeline["project_id"].as_u64();
    let target = mr["target_project_id"]
        .as_u64()
        .or_else(|| mr["project_id"].as_u64());
    if owner.is_some() && owner == target {
        return None;
    }
    let mut check = super::gitlab_ci::pipeline_status_check(pipeline);
    check.name = "External pipeline".into();
    check.external = Some(true);
    Some(check)
}
pub(crate) fn do_get_pull(cwd: &str, number: u64) -> Result<PullDetail, AppError> {
    if number == 0 {
        return Err(invalid("Merge request number must be positive"));
    }
    let g = Gitlab::scope(cwd)?;
    let path = format!("projects/{}/merge_requests/{number}", g.project);
    let mr = g.api(
        &format!("{path}?with_merge_status_recheck=true"),
        "GET",
        &[],
    )?;
    let viewer = g
        .api("user", "GET", &[])
        .map(|v| username(&v))
        .unwrap_or_default();
    let mut sum = summary(&mr, &viewer);
    if let Ok(approvals) = g.api(&format!("{path}/approvals"), "GET", &[]) {
        sum.review = if approvals["approved"].as_bool() == Some(true) {
            ReviewDecision::Approved
        } else if approvals["approvals_left"].as_u64().is_some_and(|n| n > 0) {
            ReviewDecision::ReviewRequired
        } else {
            ReviewDecision::None
        };
    }
    let discussions = g.pages(&format!("{path}/discussions"))?;
    let mut comments = Vec::new();
    for discussion in discussions {
        for note in discussion["notes"].as_array().into_iter().flatten() {
            if note["system"].as_bool() == Some(true) || note["resolved"].as_bool() == Some(true) {
                continue;
            }
            comments.push(ReviewComment {
                author: username(&note["author"]),
                path: note["position"]["new_path"].as_str().map(str::to_string),
                line: note["position"]["new_line"]
                    .as_u64()
                    .or_else(|| note["position"]["old_line"].as_u64()),
                body: text(note, "body"),
                created_at: date(note, "created_at").unwrap_or_default(),
                url: format!(
                    "{}#note_{}",
                    sum.url,
                    note["id"].as_u64().unwrap_or_default()
                ),
            });
        }
    }
    comments.sort_by_key(|n| std::cmp::Reverse(n.created_at));
    let diffs = g.pages(&format!("{path}/diffs"))?;
    let mut files: Vec<_> = diffs
        .iter()
        .map(|d| {
            let diff = text(d, "diff");
            let path = text(d, "new_path");
            PullFile {
                comments: comments
                    .iter()
                    .filter(|c| c.path.as_deref() == Some(&path))
                    .count() as u32,
                path,
                additions: diff
                    .lines()
                    .filter(|l| l.starts_with('+') && !l.starts_with("+++"))
                    .count() as u64,
                deletions: diff
                    .lines()
                    .filter(|l| l.starts_with('-') && !l.starts_with("---"))
                    .count() as u64,
            }
        })
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.additions + f.deletions));
    let sha = text(&mr, "sha");
    let runs = if let Some(check) = external_head_check(&mr) {
        vec![check]
    } else if let Some(id) = mr["head_pipeline"]["id"].as_u64() {
        super::gitlab_ci::pipeline_checks(&g, id)?
    } else {
        super::gitlab_ci::checks(&g, &sha)?
    };
    sum.checks = rollup(&runs);
    let project = g
        .api(&format!("projects/{}", g.project), "GET", &[])
        .unwrap_or(Value::Null);
    let reviewers = mr["reviewers"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            let name = username(r);
            if name == viewer && !viewer.is_empty() {
                "you".into()
            } else {
                name
            }
        })
        .collect();
    Ok(PullDetail {
        summary: sum,
        additions: files.iter().map(|f| f.additions).sum(),
        deletions: files.iter().map(|f| f.deletions).sum(),
        files,
        check_runs: runs,
        comments,
        reviewers,
        labels: mr["labels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect(),
        milestone: mr["milestone"]["title"].as_str().map(str::to_string),
        head_sha: sha.chars().take(7).collect(),
        head_oid: sha,
        mergeable: mergeable(&mr),
        merge_methods: merge_methods(&project),
        cross_repository: mr["source_project_id"] != mr["target_project_id"],
        body: text(&mr, "description"),
    })
}
pub(crate) fn merge_fields(
    mr: &Value,
    project: &Value,
    method: &str,
    delete: bool,
) -> Result<Vec<(&'static str, String)>, AppError> {
    if mr["state"].as_str() != Some("opened")
        || mr["draft"].as_bool() == Some(true)
        || mr["work_in_progress"].as_bool() == Some(true)
        || mergeable(mr) != "clean"
    {
        return Err(fail("Merge request must be open, non-draft and mergeable"));
    }
    if !merge_methods(project).iter().any(|m| m == method) {
        return Err(invalid(
            "Merge method is not supported by this GitLab project policy",
        ));
    }
    let sha = text(mr, "sha");
    if !actions::is_full_sha(&sha) {
        return Err(fail("Merge request head SHA is unavailable"));
    }
    let safe_delete = delete
        && mr["source_project_id"].as_u64().is_some()
        && mr["source_project_id"] == mr["target_project_id"]
        && !text(mr, "source_branch").is_empty()
        && !text(mr, "target_branch").is_empty()
        && mr["source_branch"] != mr["target_branch"]
        && !text(project, "default_branch").is_empty()
        && mr["source_branch"] != project["default_branch"];
    Ok(vec![
        ("sha", sha),
        ("squash", (method == "squash").to_string()),
        ("should_remove_source_branch", safe_delete.to_string()),
    ])
}
pub(crate) fn do_merge_pull(
    cwd: &str,
    number: u64,
    method: &str,
    delete: bool,
) -> Result<MergeOutcome, AppError> {
    if number == 0 {
        return Err(invalid("Merge request number must be positive"));
    }
    let g = Gitlab::scope(cwd)?;
    let path = format!("projects/{}/merge_requests/{number}", g.project);
    let project = g.api(&format!("projects/{}", g.project), "GET", &[])?;
    let mr = g.api(
        &format!("{path}?with_merge_status_recheck=true"),
        "GET",
        &[],
    )?;
    let mut fields = merge_fields(&mr, &project, method, delete)?;
    let should_delete = fields
        .iter()
        .any(|(k, v)| *k == "should_remove_source_branch" && v == "true");
    for (k, v) in &mut fields {
        if *k == "should_remove_source_branch" {
            *v = "false".into();
        }
    }
    let merged = g.api(&format!("{path}/merge"), "PUT", &fields)?;
    if merged["state"].as_str() != Some("merged") {
        return Err(fail("GitLab did not report the merge as completed"));
    }
    let deleted = should_delete
        && g.api(
            &format!(
                "projects/{}/repository/branches/{}",
                g.project,
                encode(&text(&mr, "source_branch"))
            ),
            "DELETE",
            &[],
        )
        .is_ok();
    Ok(MergeOutcome {
        branch_deleted: deleted,
        branch_delete_error: if delete && !deleted {
            Some("Merge completed; source branch deletion was not confirmed".into())
        } else {
            None
        },
    })
}
pub(crate) fn commit_pull(cwd: &str, sha: &str) -> Option<u64> {
    let g = Gitlab::scope(cwd).ok()?;
    let data = g
        .api(
            &format!(
                "projects/{}/repository/commits/{sha}/merge_requests",
                g.project
            ),
            "GET",
            &[],
        )
        .ok()?;
    data.as_array()?.first()?["iid"].as_u64()
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn host_detection_is_conservative_and_retains_gitlab_without_auth() {
        assert_eq!(
            classify_provider(Some("gitlab.com"), false, false),
            "gitlab"
        );
        assert_eq!(
            classify_provider(Some("gitlab.company.test"), false, false),
            "gitlab"
        );
        assert_eq!(
            classify_provider(Some("code.company.test"), false, true),
            "gitlab"
        );
        assert_eq!(
            classify_provider(Some("code.company.test"), false, false),
            "unknown"
        );
        assert_eq!(classify_provider(Some("github.com"), false, true), "github");
    }
    #[test]
    fn merge_policy_and_guard_never_invent_supported_methods() {
        assert_eq!(
            merge_methods(&json!({"merge_method":"merge","squash_option":"default_off"})),
            vec!["squash", "merge"]
        );
        assert_eq!(
            merge_methods(&json!({"merge_method":"ff","squash_option":"always"})),
            vec!["squash"]
        );
        assert!(merge_methods(&json!({})).is_empty());
        let mut mr = json!({"state":"opened","draft":false,"detailed_merge_status":"mergeable","sha":"a".repeat(40),"source_branch":"feature","target_branch":"main","source_project_id":1,"target_project_id":1});
        let project =
            json!({"merge_method":"merge","squash_option":"never","default_branch":"main"});
        assert!(merge_fields(&mr, &project, "merge", true).is_ok());
        mr["draft"] = json!(true);
        assert!(merge_fields(&mr, &project, "merge", true).is_err());
    }
    #[test]
    fn namespace_encoding_preserves_subgroups_as_single_project_identifier() {
        assert_eq!(encode("team/sub/repo"), "team%2Fsub%2Frepo");
    }
    #[test]
    #[ignore = "requires existing glab authentication; read-only remote verification"]
    fn live_gitlab_read_only() {
        let cwd =
            std::env::var("FRANCOIS_GITLAB_TEST_REPO").expect("set FRANCOIS_GITLAB_TEST_REPO");
        let info = repo::compute_repo_info(&cwd).unwrap();
        assert_eq!(info.provider, "gitlab");
        assert_eq!(info.gh, GhStatus::Ok);
        let pulls = do_list_pulls(&cwd, 3, false).unwrap();
        let mut saw_log = false;
        for item in pulls {
            let pull = do_get_pull(&cwd, item.number).unwrap();
            let _checks_by_sha = gitlab_ci::do_list_checks(&cwd, &pull.head_oid).unwrap();
            if let Some(check) = pull.check_runs.iter().find(|c| {
                c.job_id.is_some()
                    && c.state != CheckState::Pending
                    && c.state != CheckState::Skipped
            }) {
                let job = gitlab_ci::do_get_job(&cwd, check.job_id.unwrap()).unwrap();
                let log = gitlab_ci::do_get_step_log(&cwd, job.job_id, 1).unwrap();
                assert!(!log.lines.is_empty());
                assert!(log.lines.len() <= 5000);
                saw_log = true;
                break;
            }
        }
        assert!(
            saw_log,
            "test repo needs a completed job with a real trace in recent MRs"
        );
    }
    #[test]
    fn merge_pins_sha_and_never_deletes_fork_target_or_default() {
        let sha = "a".repeat(40);
        let mut mr = json!({"state":"opened","detailed_merge_status":"mergeable","sha":sha,"source_branch":"feature","target_branch":"main","source_project_id":1,"target_project_id":1});
        let project = json!({"merge_method":"ff","squash_option":"always","default_branch":"main"});
        let fields = merge_fields(&mr, &project, "squash", true).unwrap();
        assert!(fields.contains(&("sha", sha)));
        assert!(fields.contains(&("should_remove_source_branch", "true".into())));
        mr["source_project_id"] = json!(2);
        assert!(merge_fields(&mr, &project, "squash", true)
            .unwrap()
            .contains(&("should_remove_source_branch", "false".into())));
        mr["source_project_id"] = json!(1);
        mr["source_branch"] = json!("main");
        assert!(merge_fields(&mr, &project, "squash", true)
            .unwrap()
            .contains(&("should_remove_source_branch", "false".into())));
        for status in ["checking", "not_approved", "conflict", "need_rebase"] {
            mr["detailed_merge_status"] = json!(status);
            assert!(merge_fields(&mr, &project, "squash", false).is_err());
        }
        mr["detailed_merge_status"] = json!("mergeable");
        mr["state"] = json!("closed");
        assert!(merge_fields(&mr, &project, "squash", false).is_err());
    }
    #[test]
    fn mr_states_and_viewer_are_mapped_without_approval_guessing() {
        let mut mr = json!({"state":"opened","draft":true,"author":{"username":"enzo"}});
        let draft = summary(&mr, "enzo");
        assert_eq!(draft.state, PullState::Draft);
        assert!(draft.author_is_viewer);
        assert_eq!(draft.review, ReviewDecision::None);
        mr["state"] = json!("merged");
        assert_eq!(summary(&mr, "").state, PullState::Merged);
        mr["state"] = json!("closed");
        assert_eq!(summary(&mr, "").state, PullState::Closed);
    }
    #[test]
    fn list_pipeline_rollup_never_passes_manual_cancelled_or_missing_status() {
        assert_eq!(pipeline_rollup(&json!({"status":"success"})).passed, 1);
        assert_eq!(pipeline_rollup(&json!({"status":"manual"})).pending, 1);
        assert_eq!(pipeline_rollup(&json!({"status":"canceled"})).failed, 1);
        assert_eq!(pipeline_rollup(&json!({})).pending, 1);
    }
    #[test]
    fn remote_less_repository_keeps_local_git_operations_available() {
        let dir = std::env::temp_dir().join(format!("francois-local-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_str().unwrap();
        assert_eq!(
            gh::git_routed(&GitHost::Native, cwd, &["init", "-b", "main"]).code,
            0
        );
        // Scope the fixture's default branch locally: Windows runners may
        // configure init.defaultBranch=master globally, even with `init -b main`.
        assert_eq!(
            gh::git_routed(
                &GitHost::Native,
                cwd,
                &["config", "init.defaultBranch", "main"]
            )
            .code,
            0
        );
        assert_eq!(
            gh::git_routed(
                &GitHost::Native,
                cwd,
                &[
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.test",
                    "commit",
                    "--allow-empty",
                    "-m",
                    "Local commit"
                ]
            )
            .code,
            0
        );
        let info = repo::compute_repo_info(cwd).unwrap();
        assert_eq!(info.provider, "unknown");
        assert_eq!(info.gh, GhStatus::NotGithub);
        let page = commits::do_list_commits(cwd, None, 10).unwrap();
        assert_eq!(page.commits.len(), 1);
        assert!(branches::do_list_branches(cwd).is_ok());
        let detail = commits::do_get_commit(cwd, &page.commits[0].sha).unwrap();
        assert!(detail.check_runs.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn fork_head_pipeline_retains_status_and_url_without_target_scoped_ids() {
        let mr = json!({"project_id":1,"target_project_id":1,"source_project_id":2,"head_pipeline":{"id":55,"project_id":2,"status":"failed","web_url":"https://gitlab.test/fork/repo/-/pipelines/55"}});
        let check = external_head_check(&mr).expect("fork pipeline must be represented externally");
        assert_eq!(check.state, CheckState::Failed);
        assert_eq!(
            check.details_url.as_deref(),
            Some("https://gitlab.test/fork/repo/-/pipelines/55")
        );
        assert!(check.job_id.is_none());
        assert!(check.run_id.is_none());
        assert_eq!(check.external, Some(true));
        let mut local = mr.clone();
        local["head_pipeline"]["project_id"] = json!(1);
        assert!(external_head_check(&local).is_none());
    }
    #[test]
    fn unknown_pipeline_owner_is_external_and_pending_stays_pending() {
        let mr = json!({"target_project_id":1,"head_pipeline":{"id":55,"status":"running","web_url":"https://gitlab.test/pipeline"}});
        let check = external_head_check(&mr).unwrap();
        assert_eq!(check.state, CheckState::Pending);
        assert!(check.job_id.is_none());
        assert!(check.run_id.is_none());
        assert_eq!(check.external, Some(true));
    }
    #[test]
    fn provider_cache_recovers_a_poisoned_lock() {
        let cache = Mutex::new(HashMap::new());
        let _ = std::panic::catch_unwind(|| {
            let _guard = cache.lock().unwrap();
            panic!("poison only this isolated cache");
        });
        assert!(cache.is_poisoned());
        lock_cache(&cache).insert(
            "repo".into(),
            ("gitlab".into(), GhStatus::Ok, Instant::now()),
        );
        assert!(lock_cache(&cache).contains_key("repo"));
    }
}
