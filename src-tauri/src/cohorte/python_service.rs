//! François-facing projection of the Python Cohorte `cohorte/1` service.
//! Existing UI records are retained while their source changes from the old
//! TypeScript CLI to the durable local protocol.

use super::catalogue::{CohorteEvent, DetectionChanged, EventHeader, RunUpdated, UnknownEvent};
use super::cli::{Runner, SystemRunner};
use super::detect;
use super::python_rpc::{self, RpcClient};
use super::{
    ApprovalPreview, ApprovalRequest, CliInfo, CohorteDetectRequest, CohorteDetection,
    CohorteDoctorReport, CohorteInitRequest, CohortePolicySummary, CohorteRootRequest, CohorteRun,
    CohorteRunControlRequest, CohorteRunLogRequest, CohorteRunRequest, CohorteWatchRequest,
    CommandOutcome, CommandStep, DoctorCheck, Gate, GateAction, HealthRow, LogEntry, Phase, RunGit,
    RunHost, RunIteration,
};
use crate::ids::now_ms;
use crate::ipc::{ok, AppError, ErrorCode, IpcResult};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

mod evidence;
mod execution;
mod history;
mod inbox;
mod projection;
mod watch;
use projection::*;

const EVENT_CHANNEL: &str = "francois://cohorte/event";

#[derive(Default)]
pub struct PythonState {
    watchers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    cursors: Mutex<HashMap<String, u64>>,
    workers: execution::Workers,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub root: String,
    pub feature_id: String,
    #[serde(default)]
    pub stage: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerRequest {
    pub root: String,
    pub run_id: String,
    pub approval_id: String,
    pub answer: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureChoice {
    id: String,
    title: String,
    status: String,
    /// FR-5 (cohorte-actions): the service's `features.list` item `kind`.
    kind: String,
    /// FR-5: epoch ms from `updated_at`; 0 when missing (never `now_ms()` —
    /// an absent timestamp must read as "unknown", not "just now").
    updated_at: u64,
    phase: Option<String>,
    artifacts: Vec<String>,
}

fn bad(message: &str) -> AppError {
    AppError::new(ErrorCode::CohorteOutputInvalid, message)
}

fn not_found(message: &str) -> AppError {
    AppError::new(ErrorCode::CohorteNotDetected, message)
}

fn millis(value: &Value) -> u64 {
    value
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .and_then(|d| u64::try_from(d.timestamp_millis()).ok())
        .unwrap_or_else(now_ms)
}

/// FR-5 (cohorte-actions): like [`millis`], but a missing/unparseable
/// timestamp reads as `0` rather than "now" — `FeatureChoice.updatedAt` must
/// never claim freshness the service never reported.
fn millis_or_zero(value: &Value) -> u64 {
    value
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .and_then(|d| u64::try_from(d.timestamp_millis()).ok())
        .unwrap_or(0)
}

fn items(result: &Value) -> Result<&[Value], AppError> {
    result["items"]
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| bad("Cohorte returned no items list"))
}

/// The first registered project whose canonicalized `root_path` contains one
/// of `candidates` (already canonicalized, tried in order).
fn match_project(projects: &[Value], candidates: &[PathBuf]) -> Option<Value> {
    let roots: Vec<(PathBuf, &Value)> = projects
        .iter()
        .filter_map(|p| Some((Path::new(p["root_path"].as_str()?).canonicalize().ok()?, p)))
        .collect();
    candidates.iter().find_map(|c| {
        roots
            .iter()
            .find(|(root, _)| c.starts_with(root))
            .map(|(_, p)| (*p).clone())
    })
}

/// The canonicalized main checkout of the git repo `start` lives in — how a
/// linked worktree finds the project its main checkout registered.
fn main_checkout_of(runner: &dyn Runner, start: &Path) -> Option<PathBuf> {
    detect::main_checkout(runner, &start.to_string_lossy())?
        .canonicalize()
        .ok()
}

fn project_for(client: &mut RpcClient, start: &Path) -> Result<Option<Value>, AppError> {
    let canonical = start
        .canonicalize()
        .map_err(|_| AppError::new(ErrorCode::InvalidInput, "Project directory does not exist"))?;
    let projects = client.call("projects.list", json!({}))?;
    let projects = items(&projects)?;
    if let Some(project) = match_project(projects, std::slice::from_ref(&canonical)) {
        return Ok(Some(project));
    }
    Ok(main_checkout_of(&SystemRunner, start).and_then(|main| match_project(projects, &[main])))
}

fn client() -> Result<RpcClient, AppError> {
    RpcClient::connect(&python_rpc::service_endpoint()?)
}

fn detected(client: &mut RpcClient, start_dir: &str) -> Result<CohorteDetection, AppError> {
    let path = Path::new(start_dir);
    if !path.is_dir() {
        return Ok(CohorteDetection {
            start_dir: start_dir.into(),
            state: "no-project".into(),
            root: None,
            dir: None,
            found_via: None,
            has_project_file: false,
            state_backend: None,
            root_branch: None,
            runtime: None,
            cli: CliInfo {
                installed: true,
                version: None,
                supported_range: "cohorte/1".into(),
                compatible: true,
            },
            cli_executable: Some(python_rpc::cli()),
            cli_data_dir: std::env::var("COHORTE_PYTHON_DATA_DIR").ok(),
            initialization: None,
            pending_requests: None,
            checked_at: now_ms(),
        });
    }
    let project = project_for(client, path)?;
    let root = project
        .as_ref()
        .and_then(|p| p["root_path"].as_str())
        .map(str::to_owned);
    let found = root.is_some();
    let pending_requests = project
        .as_ref()
        .map(|project| inbox::pending(client, project))
        .transpose()?;
    let health = client.call("health.get", json!({}))?;
    Ok(CohorteDetection {
        start_dir: start_dir.into(),
        state: if found { "detected" } else { "not-initialised" }.into(),
        root,
        dir: None,
        found_via: None,
        has_project_file: found,
        state_backend: found.then(|| "sqlite".into()),
        root_branch: None,
        runtime: Some("python".into()),
        cli: CliInfo {
            installed: true,
            version: health["version"].as_str().map(String::from),
            supported_range: "cohorte/1".into(),
            compatible: true,
        },
        cli_executable: Some(python_rpc::cli()),
        cli_data_dir: execution::actual_data_dir(start_dir).ok(),
        initialization: None,
        pending_requests,
        checked_at: now_ms(),
    })
}

fn project(client: &mut RpcClient, root: &str) -> Result<Value, AppError> {
    project_for(client, Path::new(root))?
        .ok_or_else(|| not_found("Cohorte project is not registered"))
}

fn cursor(state: &PythonState, root: &str) -> u64 {
    *state
        .cursors
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(root)
        .unwrap_or(&0)
}

fn emit(app: &AppHandle, event: &CohorteEvent) {
    let _ = app.emit(EVENT_CHANNEL, event);
}

#[tauri::command(async)]
pub fn cohorte_v3_detect(app: AppHandle, req: CohorteDetectRequest) -> IpcResult<CohorteDetection> {
    let result = match client() {
        Ok(mut connection) => detected(&mut connection, &req.start_dir),
        Err(error)
            if matches!(
                error.code,
                ErrorCode::CohorteCliMissing | ErrorCode::CohorteCliIncompatible
            ) =>
        {
            Ok(CohorteDetection {
                start_dir: req.start_dir,
                state: if error.code == ErrorCode::CohorteCliMissing {
                    "cli-missing"
                } else {
                    "cli-incompatible"
                }
                .into(),
                root: None,
                dir: None,
                found_via: None,
                has_project_file: false,
                state_backend: None,
                root_branch: None,
                runtime: None,
                cli: CliInfo {
                    installed: error.code != ErrorCode::CohorteCliMissing,
                    version: None,
                    supported_range: "cohorte/1".into(),
                    compatible: false,
                },
                cli_executable: Some(python_rpc::cli()),
                cli_data_dir: std::env::var("COHORTE_PYTHON_DATA_DIR").ok(),
                initialization: None,
                pending_requests: None,
                checked_at: now_ms(),
            })
        }
        Err(error) => Err(error),
    };
    if let Ok(detection) = &result {
        emit(
            &app,
            &CohorteEvent::DetectionChanged(DetectionChanged {
                detection: detection.clone(),
            }),
        );
    }
    result.into()
}

#[tauri::command(async)]
pub fn cohorte_v3_init(app: AppHandle, req: CohorteInitRequest) -> IpcResult<CohorteDetection> {
    let result = (|| {
        let mut connection = client()?;
        let initialized = connection.call(
            "projects.init",
            json!({"path": req.project_root, "request_id": python_rpc::mutation_id()}),
        )?;
        let mut detection = detected(&mut connection, &req.project_root)?;
        let questions = initialized["questions"]
            .as_array()
            .map(|questions| {
                questions
                    .iter()
                    .map(|question| {
                        super::sanitize::summary(
                            question
                                .as_str()
                                .unwrap_or("Project discovery needs review"),
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut analysis = initialized["analysis"].clone();
        super::sanitize::sanitize_value(&mut analysis, None);
        detection.initialization = Some(super::Initialization {
            needs_review: !questions.is_empty(),
            questions,
            analysis: Some(analysis),
        });
        Ok(detection)
    })();
    if let Ok(detection) = &result {
        emit(
            &app,
            &CohorteEvent::DetectionChanged(DetectionChanged {
                detection: detection.clone(),
            }),
        );
    }
    result.into()
}

#[tauri::command(async)]
pub fn cohorte_v3_list_runs(
    state: State<'_, Arc<PythonState>>,
    req: CohorteRootRequest,
) -> IpcResult<Vec<CohorteRun>> {
    client()
        .and_then(|mut c| runs(&mut c, &req.root, cursor(&state, &req.root)))
        .into()
}

#[tauri::command(async)]
pub fn cohorte_v3_get_run(
    state: State<'_, Arc<PythonState>>,
    req: CohorteRunRequest,
) -> IpcResult<CohorteRun> {
    client()
        .and_then(|mut c| get_run(&mut c, &req.root, &req.run_id, cursor(&state, &req.root)))
        .into()
}

#[tauri::command(async)]
pub fn cohorte_v3_run_log(req: CohorteRunLogRequest) -> IpcResult<Vec<LogEntry>> {
    (|| {
        let mut after = 0;
        let mut entries = Vec::new();
        loop {
            let batch = client()?.call(
                "events.subscribe",
                json!({"run_id":req.run_id,"after_seq":after}),
            )?;
            let page = items(&batch)?;
            if page.is_empty() {
                break;
            }
            for raw in page {
                if let Some(row) = log_entry(raw) {
                    after = row.sequence;
                    entries.push(row);
                }
            }
            if entries.len() > 500 {
                entries.drain(..entries.len() - 500);
            }
        }
        let limit = req.limit.unwrap_or(200).clamp(1, 500) as usize;
        Ok(entries
            .into_iter()
            .rev()
            .take(limit)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect())
    })()
    .into()
}

#[tauri::command(async)]
pub fn cohorte_v3_watch(
    app: AppHandle,
    state: State<'_, Arc<PythonState>>,
    req: CohorteWatchRequest,
) -> IpcResult<Option<()>> {
    let mut watchers = state.watchers.lock().unwrap_or_else(|e| e.into_inner());
    watchers.retain(|root, active| {
        let keep = req.roots.contains(root);
        if !keep {
            active.store(false, Ordering::Relaxed);
        }
        keep
    });
    for root in req.roots {
        if watchers.contains_key(&root) {
            continue;
        }
        let active = Arc::new(AtomicBool::new(true));
        watchers.insert(root.clone(), active.clone());
        let state = state.inner().clone();
        let app = app.clone();
        thread::spawn(move || watch::watch_loop(state, app, root, active));
    }
    ok(None)
}

#[tauri::command(async)]
pub fn cohorte_v3_features(req: CohorteRootRequest) -> IpcResult<Vec<FeatureChoice>> {
    (|| {
        let mut connection = client()?;
        let project = project(&mut connection, &req.root)?;
        let project_id = project["id"]
            .as_str()
            .ok_or_else(|| bad("Project has no id"))?;
        let list = connection.call("features.list", json!({"project_id":project_id}))?;
        let mut choices = Vec::new();
        for feature in items(&list)? {
            let Some(id) = feature["id"].as_str() else {
                continue;
            };
            let mut artifacts = Vec::new();
            let mut phase = None;
            for (prefix, kind, next_phase) in [
                ("intake", "intake-report", "intake"),
                ("brief", "brief", "brainstorm"),
                ("draft", "feature-spec-draft", "spec"),
                ("ready", "ready", "frozen"),
            ] {
                match connection.call(
                    "artifacts.get",
                    json!({"id":format!("{prefix}:{id}"),"revision":1,"limit":0}),
                ) {
                    Ok(_) => {
                        artifacts.push(kind.into());
                        phase = Some(next_phase.into());
                    }
                    Err(error)
                        if error
                            .detail
                            .as_ref()
                            .is_some_and(|detail| detail["code"] == "NOT_FOUND") => {}
                    Err(error) => return Err(error),
                }
            }
            choices.push(FeatureChoice {
                id: id.into(),
                title: feature["title"].as_str().unwrap_or(id).into(),
                status: feature["status"].as_str().unwrap_or("unknown").into(),
                kind: feature["kind"].as_str().unwrap_or("unknown").into(),
                updated_at: millis_or_zero(&feature["updated_at"]),
                phase,
                artifacts,
            });
        }
        Ok(choices)
    })()
    .into()
}

#[tauri::command(async)]
pub fn cohorte_v3_start(
    state: State<'_, Arc<PythonState>>,
    req: StartRequest,
) -> IpcResult<CohorteRun> {
    execution::start(&state, req).into()
}

fn respond_value(
    root: &str,
    run_id: &str,
    request_id: &str,
    response: Value,
    stop_run: bool,
) -> Result<CommandOutcome, AppError> {
    let mut connection = client()?;
    let registered = project(&mut connection, root)?;
    if !run_id.is_empty() {
        let run = connection.call("runs.get", json!({"run_id":run_id}))?;
        if run["project_id"] != registered["id"] {
            return Err(AppError::new(
                ErrorCode::CohorteRejected,
                "This run belongs to another project",
            ));
        }
    }
    let list = connection.call(
        "requests.list",
        if run_id.is_empty() {
            json!({"status":"pending"})
        } else {
            json!({"run_id":run_id,"status":"pending"})
        },
    )?;
    let request = items(&list)?
        .iter()
        .find(|r| {
            r["id"] == request_id
                && inbox::unexpired(r)
                && if run_id.is_empty() {
                    r["run_id"].is_null()
                } else {
                    r["run_id"] == run_id
                }
        })
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::CohorteGateNotPending,
                "Request is no longer pending",
            )
        })?;
    if run_id.is_empty() {
        let features = connection.call("features.list", json!({"project_id":registered["id"]}))?;
        if !inbox::belongs(request, &registered, items(&features)?) {
            return Err(AppError::new(
                ErrorCode::CohorteRejected,
                "This pending request does not belong to this project",
            ));
        }
        if stop_run {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "A project request has no run to cancel",
            ));
        }
    }
    if run_id.is_empty()
        && response["approved"] == true
        && inbox::review_text(&mut connection, &registered, request)?.is_none()
    {
        return Err(AppError::new(ErrorCode::CohorteRejected,"Exact review evidence is unavailable or stale; review this request in native Cohorte before approving it."));
    }
    let hash = request["subject_hash"]
        .as_str()
        .ok_or_else(|| bad("Request has no subject hash"))?;
    connection.call(
        "requests.respond",
        json!({
            "request_id": request_id,
            "response_id": python_rpc::mutation_id(),
            "subject_hash": hash,
            "response": response
        }),
    )?;
    let mut steps = vec![CommandStep {
        cli: "cohorte/1 requests.respond".into(),
        outcome: "completed".into(),
        exit_code: Some(0),
        message: None,
        error_code: None,
    }];
    if stop_run {
        let current = connection.call("runs.get", json!({"run_id":run_id}))?;
        connection.call(
            "runs.cancel",
            json!({"run_id":run_id,"request_id":python_rpc::mutation_id(),"expected_version":current["state_version"]}),
        )?;
        steps.push(CommandStep {
            cli: "cohorte/1 runs.cancel".into(),
            outcome: "completed".into(),
            exit_code: Some(0),
            message: None,
            error_code: None,
        });
    }
    Ok(CommandOutcome {
        run_id: run_id.into(),
        steps,
        run: if run_id.is_empty() {
            None
        } else {
            Some(get_run(&mut connection, root, run_id, 0)?)
        },
    })
}

fn respond(
    root: &str,
    run_id: &str,
    request_id: &str,
    approved: bool,
    stop_run: bool,
) -> Result<CommandOutcome, AppError> {
    respond_value(
        root,
        run_id,
        request_id,
        json!({"approved":approved}),
        stop_run,
    )
}

#[tauri::command(async)]
pub fn cohorte_v3_answer(req: AnswerRequest) -> IpcResult<CommandOutcome> {
    let answer = req.answer.trim();
    if answer.is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Answer cannot be empty",
        ))
        .into();
    }
    respond_value(
        &req.root,
        &req.run_id,
        &req.approval_id,
        json!({"answer":answer}),
        false,
    )
    .into()
}

#[tauri::command(async)]
pub fn cohorte_v3_approve(req: super::CohorteApproveRequest) -> IpcResult<CommandOutcome> {
    respond(&req.root, &req.run_id, &req.approval_id, true, false).into()
}

#[tauri::command(async)]
pub fn cohorte_v3_deny(
    state: State<'_, Arc<PythonState>>,
    req: super::CohorteDenyRequest,
) -> IpcResult<CommandOutcome> {
    (|| {
        let mut outcome = respond(
            &req.root,
            &req.run_id,
            &req.approval_id,
            false,
            req.stop_run,
        )?;
        if req.stop_run {
            finish_stop(&state, &req.run_id, &mut outcome)?;
            if let Some(run) = &mut outcome.run {
                run.host.alive = state.workers.alive(&req.run_id);
            }
        }
        Ok(outcome)
    })()
    .into()
}

#[tauri::command(async)]
pub fn cohorte_v3_send_to_fix(_req: super::CohorteSendToFixRequest) -> IpcResult<CommandOutcome> {
    Err(AppError::new(
        ErrorCode::CohorteRejected,
        "This request has no fix action in cohorte/1",
    ))
    .into()
}

fn control(req: CohorteRunControlRequest, method: &str) -> Result<CommandOutcome, AppError> {
    let mut connection = client()?;
    let registered = project(&mut connection, &req.root)?;
    let current = connection.call("runs.get", json!({"run_id":req.run_id}))?;
    if current["project_id"] != registered["id"] {
        return Err(AppError::new(
            ErrorCode::CohorteRejected,
            "This run belongs to another project",
        ));
    }
    connection.call(
        method,
        json!({"run_id":req.run_id,"request_id":python_rpc::mutation_id(),"expected_version":current["state_version"]}),
    )?;
    Ok(CommandOutcome {
        run_id: req.run_id.clone(),
        steps: vec![CommandStep {
            cli: format!("cohorte/1 {method}"),
            outcome: "completed".into(),
            exit_code: Some(0),
            message: None,
            error_code: None,
        }],
        run: Some(get_run(&mut connection, &req.root, &req.run_id, 0)?),
    })
}

#[tauri::command(async)]
pub fn cohorte_v3_pause(
    state: State<'_, Arc<PythonState>>,
    req: CohorteRunControlRequest,
) -> IpcResult<CommandOutcome> {
    (|| {
        let id = req.run_id.clone();
        let mut outcome = control(req, "runs.pause")?;
        finish_stop(&state, &id, &mut outcome)?;
        if let Some(run) = &mut outcome.run {
            run.host.alive = state.workers.alive(&id);
        }
        Ok(outcome)
    })()
    .into()
}

#[tauri::command(async)]
pub fn cohorte_v3_resume(
    state: State<'_, Arc<PythonState>>,
    req: CohorteRunControlRequest,
) -> IpcResult<CommandOutcome> {
    execution::resume(&state, req).into()
}

#[tauri::command(async)]
pub fn cohorte_v3_cancel(
    state: State<'_, Arc<PythonState>>,
    req: CohorteRunControlRequest,
) -> IpcResult<CommandOutcome> {
    (|| {
        let id = req.run_id.clone();
        let mut outcome = control(req, "runs.cancel")?;
        finish_stop(&state, &id, &mut outcome)?;
        if let Some(run) = &mut outcome.run {
            run.host.alive = state.workers.alive(&id);
        }
        Ok(outcome)
    })()
    .into()
}

#[tauri::command(async)]
pub fn cohorte_v3_doctor(req: CohorteRootRequest) -> IpcResult<CohorteDoctorReport> {
    execution::doctor_document(&req.root)
        .and_then(|document| execution::doctor_report(&req.root, &document))
        .into()
}

#[tauri::command(async)]
pub fn cohorte_v3_policy(req: CohorteRootRequest) -> IpcResult<CohortePolicySummary> {
    (|| {
        let mut connection = client()?;
        let registered = project(&mut connection, &req.root)?;
        let detail = connection.call("projects.get", json!({"project_id":registered["id"]}))?;
        let stored_profile = execution::stored_profile(&mut connection, &detail)?;
        let ship_authorization = stored_profile["policy"]["ship_authorization"].as_str();
        Ok(CohortePolicySummary {
            root: req.root,
            gated_steps: ship_authorization
                .filter(|value| *value == "explicit_or_pregranted")
                .map(|_| vec!["ship".into()])
                .unwrap_or_default(),
            unattended: None,
            file: "the registered project profile".into(),
            read_at: now_ms(),
        })
    })()
    .into()
}

#[cfg(test)]
#[path = "python_service_tests.rs"]
mod tests;

/// Stop only processes owned by François; external Cohorte hosts remain external.
pub fn kill_workers(app: &AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<Arc<PythonState>>() {
        for active in state
            .watchers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            active.store(false, Ordering::Relaxed);
        }
        state.workers.shutdown();
    }
}

fn finish_stop(
    state: &PythonState,
    id: &str,
    outcome: &mut CommandOutcome,
) -> Result<(), AppError> {
    if state
        .workers
        .stop_after_request(id, Duration::from_secs(5))?
    {
        outcome.steps.push(CommandStep{cli:"owned worker cleanup".into(),outcome:"pending".into(),exit_code:None,message:Some("Forced termination was necessary. Native task lease cleanup is unverified; wait for confirmed termination or lease expiry before resume.".into()),error_code:Some("WORKER_NOT_STOPPED".into())});
        if let Some(run) = &mut outcome.run {
            run.last_error = Some(super::ErrorInfo {
                code: "WORKER_NOT_STOPPED".into(),
                class: Some("uncertain cleanup".into()),
                message:
                    "The owned process is stopped, but native task lease cleanup is unverified."
                        .into(),
                remediation: Some(
                    "Wait for confirmed task termination or native lease expiry before resuming."
                        .into(),
                ),
                retryable: Some(true),
            });
        }
    }
    Ok(())
}
