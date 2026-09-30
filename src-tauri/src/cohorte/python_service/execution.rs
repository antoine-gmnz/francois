//! Long-running Cohorte CLI execution, distinct from metadata-only RPC intents.
use super::*;
use crate::process_util::OwnedChild;
use std::process::Stdio;
use std::time::Instant;

struct Worker {
    child: Arc<OwnedChild>,
    error: Mutex<Option<AppError>>,
}
#[derive(Default)]
pub(super) struct Workers(Mutex<HashMap<String, Arc<Worker>>>);
impl Workers {
    pub(super) fn alive(&self, id: &str) -> Option<bool> {
        let owner = self.0.lock().unwrap().get(id).cloned()?;
        owner.child.try_wait().ok().map(|status| status.is_none())
    }
    pub(super) fn failure(&self, id: &str) -> Option<AppError> {
        let worker = self.0.lock().unwrap().get(id).cloned()?;
        let error = worker.error.lock().unwrap().clone();
        error
    }
    pub(super) fn stop_after_request(&self, id: &str, grace: Duration) -> Result<bool, AppError> {
        let Some(worker) = self.0.lock().unwrap().get(id).cloned() else {
            return Ok(false);
        };
        let deadline = Instant::now() + grace;
        loop {
            if worker
                .child
                .try_wait()
                .map_err(|_| bad("Could not observe owned worker shutdown"))?
                .is_some()
            {
                let _ = worker.child.wait();
                return Ok(false);
            }
            if Instant::now() >= deadline {
                worker
                    .child
                    .terminate()
                    .map_err(|_| bad("Could not terminate owned worker after stop request"))?;
                *worker.error.lock().unwrap()=Some(AppError::with_detail(ErrorCode::CohorteRejected,"The worker required forced termination; native task lease cleanup is unverified",json!({"code":"WORKER_NOT_STOPPED","retryable":true,"remediation":"Wait for confirmed task termination or native lease expiry before resuming."})));
                return Ok(true);
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
    pub(super) fn shutdown(&self) {
        let workers = self
            .0
            .lock()
            .unwrap()
            .drain()
            .map(|(_, worker)| worker)
            .collect::<Vec<_>>();
        for worker in workers {
            let _ = worker.child.terminate();
        }
    }
    fn launch(&self, root: &str, id: &str, args: Vec<String>) -> Result<(), AppError> {
        let mut workers = self.0.lock().unwrap();
        if workers.get(id).is_some_and(|worker| {
            worker
                .child
                .try_wait()
                .ok()
                .is_some_and(|status| status.is_none())
        }) {
            return Err(AppError::new(
                ErrorCode::CohorteRejected,
                "This Cohorte run already has an owned worker",
            ));
        }
        let mut argv = vec!["--json".into()];
        argv.extend(python_rpc::data_dir_args());
        argv.extend(args);
        let child = Arc::new(
            crate::process_util::spawn(python_rpc::cli())
                .args(argv)
                .current_dir(root)
                .stdout(Stdio::piped())
                .start_owned()
                .map_err(|_| {
                    AppError::new(
                        ErrorCode::CohorteCliMissing,
                        "Could not start the configured Python Cohorte CLI",
                    )
                })?,
        );
        let mut frames = child
            .take_frames()
            .ok_or_else(|| bad("Cohorte worker has no output stream"))?;
        let worker = Arc::new(Worker {
            child,
            error: Mutex::new(None),
        });
        workers.insert(id.into(), worker.clone());
        thread::spawn(move || {
            loop {
                match frames.read_frame() {
                    Ok(Some(frame)) => {
                        if let Ok(document) = serde_json::from_str::<Value>(&frame) {
                            if document["ok"] == false {
                                *worker.error.lock().unwrap() =
                                    Some(python_rpc::remote_error(&document["error"]));
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        *worker.error.lock().unwrap()=Some(bad("Cohorte worker output exceeded the bounded protocol or closed unexpectedly"));
                        let _ = worker.child.terminate();
                        break;
                    }
                }
            }
            if let Ok(status) = worker.child.wait() {
                if !status.success() && worker.error.lock().unwrap().is_none() {
                    *worker.error.lock().unwrap()=Some(AppError::new(ErrorCode::CohorteCommandFailed,format!("Cohorte CLI exited with code {}; run cohorte doctor and inspect this run with the configured CLI",status.code().map(|code|code.to_string()).unwrap_or_else(||"signal".into()))));
                }
            }
        });
        Ok(())
    }
}
impl Drop for Workers {
    fn drop(&mut self) {
        self.shutdown();
    }
}
pub(super) fn actual_data_dir(root: &str) -> Result<String, AppError> {
    if let Some(dir) = python_rpc::data_dir_args().get(1) {
        return Ok(dir.clone());
    }
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Mutex::default);
    let key = python_rpc::cli();
    if let Some(dir) = cache.lock().unwrap().get(&key).cloned() {
        return Ok(dir);
    }
    let document = doctor_document(root)?;
    let dir = document["data_dir"]
        .as_str()
        .ok_or_else(|| bad("Cohorte doctor did not report its actual data directory"))?
        .to_owned();
    cache.lock().unwrap().insert(key, dir.clone());
    Ok(dir)
}
pub(super) fn doctor_document(root: &str) -> Result<Value, AppError> {
    let mut args = vec!["--json".into()];
    args.extend(python_rpc::data_dir_args());
    args.extend(["doctor".into(), "--repo".into(), root.into()]);
    let output = crate::process_util::spawn(python_rpc::cli())
        .args(args)
        .current_dir(root)
        .run_bounded(Duration::from_secs(15), 1024 * 1024);
    if output.spawn_failed {
        return Err(AppError::new(
            ErrorCode::CohorteCliMissing,
            "The configured Python Cohorte CLI is unavailable",
        ));
    }
    if output.timed_out {
        return Err(AppError::new(
            ErrorCode::CohorteTimeout,
            "Cohorte doctor exceeded its 15-second deadline",
        ));
    }
    let document: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| bad("Cohorte doctor returned invalid JSON"))?;
    if document["ok"] != true {
        return Err(python_rpc::remote_error(&document["error"]));
    }
    document
        .get("data")
        .cloned()
        .ok_or_else(|| bad("Cohorte doctor returned no diagnostic document"))
}
pub(super) fn doctor_report(root: &str, document: &Value) -> Result<CohorteDoctorReport, AppError> {
    let mut checks = vec![
        DoctorCheck {
            id: "database".into(),
            status: if document["database"]["ok"] == true {
                "ok"
            } else {
                "error"
            }
            .into(),
            summary: "Cohorte database integrity".into(),
            detail: None,
            remediation: None,
        },
        DoctorCheck {
            id: "project".into(),
            status: if document["project"]["ok"] == true {
                "ok"
            } else {
                "error"
            }
            .into(),
            summary: "Registered project profile and configured checks".into(),
            detail: None,
            remediation: document["project"]["fix"]
                .as_str()
                .map(super::super::sanitize::summary),
        },
    ];
    for finding in document["project"]["findings"]
        .as_array()
        .into_iter()
        .flatten()
    {
        checks.push(DoctorCheck {
            id: finding["code"].as_str().unwrap_or("project-finding").into(),
            status: match finding["status"].as_str() {
                Some("error") => "error",
                Some("warning") => "warn",
                _ => "ok",
            }
            .into(),
            summary: super::super::sanitize::summary(
                finding["message"].as_str().unwrap_or("Project diagnostic"),
            ),
            detail: None,
            remediation: finding["fix"].as_str().map(super::super::sanitize::summary),
        });
    }
    for provider in document["providers"].as_array().into_iter().flatten() {
        let state = provider["connection_state"].as_str().unwrap_or("unknown");
        checks.push(DoctorCheck {
            id: provider["provider"].as_str().unwrap_or("provider").into(),
            status: if matches!(state, "connected" | "ready") {
                "ok"
            } else {
                "warn"
            }
            .into(),
            summary: super::super::sanitize::summary(state),
            detail: provider["runtime_version"].as_str().map(String::from),
            remediation: provider["remediation"]
                .as_str()
                .map(super::super::sanitize::summary),
        });
    }
    let rows = checks
        .iter()
        .map(|check| HealthRow {
            command: format!("cohorte doctor · {}", check.id),
            status: check.status.clone(),
            summary: check.summary.clone(),
            remediation: check.remediation.clone(),
        })
        .collect();
    Ok(CohorteDoctorReport {
        root: root.into(),
        ok: checks.iter().all(|check| check.status != "error"),
        cohorte_version: document["version"].as_str().unwrap_or("unknown").into(),
        generated_at: now_ms(),
        checks,
        rows,
        ran_at: now_ms(),
    })
}
fn native_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && !id.starts_with('-')
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
fn read_bounded(path: &Path) -> Result<Vec<u8>, AppError> {
    let metadata = std::fs::metadata(path).map_err(|_| {
        bad("Frozen Cohorte files are missing; freeze this feature using Cohorte first")
    })?;
    if metadata.len() > 2 * 1024 * 1024 {
        return Err(bad("Frozen Cohorte document exceeds its 2 MiB limit"));
    }
    std::fs::read(path).map_err(|_| bad("Could not read the frozen Cohorte document"))
}
pub(super) fn artifact(client: &mut RpcClient, reference: &Value) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    let mut offset = 0;
    for _ in 0..16 {
        let part=client.call("artifacts.get",json!({"id":reference["id"],"revision":reference["revision"],"offset":offset,"limit":128*1024}))?;
        let content = part["content"]
            .as_str()
            .ok_or_else(|| bad("Cohorte artifact has no content"))?;
        bytes.extend_from_slice(content.as_bytes());
        let next = part["next_offset"]
            .as_u64()
            .ok_or_else(|| bad("Cohorte artifact has no next offset"))?;
        let size = part["size"]
            .as_u64()
            .ok_or_else(|| bad("Cohorte artifact has no size"))?;
        if next == size {
            return Ok(bytes);
        }
        if next <= offset || bytes.len() > 2 * 1024 * 1024 {
            return Err(bad("Cohorte artifact pagination is invalid or too large"));
        }
        offset = next;
    }
    Err(bad("Cohorte artifact exceeded its page limit"))
}
pub(super) fn stored_profile(client: &mut RpcClient, project: &Value) -> Result<Value, AppError> {
    let bytes = artifact(client, &project["profile_ref"])?;
    serde_json::from_slice(&bytes).map_err(|_| bad("Stored project profile is invalid"))
}
fn validate_snapshot(
    spec: &[u8],
    profile: &[u8],
    refs: &Value,
    current: &Value,
    project_id: &str,
    feature_id: &str,
) -> Result<(), AppError> {
    use sha2::Digest;
    for (bytes, key) in [(spec, "spec_ref"), (profile, "profile_ref")] {
        let hash = format!("{:x}", sha2::Sha256::digest(bytes));
        if refs[key]["sha256"] != hash {
            return Err(AppError::new(
                ErrorCode::CohorteRejected,
                "Frozen artifacts changed; review and freeze the spec again in Cohorte",
            ));
        }
    }
    let profile: Value =
        serde_json::from_slice(profile).map_err(|_| bad("Frozen profile is invalid"))?;
    let spec: Value = serde_json::from_slice(spec).map_err(|_| bad("Frozen spec is invalid"))?;
    if profile != *current
        || profile["project_id"] != project_id
        || spec["feature_id"] != feature_id
    {
        return Err(AppError::new(
            ErrorCode::CohorteRejected,
            "The approved project/profile snapshot changed; run cohorte spec for renewed review",
        ));
    }
    Ok(())
}
fn loop_args(
    spec: &Path,
    profile: &Path,
    root: &str,
    worktrees: &Path,
    run_id: &str,
) -> Vec<String> {
    vec![
        "loop".into(),
        spec.to_string_lossy().into_owned(),
        "--profile".into(),
        profile.to_string_lossy().into_owned(),
        "--repo".into(),
        root.into(),
        "--worktrees".into(),
        worktrees.to_string_lossy().into_owned(),
        "--run-id".into(),
        run_id.into(),
        "--live".into(),
    ]
}
pub(super) fn start(state: &PythonState, req: StartRequest) -> Result<CohorteRun, AppError> {
    if !native_id(&req.feature_id)
        || req
            .stage
            .as_deref()
            .is_some_and(|stage| stage != "plan" && stage != "build")
    {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Choose a frozen native feature to start its real build",
        ));
    }
    let mut connection = client()?;
    let registered = project(&mut connection, &req.root)?;
    let project_id = registered["id"]
        .as_str()
        .ok_or_else(|| bad("Project has no id"))?;
    let root = registered["root_path"]
        .as_str()
        .ok_or_else(|| bad("Project has no root"))?;
    let feature = connection.call("features.get", json!({"feature_id":req.feature_id}))?;
    if feature["project_id"] != project_id || feature["status"] != "frozen" {
        return Err(AppError::new(
            ErrorCode::CohorteRejected,
            "This feature is not frozen for the registered project",
        ));
    }
    let detail = connection.call("projects.get", json!({"project_id":project_id}))?;
    let current_profile = stored_profile(&mut connection, &detail)?;
    let doctor = doctor_document(root)?;
    let data_dir = doctor["data_dir"]
        .as_str()
        .ok_or_else(|| bad("Cohorte doctor did not report its actual data directory"))?;
    let location = Path::new(data_dir)
        .join("guided")
        .join(project_id)
        .join(&req.feature_id);
    let spec_path = location.join("frozen.json");
    let profile_path = location.join("profile.json");
    let spec = read_bounded(&spec_path)?;
    let profile = read_bounded(&profile_path)?;
    let ready_id = format!("ready:{}", req.feature_id);
    let mut ready = None;
    for revision in 1..=64 {
        match connection.call(
            "artifacts.get",
            json!({"id":ready_id,"revision":revision,"limit":64*1024}),
        ) {
            Ok(document) => {
                ready = Some(
                    serde_json::from_str::<Value>(
                        document["content"]
                            .as_str()
                            .ok_or_else(|| bad("Ready artifact has no content"))?,
                    )
                    .map_err(|_| bad("Ready artifact is invalid"))?,
                );
            }
            Err(error)
                if ready.is_some()
                    && error
                        .detail
                        .as_ref()
                        .is_some_and(|detail| detail["code"] == "NOT_FOUND") =>
            {
                break
            }
            Err(error) => return Err(error),
        }
        if revision == 64 {
            return Err(bad("Ready artifact revision scan exceeded its limit"));
        }
    }
    let ready = ready.ok_or_else(|| bad("No approved ready artifact exists"))?;
    validate_snapshot(
        &spec,
        &profile,
        &ready,
        &current_profile,
        project_id,
        &req.feature_id,
    )?;
    if artifact(&mut connection, &ready["spec_ref"])? != spec
        || artifact(&mut connection, &ready["profile_ref"])? != profile
    {
        return Err(bad(
            "Frozen files no longer match stored approved artifacts",
        ));
    }
    let run_id = format!("{}-{}", req.feature_id, uuid::Uuid::new_v4());
    state.workers.launch(
        root,
        &run_id,
        loop_args(
            &spec_path,
            &profile_path,
            root,
            &Path::new(data_dir).join("worktrees"),
            &run_id,
        ),
    )?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match get_run(&mut connection,root,&run_id,0) {
            Ok(mut run)=>{ run.host.alive=state.workers.alive(&run_id); return Ok(run); },
            Err(_) if state.workers.alive(&run_id)==Some(false)=>return Err(state.workers.failure(&run_id).unwrap_or_else(||AppError::new(ErrorCode::CohorteCommandFailed,"Cohorte execution exited before creating its run; run doctor with the configured CLI"))),
            Err(error) if Instant::now()>=deadline=>return Err(error), Err(_)=>thread::sleep(Duration::from_millis(100)),
        }
    }
}
pub(super) fn resume(
    state: &PythonState,
    req: CohorteRunControlRequest,
) -> Result<CommandOutcome, AppError> {
    if !native_id(&req.run_id) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Invalid native run id",
        ));
    }
    let mut connection = client()?;
    let registered = project(&mut connection, &req.root)?;
    let current = connection.call("runs.get", json!({"run_id":req.run_id}))?;
    if current["project_id"] != registered["id"] {
        return Err(AppError::new(
            ErrorCode::CohorteRejected,
            "This run belongs to another project",
        ));
    }
    if !history::has_context(&mut connection, &req.run_id)? {
        return Err(AppError::new(ErrorCode::CohorteRejected,"This metadata-only run has no native execution context; start its frozen feature instead"));
    }
    if !matches!(
        current["status"].as_str(),
        Some("running" | "paused" | "failed")
    ) {
        return Err(AppError::new(
            ErrorCode::CohorteRejected,
            "This native run cannot resume; answer its pending request or start a new run",
        ));
    }
    let root = registered["root_path"]
        .as_str()
        .ok_or_else(|| bad("Project has no root"))?;
    state.workers.launch(
        root,
        &req.run_id,
        vec!["resume".into(), req.run_id.clone(), "--live".into()],
    )?;
    let mut run = get_run(&mut connection, root, &req.run_id, 0)?;
    run.host.alive = state.workers.alive(&req.run_id);
    Ok(CommandOutcome {
        run_id: req.run_id,
        steps: vec![CommandStep {
            cli: "cohorte resume --live".into(),
            outcome: "pending".into(),
            exit_code: None,
            message: Some("Native execution was started; follow its durable run events".into()),
            error_code: None,
        }],
        run: Some(run),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_rejects_changed_profile_and_native_loop_uses_explicit_paths() {
        use sha2::Digest;
        let spec = br#"{"feature_id":"f"}"#;
        let profile = br#"{"project_id":"p","checks":[]}"#;
        let refs = json!({"spec_ref":{"sha256":format!("{:x}",sha2::Sha256::digest(spec))},"profile_ref":{"sha256":format!("{:x}",sha2::Sha256::digest(profile))}});
        let current: Value = serde_json::from_slice(profile).unwrap();
        assert!(validate_snapshot(spec, profile, &refs, &current, "p", "f").is_ok());
        assert!(validate_snapshot(
            spec,
            profile,
            &refs,
            &json!({"project_id":"p","checks":["changed"]}),
            "p",
            "f"
        )
        .is_err());
        assert!(validate_snapshot(spec, profile, &refs, &current, "other", "f").is_err());
        assert_eq!(
            loop_args(
                Path::new("/data/frozen.json"),
                Path::new("/data/profile.json"),
                "/repo",
                Path::new("/data/worktrees"),
                "f-run"
            ),
            vec![
                "loop",
                "/data/frozen.json",
                "--profile",
                "/data/profile.json",
                "--repo",
                "/repo",
                "--worktrees",
                "/data/worktrees",
                "--run-id",
                "f-run",
                "--live"
            ]
        );
    }
}

#[cfg(all(test, unix))]
mod cleanup_tests {
    use super::*;
    #[test]
    fn only_observed_workers_have_liveness_and_shutdown_reaps_owned_tree() {
        let workers = Workers::default();
        assert_eq!(workers.alive("external"), None);
        let child = Arc::new(
            crate::process_util::spawn("/bin/sh")
                .args(["-c", "sleep 30"])
                .start_owned()
                .unwrap(),
        );
        workers.0.lock().unwrap().insert(
            "own".into(),
            Arc::new(Worker {
                child: child.clone(),
                error: Mutex::new(None),
            }),
        );
        assert_eq!(workers.alive("own"), Some(true));
        workers.stop_after_request("own", Duration::ZERO).unwrap();
        assert_eq!(workers.alive("own"), Some(false));
        workers.shutdown();
        assert!(child.try_wait().unwrap().is_some());
        assert_eq!(workers.alive("own"), None);
    }
}

#[cfg(all(test, unix))]
mod graceful_stop_tests {
    use super::*;
    #[test]
    fn stop_allows_native_cleanup_before_forcing_and_reports_lease_uncertainty() {
        let workers = Workers::default();
        let graceful = Arc::new(
            crate::process_util::spawn("/bin/sh")
                .args(["-c", "sleep 0.05"])
                .start_owned()
                .unwrap(),
        );
        workers.0.lock().unwrap().insert(
            "graceful".into(),
            Arc::new(Worker {
                child: graceful.clone(),
                error: Mutex::new(None),
            }),
        );
        assert!(!workers
            .stop_after_request("graceful", Duration::from_secs(1))
            .unwrap());
        assert!(graceful.try_wait().unwrap().unwrap().success());
        let forced = Arc::new(
            crate::process_util::spawn("/bin/sh")
                .args(["-c", "sleep 30"])
                .start_owned()
                .unwrap(),
        );
        workers.0.lock().unwrap().insert(
            "forced".into(),
            Arc::new(Worker {
                child: forced,
                error: Mutex::new(None),
            }),
        );
        assert!(workers
            .stop_after_request("forced", Duration::from_millis(20))
            .unwrap());
        assert_eq!(
            workers.failure("forced").unwrap().detail.unwrap()["code"],
            "WORKER_NOT_STOPPED"
        );
    }
}
