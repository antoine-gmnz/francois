//! GitLab pipelines, jobs and bounded whole-job traces.
use super::actions::is_full_sha;
use super::actions_log::{compute_step_log, parse_raw_lines};
use super::gh::run_routed_bounded;
use super::gitlab::Gitlab;
use super::{parse_rfc3339_ms, CheckJob, CheckRun, CheckState, JobStep, StepLog, StepState};
use crate::ipc::{AppError, ErrorCode};
use serde_json::Value;
use std::time::{Duration, Instant};

fn state(status: &str) -> CheckState {
    match status {
        "success" => CheckState::Passed,
        "failed" | "canceled" => CheckState::Failed,
        "skipped" => CheckState::Skipped,
        _ => CheckState::Pending,
    }
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}

fn duration(value: &Value) -> Option<u64> {
    value["duration"]
        .as_f64()
        .filter(|d| d.is_finite() && *d >= 0.0)
        .map(|d| (d * 1000.0) as u64)
}

fn map_job(value: &Value) -> CheckJob {
    let status = value["status"].as_str().unwrap_or_default();
    let mapped = state(status);
    let step_state = match status {
        "success" => StepState::Passed,
        "failed" => StepState::Failed,
        "canceled" => StepState::Cancelled,
        "skipped" => StepState::Skipped,
        "running" => StepState::Running,
        _ => StepState::Queued,
    };
    CheckJob {
        job_id: value["id"].as_u64().unwrap_or_default(),
        run_id: value["pipeline"]["id"].as_u64().unwrap_or_default(),
        run_attempt: 1,
        name: text(value, "name"),
        workflow_name: value["stage"].as_str().map(str::to_string),
        state: mapped,
        completed: matches!(status, "success" | "failed" | "canceled" | "skipped"),
        started_at: value["started_at"].as_str().and_then(parse_rfc3339_ms),
        duration_ms: duration(value),
        steps: vec![JobStep {
            number: 1,
            name: "Job log".to_string(),
            state: step_state,
            started_at: None,
            duration_ms: None,
        }],
        html_url: text(value, "web_url"),
    }
}

pub(crate) fn checks(scope: &Gitlab, sha: &str) -> Result<Vec<CheckRun>, AppError> {
    if !is_full_sha(sha) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "sha must be a full 40-character hex sha",
        ));
    }
    let pipelines = scope.api(
        &format!(
            "projects/{}/pipelines?sha={sha}&order_by=id&sort=desc&per_page=1",
            scope.project
        ),
        "GET",
        &[],
    )?;
    let Some(id) = pipelines
        .as_array()
        .and_then(|a| a.first())
        .and_then(|p| p["id"].as_u64())
    else {
        return Ok(vec![]);
    };
    pipeline_checks(scope, id)
}

pub(crate) fn pipeline_status_check(value: &Value) -> CheckRun {
    CheckRun {
        external: None,
        name: "Pipeline".into(),
        state: state(value["status"].as_str().unwrap_or_default()),
        duration_ms: duration(value),
        summary: None,
        details_url: value["web_url"].as_str().map(str::to_string),
        job_id: None,
        run_id: None,
        started_at: value["started_at"].as_str().and_then(parse_rfc3339_ms),
    }
}
fn map_pipeline_checks(jobs: &[Value], pipeline: &Value, id: u64) -> Vec<CheckRun> {
    let mut checks: Vec<_> = jobs
        .iter()
        .map(|value| {
            let job = map_job(value);
            CheckRun {
                external: None,
                name: job.name,
                state: job.state,
                duration_ms: job.duration_ms,
                summary: None,
                details_url: Some(job.html_url),
                job_id: Some(job.job_id),
                run_id: Some(id),
                started_at: job.started_at,
            }
        })
        .collect();
    checks.push(pipeline_status_check(pipeline));
    checks
}
pub(crate) fn pipeline_checks(scope: &Gitlab, id: u64) -> Result<Vec<CheckRun>, AppError> {
    let jobs = scope.pages(&format!(
        "projects/{}/pipelines/{id}/jobs?include_retried=false",
        scope.project
    ))?;
    // Pipeline state includes downstream bridges, which the jobs endpoint omits.
    let pipeline = scope.api(
        &format!("projects/{}/pipelines/{id}", scope.project),
        "GET",
        &[],
    )?;
    Ok(map_pipeline_checks(&jobs, &pipeline, id))
}

pub(crate) fn do_list_checks(cwd: &str, sha: &str) -> Result<Vec<CheckRun>, AppError> {
    if !is_full_sha(sha) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "sha must be a full 40-character hex sha",
        ));
    }
    checks(&Gitlab::scope(cwd)?, sha)
}

pub(crate) fn do_get_job(cwd: &str, id: u64) -> Result<CheckJob, AppError> {
    if id == 0 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "jobId must be positive",
        ));
    }
    let scope = Gitlab::scope(cwd)?;
    let value = scope.api(&format!("projects/{}/jobs/{id}", scope.project), "GET", &[])?;
    Ok(map_job(&value))
}

fn trace_log(id: u64, step: u32, raw: &str) -> StepLog {
    let lines = parse_raw_lines(raw);
    let mut result = compute_step_log(id, 0, &lines, &[]);
    result.step_number = step;
    result
}

pub(crate) fn do_get_step_log(cwd: &str, id: u64, step: u32) -> Result<StepLog, AppError> {
    if id == 0 || step > 1 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "jobId must be positive and stepNumber must be 0 or 1",
        ));
    }
    let job = do_get_job(cwd, id)?;
    if !job.completed {
        return Err(AppError::new(
            ErrorCode::GhLogNotReady,
            "log available when the job finishes",
        ));
    }
    let scope = Gitlab::scope(cwd)?;
    let path = format!("projects/{}/jobs/{id}/trace", scope.project);
    let run = run_routed_bounded(
        "glab",
        &scope.host,
        &scope.root,
        &["api", &path, "--hostname", &scope.hostname],
        Duration::from_secs(30),
        32 * 1024 * 1024,
    );
    if run.capped {
        return Err(AppError::new(
            ErrorCode::GhLogTooLarge,
            "log too large to show (> 32 MiB)",
        ));
    }
    if run.spawn_failed || run.timed_out || run.code != 0 {
        let code = if run.stderr.contains("404") || run.stderr.contains("410") {
            ErrorCode::GhLogGone
        } else {
            ErrorCode::GhFailed
        };
        return Err(AppError::new(code, "GitLab job trace unavailable"));
    }
    Ok(trace_log(id, step, &String::from_utf8_lossy(&run.stdout)))
}

fn failed_job_ids(jobs: &[Value]) -> Vec<u64> {
    jobs.iter()
        .filter(|job| job["status"].as_str() == Some("failed"))
        .filter_map(|job| job["id"].as_u64().filter(|id| *id > 0))
        .collect()
}

pub(crate) fn do_rerun_failed(cwd: &str, id: u64) -> Result<(), AppError> {
    if id == 0 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "runId must be positive",
        ));
    }
    let scope = Gitlab::scope(cwd)?;
    let started = Instant::now();
    let budget = Duration::from_secs(30);
    let jobs = scope.pages_timeout(
        &format!(
            "projects/{}/pipelines/{id}/jobs?include_retried=false",
            scope.project
        ),
        budget,
    )?;
    let ids = failed_job_ids(&jobs);
    if ids.is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "this GitLab pipeline has no failed jobs to retry",
        ));
    }
    for job in ids {
        let remaining = budget
            .checked_sub(started.elapsed())
            .filter(|time| !time.is_zero())
            .ok_or_else(|| AppError::new(ErrorCode::GhFailed, "GitLab job retry timed out"))?;
        scope.api_timeout(
            &format!("projects/{}/jobs/{job}/retry", scope.project),
            "POST",
            &[],
            remaining,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retry_selects_failed_jobs_only_including_allowed_failures() {
        let jobs = vec![
            json!({"id":1,"status":"failed","allow_failure":true}),
            json!({"id":2,"status":"canceled"}),
            json!({"id":3,"status":"manual"}),
            json!({"id":4,"status":"success"}),
            json!({"id":5,"status":"failed"}),
        ];
        assert_eq!(failed_job_ids(&jobs), vec![1, 5]);
    }

    #[test]
    fn invalid_inputs_fail_before_repository_or_auth_lookup() {
        assert!(do_list_checks("/missing", "invalid").is_err());
        assert!(do_get_job("/missing", 0).is_err());
        assert!(do_get_step_log("/missing", 1, 2).is_err());
        assert!(do_rerun_failed("/missing", 0).is_err());
    }

    #[test]
    fn cancelled_job_is_terminal_and_manual_job_remains_pending() {
        let cancelled = map_job(&json!({"status":"canceled"}));
        assert_eq!(cancelled.state, CheckState::Failed);
        assert_eq!(cancelled.steps[0].state, StepState::Cancelled);
        assert!(cancelled.completed);
        let manual = map_job(&json!({"status":"manual"}));
        assert_eq!(manual.state, CheckState::Pending);
        assert!(!manual.completed);
    }

    #[test]
    fn manual_and_cancelled_never_pass() {
        assert_eq!(state("manual"), CheckState::Pending);
        assert_eq!(state("canceled"), CheckState::Failed);
        assert_eq!(state("success"), CheckState::Passed);
    }

    #[test]
    fn synthetic_job_log_has_no_invented_step_timing() {
        let job = map_job(
            &json!({"id": 42,"pipeline":{"id":9},"name":"test","status":"failed","duration":2.5,"web_url":"u"}),
        );
        assert_eq!(job.run_id, 9);
        assert_eq!(job.steps[0].name, "Job log");
        assert_eq!(job.steps[0].started_at, None);
        assert_eq!(job.duration_ms, Some(2500));
        assert!(job.completed);
    }

    #[test]
    fn trace_sanitizes_and_caps_without_invented_steps() {
        let log = trace_log(42, 1, "\x1b[31mred\x1b[0m\x07\n##[error]boom");
        assert_eq!(log.step_number, 1);
        assert_eq!(log.lines[0].text, "red");
        assert_eq!(log.first_error_line, Some(2));
        let long = "line\n".repeat(5100);
        assert_eq!(trace_log(42, 0, &long).dropped_lines, 100);
    }
    #[test]
    fn authoritative_pipeline_detects_failed_or_pending_downstream_despite_successful_job() {
        let ordinary = map_job(&json!({"id":1,"status":"success"}));
        assert_eq!(ordinary.state, CheckState::Passed);
        for (status, expected) in [
            ("failed", CheckState::Failed),
            ("running", CheckState::Pending),
        ] {
            let checks = map_pipeline_checks(
                &[json!({"id":1,"status":"success"})],
                &json!({"id":10,"status":status,"web_url":"https://gitlab.test/pipeline/10"}),
                10,
            );
            assert_eq!(checks.len(), 2);
            assert_eq!(checks[0].state, CheckState::Passed);
            let check = &checks[1];
            assert_eq!(check.state, expected);
            assert!(check.job_id.is_none());
            assert!(check.run_id.is_none());
        }
    }
}
