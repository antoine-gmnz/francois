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

const EVENT_CHANNEL: &str = "francois://cohorte/event";

#[derive(Default)]
pub struct PythonState {
    watchers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    cursors: Mutex<HashMap<String, u64>>,
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
            checked_at: now_ms(),
        });
    }
    let project = project_for(client, path)?;
    let root = project
        .as_ref()
        .and_then(|p| p["root_path"].as_str())
        .map(str::to_owned);
    let found = root.is_some();
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
            version: None,
            supported_range: "cohorte/1".into(),
            compatible: true,
        },
        checked_at: now_ms(),
    })
}

fn project(client: &mut RpcClient, root: &str) -> Result<Value, AppError> {
    project_for(client, Path::new(root))?
        .ok_or_else(|| not_found("Cohorte project is not registered"))
}

fn gate_for(run_id: &str, requests: &[Value]) -> Option<Gate> {
    let pending: Vec<&Value> = requests
        .iter()
        .filter(|r| r["status"] == "pending")
        .collect();
    let request = *pending.first()?;
    let id = request["id"].as_str()?.to_owned();
    let kind = request["kind"].as_str().unwrap_or("question").to_owned();
    let is_question = kind == "question";
    let payload = &request["payload"];
    let reason = payload["reason"]
        .as_str()
        .or_else(|| payload["question"].as_str())
        .unwrap_or(&kind)
        .to_owned();
    let options = payload["options"].as_array().map(|v| {
        v.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    });
    let approve = GateAction {
        id: "approve".into(),
        stops_run: false,
        cli: vec![],
    };
    let deny = GateAction {
        id: "deny".into(),
        stops_run: kind == "ship",
        cli: vec![],
    };
    Some(Gate {
        run_id: run_id.into(),
        request: ApprovalRequest {
            approval_id: id,
            kind,
            agent: None,
            phase: None,
            tool: None,
            affected_paths: vec![],
            preview: ApprovalPreview {
                kind: "text".into(),
                text: reason.clone(),
                truncated: false,
            },
            options,
            rule_id: "cohorte/1".into(),
            reason,
            asks: vec![],
            allowed_decisions: vec![],
            expires_at: None,
            unattended: "wait".into(),
            cli: "Cohorte local service".into(),
        },
        requested_at: millis(&request["created_at"]),
        phase_index: None,
        phase_count: 0,
        findings: vec![],
        actions: if is_question {
            vec![]
        } else {
            vec![approve, deny]
        },
        more_pending: pending.len().saturating_sub(1) as u64,
    })
}

fn run_view(status: &str, has_gate: bool) -> &'static str {
    match status {
        "queued" => "idle",
        "waiting_user" if has_gate => "gate",
        "waiting_user" => "waiting",
        "waiting_auth" => "auth",
        "waiting_quota" => "quota",
        "paused" => "paused",
        "blocked" | "blocked_uncertain" => "blocked",
        "failed" => "failed",
        "completed" => "completed",
        "cancelled" => "cancelled",
        _ => "running",
    }
}

fn project_run(
    client: &mut RpcClient,
    root: &str,
    raw: &Value,
    cursor: u64,
) -> Result<CohorteRun, AppError> {
    let run_id = raw["id"].as_str().ok_or_else(|| bad("Run has no id"))?;
    let feature_id = raw["feature_id"]
        .as_str()
        .ok_or_else(|| bad("Run has no feature id"))?;
    let feature = client
        .call("features.get", json!({"feature_id":feature_id}))
        .ok();
    let requests = client.call("requests.list", json!({"run_id":run_id,"status":"pending"}))?;
    let gate = gate_for(run_id, items(&requests)?);
    let status = raw["status"].as_str().unwrap_or("queued");
    let stage = raw["stage"].as_str().unwrap_or("plan").to_ascii_uppercase();
    let started = millis(&raw["created_at"]);
    let updated = millis(&raw["updated_at"]);
    let terminal = matches!(status, "completed" | "cancelled" | "failed");
    let title = feature
        .as_ref()
        .and_then(|f| f["title"].as_str())
        .unwrap_or(feature_id)
        .to_owned();
    let phase = Phase {
        state: stage.clone(),
        label: stage.to_ascii_lowercase(),
        status: if terminal { "completed" } else { "running" }.into(),
        iteration: 1,
        started_at: Some(started),
        ended_at: terminal.then_some(updated),
        duration_ms: None,
        outcome: None,
        steps: vec![],
        checks: vec![],
    };
    Ok(CohorteRun {
        project_root: root.into(),
        run_id: run_id.into(),
        title,
        spec_id: feature_id.into(),
        spec_kind: feature
            .as_ref()
            .and_then(|f| f["kind"].as_str())
            .map(str::to_owned),
        profile: "feature".into(),
        state: if status == "running" {
            stage.clone()
        } else {
            status.to_ascii_uppercase()
        },
        view: run_view(status, gate.is_some()).into(),
        current_phase: Some(stage),
        resume_to: None,
        since: updated,
        started_at: started,
        ended_at: terminal.then_some(updated),
        stop: None,
        last_error: None,
        iteration: RunIteration::default(),
        host: RunHost {
            alive: true,
            heartbeat_at: None,
            pid: None,
        },
        git: RunGit {
            base_branch: "main".into(),
            base_sha: raw["base_commit"].as_str().map(str::to_owned),
            ..RunGit::default()
        },
        runtime: None,
        snapshot_digest: raw["candidate_tree_hash"].as_str().map(str::to_owned),
        cohorte_version: None,
        unattended: None,
        phases: vec![phase],
        worktrees: vec![],
        gate,
        review: None,
        artifacts: vec![],
        usage: None,
        last_sequence: cursor,
        tail_truncated: false,
        refreshed_at: now_ms(),
    })
}

fn get_run(
    client: &mut RpcClient,
    root: &str,
    run_id: &str,
    cursor: u64,
) -> Result<CohorteRun, AppError> {
    let raw = client.call("runs.get", json!({"run_id":run_id}))?;
    project_run(client, root, &raw, cursor)
}

fn runs(client: &mut RpcClient, root: &str, cursor: u64) -> Result<Vec<CohorteRun>, AppError> {
    let project = project(client, root)?;
    let project_id = project["id"]
        .as_str()
        .ok_or_else(|| bad("Project has no id"))?;
    let list = client.call("runs.list", json!({"project_id":project_id}))?;
    items(&list)?
        .iter()
        .map(|raw| project_run(client, root, raw, cursor))
        .collect()
}

fn log_entry(raw: &Value) -> Option<LogEntry> {
    Some(LogEntry {
        run_id: raw["run_id"].as_str()?.into(),
        sequence: raw["seq"].as_u64()?,
        sub: 0,
        at: millis(&raw["occurred_at"]),
        type_: raw["type"].as_str()?.into(),
        severity: "info".into(),
        summary: raw["type"].as_str()?.into(),
        agent_id: None,
        phase: None,
    })
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

fn wire_event(root: &str, raw: &Value) -> Option<CohorteEvent> {
    let entry = log_entry(raw)?;
    Some(CohorteEvent::Unknown(UnknownEvent {
        header: EventHeader {
            project_root: root.into(),
            run_id: entry.run_id,
            event_id: raw["event_id"].as_str().unwrap_or("").into(),
            sequence: entry.sequence,
            sub: 0,
            durability: "durable".into(),
            at: entry.at,
            source: "cohorte/1".into(),
            severity: entry.severity,
            summary: entry.summary,
            phase: None,
            agent: None,
            causation_id: None,
        },
        cohorte_type: entry.type_,
        malformed: false,
    }))
}

fn process_event(
    state: &PythonState,
    app: &AppHandle,
    root: &str,
    raw: &Value,
    gates: &mut HashMap<String, String>,
) -> Result<(), AppError> {
    let seq = raw["seq"]
        .as_u64()
        .ok_or_else(|| bad("Cohorte event has no sequence"))?;
    if seq <= cursor(state, root) {
        return Ok(());
    }
    let run_id = raw["run_id"].as_str();
    let run = if let Some(id) = run_id {
        Some(get_run(&mut client()?, root, id, seq)?)
    } else {
        None
    };
    if let Some(event) = wire_event(root, raw) {
        emit(app, &event);
    }
    if let Some(run) = run {
        let next_gate = run.gate.as_ref().map(|g| g.request.approval_id.clone());
        if let (Some(gate), false) = (
            run.gate.as_ref(),
            gates.get(&run.run_id) == next_gate.as_ref(),
        ) {
            emit(
                app,
                &CohorteEvent::GateOpened(super::catalogue::GateOpened {
                    project_root: root.into(),
                    gate: Box::new(gate.clone()),
                }),
            );
        }
        if let Some(previous) = gates.get(&run.run_id) {
            if next_gate.as_ref() != Some(previous) {
                emit(
                    app,
                    &CohorteEvent::GateResolved(super::catalogue::GateResolved {
                        project_root: root.into(),
                        run_id: run.run_id.clone(),
                        approval_id: previous.clone(),
                        decision: "unknown".into(),
                        actor: None,
                    }),
                );
            }
        }
        if let Some(gate) = next_gate {
            gates.insert(run.run_id.clone(), gate);
        } else {
            gates.remove(&run.run_id);
        }
        emit(
            app,
            &CohorteEvent::RunUpdated(RunUpdated { run: Box::new(run) }),
        );
    }
    state
        .cursors
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(root.into(), seq);
    Ok(())
}

fn watch_loop(state: Arc<PythonState>, app: AppHandle, root: String, active: Arc<AtomicBool>) {
    let mut gates = HashMap::new();
    while active.load(Ordering::Relaxed) {
        let result = (|| -> Result<(), AppError> {
            let mut connection = client()?;
            let project = project(&mut connection, &root)?;
            let project_id = project["id"]
                .as_str()
                .ok_or_else(|| bad("Project has no id"))?;
            for run in runs(&mut connection, &root, cursor(&state, &root))? {
                if let Some(gate) = &run.gate {
                    gates.insert(run.run_id.clone(), gate.request.approval_id.clone());
                }
                emit(
                    &app,
                    &CohorteEvent::RunUpdated(RunUpdated { run: Box::new(run) }),
                );
            }
            let subscribed = connection.call(
                "events.subscribe",
                json!({"project_id": project_id, "after_seq": cursor(&state, &root)}),
            )?;
            for raw in items(&subscribed)? {
                process_event(&state, &app, &root, raw, &mut gates)?;
            }
            emit(
                &app,
                &CohorteEvent::WatchStatus(super::catalogue::WatchStatus {
                    project_root: root.clone(),
                    healthy: true,
                    error: None,
                    next_poll_in_ms: 0,
                }),
            );
            while active.load(Ordering::Relaxed) {
                let frame = match connection.read_frame() {
                    Ok(frame) => frame,
                    Err(error) if error.code == ErrorCode::CohorteTimeout => continue,
                    Err(error) => return Err(error),
                };
                if frame["method"] == "events.notification" {
                    process_event(&state, &app, &root, &frame["params"], &mut gates)?;
                }
            }
            Ok(())
        })();
        if result.is_err() && active.load(Ordering::Relaxed) {
            emit(
                &app,
                &CohorteEvent::WatchStatus(super::catalogue::WatchStatus {
                    project_root: root.clone(),
                    healthy: false,
                    error: Some(super::catalogue::WatchError {
                        code: ErrorCode::CohorteCommandFailed,
                        message: "Cohorte service disconnected; replay will resume".into(),
                    }),
                    next_poll_in_ms: 1000,
                }),
            );
            thread::sleep(Duration::from_secs(1));
        }
    }
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
        connection.call(
            "projects.init",
            json!({"path": req.project_root, "request_id": python_rpc::mutation_id()}),
        )?;
        detected(&mut connection, &req.project_root)
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
        thread::spawn(move || watch_loop(state, app, root, active));
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
        Ok(items(&list)?
            .iter()
            .filter_map(|f| {
                Some(FeatureChoice {
                    id: f["id"].as_str()?.into(),
                    title: f["title"].as_str()?.into(),
                    status: f["status"].as_str().unwrap_or("unknown").into(),
                    kind: f["kind"].as_str().unwrap_or("unknown").into(),
                    updated_at: millis_or_zero(&f["updated_at"]),
                })
            })
            .collect())
    })()
    .into()
}

#[tauri::command(async)]
pub fn cohorte_v3_start(req: StartRequest) -> IpcResult<CohorteRun> {
    (|| {
        let mut connection = client()?;
        let project = project(&mut connection, &req.root)?;
        let project_id = project["id"]
            .as_str()
            .ok_or_else(|| bad("Project has no id"))?;
        let started = connection.call(
            "runs.start",
            json!({
                "project_id":project_id,
                "feature_id":req.feature_id,
                "path":req.root,
                "stage":req.stage.unwrap_or_else(|| "plan".into()),
                "request_id":python_rpc::mutation_id(),
            }),
        )?;
        let run_id = started["run_id"]
            .as_str()
            .ok_or_else(|| bad("Run start returned no id"))?;
        get_run(&mut connection, &req.root, run_id, 0)
    })()
    .into()
}

fn respond_value(
    root: &str,
    run_id: &str,
    request_id: &str,
    response: Value,
    stop_run: bool,
) -> Result<CommandOutcome, AppError> {
    let mut connection = client()?;
    let list = connection.call("requests.list", json!({"run_id":run_id,"status":"pending"}))?;
    let request = items(&list)?
        .iter()
        .find(|r| r["id"] == request_id)
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::CohorteGateNotPending,
                "Request is no longer pending",
            )
        })?;
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
        exit_code: 0,
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
            exit_code: 0,
            message: None,
            error_code: None,
        });
    }
    Ok(CommandOutcome {
        run_id: run_id.into(),
        steps,
        run: Some(get_run(&mut connection, root, run_id, 0)?),
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
pub fn cohorte_v3_deny(req: super::CohorteDenyRequest) -> IpcResult<CommandOutcome> {
    respond(
        &req.root,
        &req.run_id,
        &req.approval_id,
        false,
        req.stop_run,
    )
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
    let current = connection.call("runs.get", json!({"run_id":req.run_id}))?;
    connection.call(
        method,
        json!({"run_id":req.run_id,"request_id":python_rpc::mutation_id(),"expected_version":current["state_version"]}),
    )?;
    Ok(CommandOutcome {
        run_id: req.run_id.clone(),
        steps: vec![CommandStep {
            cli: format!("cohorte/1 {method}"),
            outcome: "completed".into(),
            exit_code: 0,
            message: None,
            error_code: None,
        }],
        run: Some(get_run(&mut connection, &req.root, &req.run_id, 0)?),
    })
}

#[tauri::command(async)]
pub fn cohorte_v3_pause(req: CohorteRunControlRequest) -> IpcResult<CommandOutcome> {
    control(req, "runs.pause").into()
}

#[tauri::command(async)]
pub fn cohorte_v3_resume(req: CohorteRunControlRequest) -> IpcResult<CommandOutcome> {
    control(req, "runs.resume").into()
}

#[tauri::command(async)]
pub fn cohorte_v3_cancel(req: CohorteRunControlRequest) -> IpcResult<CommandOutcome> {
    control(req, "runs.cancel").into()
}

#[tauri::command(async)]
pub fn cohorte_v3_doctor(req: CohorteRootRequest) -> IpcResult<CohorteDoctorReport> {
    (|| {
        let mut connection = client()?;
        project(&mut connection, &req.root)?;
        let health = connection.call("health.get", json!({}))?;
        let version = health["version"].as_str().unwrap_or("cohorte/1").to_owned();
        let check = DoctorCheck {
            id: "service".into(),
            status: "ok".into(),
            summary: "Local Cohorte service is responding".into(),
            detail: None,
            remediation: None,
        };
        Ok(CohorteDoctorReport {
            root: req.root,
            ok: true,
            cohorte_version: version,
            generated_at: now_ms(),
            checks: vec![check],
            rows: vec![HealthRow {
                command: "cohorte/1 health.get".into(),
                status: "ok".into(),
                summary: "Local service is responding".into(),
                remediation: None,
            }],
            ran_at: now_ms(),
        })
    })()
    .into()
}

#[tauri::command(async)]
pub fn cohorte_v3_policy(req: CohorteRootRequest) -> IpcResult<CohortePolicySummary> {
    (|| {
        let mut connection = client()?;
        let registered = project(&mut connection, &req.root)?;
        let detail = connection.call("projects.get", json!({"project_id":registered["id"]}))?;
        let ship_authorization = detail["profile"]["policy"]["ship_authorization"].as_str();
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
