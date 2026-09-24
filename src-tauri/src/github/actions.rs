//! github-ci-logs: `github_list_checks` / `github_get_job` / `github_rerun_failed`
//! and the Actions job/run-id parsing + JSON→contract mapping shared with
//! `pulls.rs` (statusCheckRollup) and `commits.rs` (commit check-runs).

use super::gh::{gh_failed, gh_json, gh_routed, require_gh};
use super::{
    parse_rfc3339_ms, remote_owner_name_host, resolve_scope, CheckJob, CheckRun, CheckState,
    JobStep, StepState,
};
use crate::diff::GitHost;
use crate::ipc::{AppError, ErrorCode};
use serde::Deserialize;

// ---------- gh JSON shapes ----------

#[derive(Deserialize, Clone, Debug)]
pub(crate) struct GhApp {
    pub(crate) slug: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub(crate) struct GhCheckRunItem {
    pub(crate) id: u64,
    pub(crate) name: String,
    pub(crate) status: Option<String>,
    pub(crate) conclusion: Option<String>,
    pub(crate) started_at: Option<String>,
    pub(crate) completed_at: Option<String>,
    pub(crate) details_url: Option<String>,
    pub(crate) html_url: Option<String>,
    #[serde(default)]
    pub(crate) app: Option<GhApp>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub(crate) struct GhCheckRunsResponse {
    #[serde(default)]
    pub(crate) check_runs: Vec<GhCheckRunItem>,
}

#[derive(Deserialize, Clone, Debug)]
struct GhStatusItem {
    state: String,
    context: String,
    target_url: Option<String>,
    description: Option<String>,
}

#[derive(Deserialize, Clone, Debug, Default)]
struct GhCommitStatusResponse {
    #[serde(default)]
    statuses: Vec<GhStatusItem>,
}

#[derive(Deserialize, Clone, Debug)]
struct GhJobStep {
    name: String,
    status: String,
    conclusion: Option<String>,
    number: u32,
    started_at: Option<String>,
    completed_at: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub(crate) struct GhJob {
    id: u64,
    run_id: u64,
    #[serde(default)]
    run_attempt: Option<u32>,
    name: String,
    workflow_name: Option<String>,
    status: String,
    conclusion: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
    html_url: String,
    #[serde(default)]
    steps: Vec<GhJobStep>,
}

// ---------- pure JSON -> contract mapping ----------

/// A completed status/conclusion pair -> `CheckState`. Shared by the
/// check-runs API mapping and the job-level mapping (both use GitHub's
/// `status`/`conclusion` vocabulary, unlike `pulls.rs`'s statusCheckRollup).
fn map_completed_state(status: &str, conclusion: Option<&str>) -> CheckState {
    match status {
        "completed" => match conclusion {
            Some("success") | Some("neutral") => CheckState::Passed,
            Some("skipped") => CheckState::Skipped,
            _ => CheckState::Failed,
        },
        _ => CheckState::Pending,
    }
}

fn duration_between(started: Option<&str>, completed: Option<&str>) -> Option<u64> {
    match (started, completed) {
        (Some(s), Some(c)) => match (parse_rfc3339_ms(s), parse_rfc3339_ms(c)) {
            (Some(s), Some(c)) if c >= s => Some((c - s) as u64),
            _ => None,
        },
        _ => None,
    }
}

/// Parses `…/actions/runs/{runId}/job(s)/{jobId}` out of any URL string ->
/// `(runId, jobId)`. Returns `None` on anything that doesn't match — a parse
/// failure means "not an Actions job" (both jobId/runId stay absent).
pub(crate) fn parse_actions_job_url(url: &str) -> Option<(u64, u64)> {
    let idx = url.find("actions/runs/")?;
    let rest = &url[idx + "actions/runs/".len()..];
    let mut parts = rest.split('/');
    let run_id: u64 = parts.next()?.parse().ok()?;
    let job_segment = parts.next()?;
    if job_segment != "job" && job_segment != "jobs" {
        return None;
    }
    let job_id_part = parts.next()?;
    let job_id_str = job_id_part.split(['?', '#']).next().unwrap_or(job_id_part);
    let job_id: u64 = job_id_str.parse().ok()?;
    Some((run_id, job_id))
}

/// `commits/{sha}/check-runs` item -> `CheckRun`, shared by `github_list_checks`
/// and the commit-detail check list. `jobId`/`runId` are set only for a
/// GitHub Actions app whose URL parses; parse failure clears both (core rule,
/// specs/github-ci-logs.md §5).
pub(crate) fn map_actions_check_run(item: &GhCheckRunItem) -> CheckRun {
    let state = map_completed_state(
        item.status.as_deref().unwrap_or(""),
        item.conclusion.as_deref(),
    );
    let duration_ms = duration_between(item.started_at.as_deref(), item.completed_at.as_deref());
    let is_actions = item.app.as_ref().and_then(|a| a.slug.as_deref()) == Some("github-actions");
    let url_for_parse = item.details_url.as_deref().or(item.html_url.as_deref());
    let (job_id, run_id) = if is_actions {
        url_for_parse
            .and_then(parse_actions_job_url)
            .map(|(run_id, _)| (Some(item.id), Some(run_id)))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };
    CheckRun {
        name: item.name.clone(),
        state,
        duration_ms,
        summary: None,
        details_url: item.html_url.clone().or_else(|| item.details_url.clone()),
        job_id,
        run_id,
        started_at: item.started_at.as_deref().and_then(parse_rfc3339_ms),
    }
}

fn map_status_item(item: &GhStatusItem) -> CheckRun {
    let state = match item.state.as_str() {
        "success" => CheckState::Passed,
        "pending" => CheckState::Pending,
        "error" | "failure" => CheckState::Failed,
        _ => CheckState::Pending,
    };
    CheckRun {
        name: item.context.clone(),
        state,
        duration_ms: None,
        summary: item.description.clone(),
        details_url: item.target_url.clone(),
        job_id: None,
        run_id: None,
        started_at: None,
    }
}

fn step_state(status: &str, conclusion: Option<&str>) -> StepState {
    match status {
        "queued" => StepState::Queued,
        "in_progress" => StepState::Running,
        "completed" => match conclusion {
            Some("success") | Some("neutral") => StepState::Passed,
            Some("skipped") => StepState::Skipped,
            Some("cancelled") => StepState::Cancelled,
            _ => StepState::Failed,
        },
        _ => StepState::Queued,
    }
}

fn map_job_step(step: &GhJobStep) -> JobStep {
    JobStep {
        number: step.number,
        name: step.name.clone(),
        state: step_state(&step.status, step.conclusion.as_deref()),
        started_at: step.started_at.as_deref().and_then(parse_rfc3339_ms),
        duration_ms: duration_between(step.started_at.as_deref(), step.completed_at.as_deref()),
    }
}

pub(crate) fn map_check_job(job: &GhJob) -> CheckJob {
    let mut steps: Vec<JobStep> = job.steps.iter().map(map_job_step).collect();
    steps.sort_by_key(|s| s.number);
    CheckJob {
        job_id: job.id,
        run_id: job.run_id,
        run_attempt: job.run_attempt.unwrap_or(1),
        name: job.name.clone(),
        workflow_name: job.workflow_name.clone(),
        state: map_completed_state(&job.status, job.conclusion.as_deref()),
        completed: job.status == "completed",
        started_at: job.started_at.as_deref().and_then(parse_rfc3339_ms),
        duration_ms: duration_between(job.started_at.as_deref(), job.completed_at.as_deref()),
        steps,
        html_url: job.html_url.clone(),
    }
}

/// `sha` must be a full 40-char lowercase/uppercase hex string (contract:
/// anything else -> INVALID_INPUT).
pub(crate) fn is_full_sha(sha: &str) -> bool {
    sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

// ---------- commands' impls ----------

pub(crate) fn fetch_actions_check_runs(
    host: &GitHost,
    root: &str,
    owner: &str,
    name: &str,
    sha: &str,
) -> Result<Vec<CheckRun>, AppError> {
    let path = format!("repos/{owner}/{name}/commits/{sha}/check-runs?per_page=100");
    let runs: GhCheckRunsResponse = gh_json(host, root, &["api", &path])?;
    Ok(runs.check_runs.iter().map(map_actions_check_run).collect())
}

pub(crate) fn do_list_checks(cwd: &str, sha: &str) -> Result<Vec<CheckRun>, AppError> {
    if !is_full_sha(sha) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "sha must be a full 40-character hex sha",
        ));
    }
    let (host, root, remote_host) = resolve_scope(cwd)?;
    require_gh(&host, &root, remote_host.as_deref())?;
    let Some((owner, name, _)) = remote_owner_name_host(&host, &root) else {
        return Err(AppError::new(
            ErrorCode::GhUnavailable,
            "could not resolve the GitHub remote",
        ));
    };
    let mut out = fetch_actions_check_runs(&host, &root, &owner, &name, sha)?;
    let status_path = format!("repos/{owner}/{name}/commits/{sha}/status");
    let status: GhCommitStatusResponse = gh_json(&host, &root, &["api", &status_path])?;
    out.extend(status.statuses.iter().map(map_status_item));
    Ok(out)
}

pub(crate) fn do_get_job(cwd: &str, job_id: u64) -> Result<CheckJob, AppError> {
    if job_id == 0 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "jobId must be positive",
        ));
    }
    let (host, root, remote_host) = resolve_scope(cwd)?;
    require_gh(&host, &root, remote_host.as_deref())?;
    let Some((owner, name, _)) = remote_owner_name_host(&host, &root) else {
        return Err(AppError::new(
            ErrorCode::GhUnavailable,
            "could not resolve the GitHub remote",
        ));
    };
    let path = format!("repos/{owner}/{name}/actions/jobs/{job_id}");
    let job: GhJob = gh_json(&host, &root, &["api", &path])?;
    Ok(map_check_job(&job))
}

pub(crate) fn do_rerun_failed(cwd: &str, run_id: u64) -> Result<(), AppError> {
    if run_id == 0 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "runId must be positive",
        ));
    }
    let (host, root, remote_host) = resolve_scope(cwd)?;
    require_gh(&host, &root, remote_host.as_deref())?;
    let out = gh_routed(
        &host,
        &root,
        &["run", "rerun", &run_id.to_string(), "--failed"],
    );
    if out.code != 0 {
        return Err(gh_failed(&out));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_run_and_job_id_from_a_details_url() {
        assert_eq!(
            parse_actions_job_url("https://github.com/o/r/actions/runs/1234567/job/9876543210"),
            Some((1234567, 9876543210))
        );
        assert_eq!(
            parse_actions_job_url("https://github.com/o/r/actions/runs/1/jobs/2"),
            Some((1, 2))
        );
    }

    #[test]
    fn rejects_a_url_that_is_not_an_actions_job_link() {
        assert_eq!(parse_actions_job_url("https://github.com/o/r/pull/1"), None);
        assert_eq!(
            parse_actions_job_url("https://github.com/o/r/actions/runs/abc/job/2"),
            None
        );
    }

    #[test]
    fn is_full_sha_requires_forty_hex_chars() {
        assert!(is_full_sha(&"a".repeat(40)));
        assert!(!is_full_sha(&"a".repeat(39)));
        assert!(!is_full_sha("not-a-sha"));
    }

    fn check_run_item(json: &str) -> GhCheckRunItem {
        serde_json::from_str(json).expect("valid check-run item JSON")
    }

    #[test]
    fn maps_a_github_actions_check_run_with_job_and_run_id() {
        let item = check_run_item(
            r#"{
                "id": 42, "name": "unit tests", "status": "completed", "conclusion": "success",
                "started_at": "2024-03-05T12:00:00Z", "completed_at": "2024-03-05T12:01:00Z",
                "details_url": "https://github.com/o/r/actions/runs/9/job/42",
                "html_url": "https://github.com/o/r/actions/runs/9/job/42",
                "app": {"slug": "github-actions"}
            }"#,
        );
        let run = map_actions_check_run(&item);
        assert_eq!(run.state, CheckState::Passed);
        assert_eq!(run.job_id, Some(42));
        assert_eq!(run.run_id, Some(9));
        assert_eq!(run.duration_ms, Some(60_000));
    }

    #[test]
    fn a_non_actions_app_never_gets_job_or_run_ids() {
        let item = check_run_item(
            r#"{
                "id": 42, "name": "codeql", "status": "completed", "conclusion": "success",
                "details_url": "https://github.com/o/r/actions/runs/9/job/42",
                "app": {"slug": "code-scanning"}
            }"#,
        );
        let run = map_actions_check_run(&item);
        assert_eq!(run.job_id, None);
        assert_eq!(run.run_id, None);
    }

    #[test]
    fn a_parse_failure_clears_both_ids_even_for_an_actions_app() {
        let item = check_run_item(
            r#"{
                "id": 42, "name": "unit tests", "status": "completed", "conclusion": "success",
                "details_url": "https://github.com/o/r/checks/42",
                "app": {"slug": "github-actions"}
            }"#,
        );
        let run = map_actions_check_run(&item);
        assert_eq!(run.job_id, None);
        assert_eq!(run.run_id, None);
    }

    #[test]
    fn maps_step_states() {
        assert_eq!(step_state("queued", None), StepState::Queued);
        assert_eq!(step_state("in_progress", None), StepState::Running);
        assert_eq!(step_state("completed", Some("success")), StepState::Passed);
        assert_eq!(step_state("completed", Some("neutral")), StepState::Passed);
        assert_eq!(step_state("completed", Some("skipped")), StepState::Skipped);
        assert_eq!(
            step_state("completed", Some("cancelled")),
            StepState::Cancelled
        );
        assert_eq!(step_state("completed", Some("failure")), StepState::Failed);
    }

    fn sample_job(json: &str) -> GhJob {
        serde_json::from_str(json).expect("valid job JSON")
    }

    #[test]
    fn maps_a_completed_job_with_a_failed_step() {
        let job = sample_job(
            r#"{
                "id": 42, "run_id": 9, "run_attempt": 2, "name": "test (ubuntu)",
                "workflow_name": "CI", "status": "completed", "conclusion": "failure",
                "started_at": "2024-03-05T12:00:00Z", "completed_at": "2024-03-05T12:05:00Z",
                "html_url": "https://github.com/o/r/actions/runs/9/job/42",
                "steps": [
                    {"name": "Checkout", "status": "completed", "conclusion": "success", "number": 1,
                     "started_at": "2024-03-05T12:00:00Z", "completed_at": "2024-03-05T12:00:10Z"},
                    {"name": "Run tests", "status": "completed", "conclusion": "failure", "number": 2,
                     "started_at": "2024-03-05T12:00:10Z", "completed_at": "2024-03-05T12:05:00Z"}
                ]
            }"#,
        );
        let mapped = map_check_job(&job);
        assert_eq!(mapped.job_id, 42);
        assert_eq!(mapped.run_id, 9);
        assert_eq!(mapped.run_attempt, 2);
        assert_eq!(mapped.workflow_name.as_deref(), Some("CI"));
        assert_eq!(mapped.state, CheckState::Failed);
        assert!(mapped.completed);
        assert_eq!(mapped.steps.len(), 2);
        assert_eq!(mapped.steps[1].state, StepState::Failed);
    }

    #[test]
    fn a_missing_run_attempt_defaults_to_one() {
        let job = sample_job(
            r#"{
                "id": 1, "run_id": 1, "name": "x", "status": "queued",
                "html_url": "u", "steps": []
            }"#,
        );
        assert_eq!(map_check_job(&job).run_attempt, 1);
        assert!(!map_check_job(&job).completed);
    }
}
