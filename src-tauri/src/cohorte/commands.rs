//! The `francois:cohorte:<verb>` Tauri surface — the 14 commands of
//! `CohorteCommandMap`. Each is a thin shell over an `Inner::op_*` (unit-
//! tested with a fake runner) and resolves an `IpcResult`: domain failures
//! never reject across the bridge.

use super::actions::{self, Control, IssuedCommands, RunFacts};
use super::cli::{self, argv, Kind, Runner};
use super::detect::{normalise_dir, require_detected};
use super::documents::{
    doctor_rows, gated_steps, parse_config, parse_doctor, unattended, validate_row,
};
use super::{
    CohorteApproveRequest, CohorteDenyRequest, CohorteDetectRequest, CohorteDetection,
    CohorteDoctorReport, CohorteEvent, CohorteInitRequest, CohortePolicySummary,
    CohorteRootRequest, CohorteRun, CohorteRunControlRequest, CohorteRunLogRequest,
    CohorteRunRequest, CohorteSendToFixRequest, CohorteState, CohorteWatchRequest, CommandOutcome,
    Inner, LogEntry, EVENT_CHANNEL,
};
use crate::github::gh::RoutedRun;
use crate::ids::now_ms;
use crate::ipc::{ok, AppError, ErrorCode, IpcResult};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const DEFAULT_LOG_LIMIT: u64 = 200;
const MAX_LOG_LIMIT: u64 = 500;

fn invalid(msg: &str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, msg)
}

fn run_not_found(run_id: &str) -> AppError {
    AppError::with_detail(
        ErrorCode::CohorteRunNotFound,
        format!("no Cohorte run {run_id}"),
        json!({ "runId": run_id }),
    )
}

/// R-4: the runner the run controls use — it records every mutating
/// command this app issues (id from the CLI's CommandResultDocument when it
/// prints one, else its type + run) so a later `command.rejected` can be
/// attributed.
struct Recording<'a>(&'a Inner);

impl Runner for Recording<'_> {
    fn run(
        &self,
        program: &str,
        dir: &str,
        args: &[String],
        timeout: Duration,
        cap: usize,
    ) -> RoutedRun {
        let out = self.0.runner.run(program, dir, args, timeout, cap);
        let verb = args.first().map(String::as_str).unwrap_or("");
        if let (Some(ty), Some(run_id), false) = (
            IssuedCommands::command_type(verb),
            args.get(1),
            out.spawn_failed || program != "cohorte",
        ) {
            let (id, doc_ty) = cli::command_doc(&out.stdout);
            super::lock(&self.0.issued).record(
                id,
                doc_ty.as_deref().unwrap_or(ty),
                run_id,
                now_ms(),
            );
        }
        out
    }
}

impl Inner {
    /// The detected Cohorte root for `root`, or the detection's error code.
    fn require(&self, root: &str) -> Result<String, AppError> {
        if root.trim().is_empty() {
            return Err(invalid("root is required"));
        }
        require_detected(&self.detect(root, false))
    }

    fn run_lock(&self, run_id: &str) -> Arc<Mutex<()>> {
        self.run_locks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(run_id.to_string())
            .or_default()
            .clone()
    }

    /// Pre-check facts from the projection, loading the run first if unknown.
    fn facts(
        &self,
        root: &str,
        run_id: &str,
        approval: Option<&str>,
    ) -> Result<RunFacts, AppError> {
        argv::status(Some(run_id))?;
        let known = self.existing_root(root).is_some_and(|h| {
            h.lock()
                .unwrap_or_else(|e| e.into_inner())
                .runs
                .contains_key(run_id)
        });
        if !known {
            self.refresh_run(root, run_id)?;
        }
        let h = self.root_handle(root);
        let w = h.lock().unwrap_or_else(|e| e.into_inner());
        let slot = w.runs.get(run_id).ok_or_else(|| run_not_found(run_id))?;
        Ok(RunFacts {
            state: slot.proj.state().to_string(),
            approval_pending: approval.is_some_and(|a| slot.proj.is_pending(a)),
            options: approval
                .and_then(|a| slot.proj.request(a))
                .and_then(|r| r.options.clone()),
        })
    }

    pub(crate) fn op_detect(
        &self,
        req: &CohorteDetectRequest,
    ) -> Result<CohorteDetection, AppError> {
        if req.start_dir.trim().is_empty() {
            return Err(invalid("startDir is required"));
        }
        Ok(self.detect(&req.start_dir, req.force.unwrap_or(false)))
    }

    /// FR-10.
    pub(crate) fn op_doctor(&self, root: &str) -> Result<CohorteDoctorReport, AppError> {
        let root = self.require(root)?;
        let a = argv::doctor();
        let out = cli::run(
            self.runner.as_ref(),
            Kind::Read,
            &root,
            &a,
            cli::DOCTOR_TIMEOUT,
            cli::READ_CAP,
        );
        // dev.1's doctor prints its whole report and then lingers past the
        // deadline: a complete document printed in time is still the answer.
        let early = out.timed_out.then(|| parse_doctor(&out.stdout)).flatten();
        if early.is_none() {
            if let Some(e) = cli::read_failure(&a, &out, cli::DOCTOR_TIMEOUT, cli::READ_CAP) {
                return Err(e);
            }
        }
        let doc = match early.or_else(|| parse_doctor(&out.stdout)) {
            Some(d) if out.timed_out || out.code == 0 || out.code == 1 => d,
            _ if out.code != 0 => return Err(cli::command_failed(&a, &out)),
            _ => return Err(cli::output_invalid(&a)),
        };
        let v = argv::config_validate();
        let vout = cli::run(
            self.runner.as_ref(),
            Kind::Read,
            &root,
            &v,
            cli::READ_TIMEOUT,
            cli::READ_CAP,
        );
        let validate = match cli::read_failure(&v, &vout, cli::READ_TIMEOUT, cli::READ_CAP) {
            Some(e) => validate_row(-1, e.message.as_bytes(), ""),
            None => validate_row(vout.code, &vout.stdout, &vout.stderr),
        };
        let now = now_ms();
        Ok(CohorteDoctorReport {
            ok: doc.ok,
            cohorte_version: self.cli_info(&root, false).version.unwrap_or_default(),
            generated_at: doc.generated_at.unwrap_or(now),
            rows: doctor_rows(&doc.checks, validate),
            checks: doc.checks,
            root,
            ran_at: now,
        })
    }

    /// FR-11.
    pub(crate) fn op_policy(&self, root: &str) -> Result<CohortePolicySummary, AppError> {
        let root = self.require(root)?;
        let a = argv::config_get();
        let out = cli::run(
            self.runner.as_ref(),
            Kind::Read,
            &root,
            &a,
            cli::READ_TIMEOUT,
            cli::READ_CAP,
        );
        if let Some(e) = cli::read_failure(&a, &out, cli::READ_TIMEOUT, cli::READ_CAP) {
            return Err(e);
        }
        if out.code != 0 {
            return Err(cli::command_failed(&a, &out));
        }
        let cfg = parse_config(&out.stdout).ok_or_else(|| cli::output_invalid(&a))?;
        Ok(CohortePolicySummary {
            root,
            gated_steps: gated_steps(&cfg),
            unattended: unattended(&cfg),
            file: ".cohorte/config.yaml".into(),
            read_at: now_ms(),
        })
    }

    /// FR-12 — the one write Francois triggers, always through the CLI.
    pub(crate) fn op_init(&self, project_root: &str) -> Result<CohorteDetection, AppError> {
        if project_root.trim().is_empty() {
            return Err(invalid("projectRoot is required"));
        }
        let det = self.detect(project_root, true);
        match det.state.as_str() {
            "not-initialised" => {}
            "no-project" => return Err(invalid("projectRoot is not a directory")),
            _ => return Err(invalid("projectRoot already resolves a Cohorte root")),
        }
        if !det.cli.installed {
            return Err(cli::cli_missing());
        }
        if !det.cli.compatible {
            let mut d = det.clone();
            d.state = "cli-incompatible".into();
            return Err(require_detected(&d).unwrap_err());
        }
        let dir = normalise_dir(project_root);
        let a = argv::init();
        let out = cli::run(
            self.runner.as_ref(),
            Kind::Mutate,
            &dir,
            &a,
            cli::INIT_TIMEOUT,
            cli::READ_CAP,
        );
        if out.spawn_failed {
            return Err(cli::cli_missing());
        }
        if out.timed_out {
            return Err(cli::timeout_error(&a, cli::INIT_TIMEOUT));
        }
        if out.code != 0 {
            return Err(cli::command_failed(&a, &out));
        }
        Ok(self.detect(&dir, true))
    }

    /// FR-48.
    pub(crate) fn op_list_runs(&self, root: &str) -> Result<Vec<CohorteRun>, AppError> {
        let root = self.require(root)?;
        let polled = self
            .existing_root(&root)
            .is_some_and(|h| h.lock().unwrap_or_else(|e| e.into_inner()).polled);
        if !polled {
            // R-6: status alone — the run's tails come from the watcher thread
            // (terminal runs last), never inline on this call.
            let h = self.root_handle(&root);
            if let Some(e) = self.run_status(&root, &h) {
                return Err(e);
            }
            let mut w = h.lock().unwrap_or_else(|e| e.into_inner());
            if !w.thread_running && w.stopped_at.is_none() {
                // Not watched: dropped with the other unwatched roots (FR-26).
                w.stopped_at = Some(now_ms());
            }
        }
        let h = self.root_handle(&root);
        let runs = h
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .runs_sorted(now_ms());
        Ok(runs)
    }

    pub(crate) fn op_get_run(&self, root: &str, run_id: &str) -> Result<CohorteRun, AppError> {
        let root = self.require(root)?;
        self.refresh_run(&root, run_id)
    }

    pub(crate) fn op_run_log(
        &self,
        root: &str,
        run_id: &str,
        limit: Option<u64>,
    ) -> Result<Vec<LogEntry>, AppError> {
        let limit = limit.unwrap_or(DEFAULT_LOG_LIMIT).clamp(1, MAX_LOG_LIMIT) as usize;
        let key = normalise_dir(root);
        self.existing_root(&key)
            .and_then(|h| {
                h.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .log(run_id, limit)
            })
            .ok_or_else(|| run_not_found(run_id))
    }

    fn mutate(
        &self,
        root: &str,
        run_id: &str,
        approval: Option<&str>,
        f: impl FnOnce(&Inner, &str, &RunFacts) -> Result<CommandOutcome, AppError>,
    ) -> Result<CommandOutcome, AppError> {
        let root = self.require(root)?;
        let lock = self.run_lock(run_id);
        let _serialised = lock.lock().unwrap_or_else(|e| e.into_inner());
        let facts = self.facts(&root, run_id, approval)?;
        f(self, &root, &facts)
    }

    pub(crate) fn op_approve(&self, r: &CohorteApproveRequest) -> Result<CommandOutcome, AppError> {
        self.mutate(
            &r.root,
            &r.run_id,
            Some(&r.approval_id),
            |me, root, facts| {
                actions::approve(
                    &Recording(me),
                    root,
                    &r.run_id,
                    &r.approval_id,
                    r.answer.as_deref(),
                    facts,
                    &|| me.refresh_run(root, &r.run_id),
                )
            },
        )
    }

    pub(crate) fn op_send_to_fix(
        &self,
        r: &CohorteSendToFixRequest,
    ) -> Result<CommandOutcome, AppError> {
        self.mutate(
            &r.root,
            &r.run_id,
            Some(&r.approval_id),
            |me, root, facts| {
                actions::send_to_fix(
                    &Recording(me),
                    root,
                    &r.run_id,
                    &r.approval_id,
                    facts,
                    &|| me.refresh_run(root, &r.run_id),
                )
            },
        )
    }

    pub(crate) fn op_deny(&self, r: &CohorteDenyRequest) -> Result<CommandOutcome, AppError> {
        self.mutate(
            &r.root,
            &r.run_id,
            Some(&r.approval_id),
            |me, root, facts| {
                actions::deny(
                    &Recording(me),
                    root,
                    &r.run_id,
                    &r.approval_id,
                    r.stop_run,
                    facts,
                    &|| me.refresh_run(root, &r.run_id),
                )
            },
        )
    }

    pub(crate) fn op_control(
        &self,
        verb: Control,
        r: &CohorteRunControlRequest,
    ) -> Result<CommandOutcome, AppError> {
        self.mutate(&r.root, &r.run_id, None, |me, root, facts| {
            actions::control(
                &Recording(me),
                root,
                verb,
                &r.run_id,
                r.reason.as_deref(),
                facts,
                &|| me.refresh_run(root, &r.run_id),
            )
        })
    }
}

/// Bind the emitter to the window on first use (the watcher threads need it).
fn bind(app: &AppHandle, state: &CohorteState) -> Arc<Inner> {
    let mut slot = state
        .inner
        .emitter
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        let app = app.clone();
        *slot = Some(Arc::new(move |ev: &CohorteEvent| {
            let _ = app.emit(EVENT_CHANNEL, ev);
        }));
    }
    state.inner.clone()
}

#[tauri::command(async)]
pub fn cohorte_detect(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteDetectRequest,
) -> IpcResult<CohorteDetection> {
    bind(&app, &state).op_detect(&req).into()
}

#[tauri::command(async)]
pub fn cohorte_doctor(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteRootRequest,
) -> IpcResult<CohorteDoctorReport> {
    bind(&app, &state).op_doctor(&req.root).into()
}

#[tauri::command(async)]
pub fn cohorte_policy(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteRootRequest,
) -> IpcResult<CohortePolicySummary> {
    bind(&app, &state).op_policy(&req.root).into()
}

#[tauri::command(async)]
pub fn cohorte_init(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteInitRequest,
) -> IpcResult<CohorteDetection> {
    bind(&app, &state).op_init(&req.project_root).into()
}

#[tauri::command(async)]
pub fn cohorte_watch(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteWatchRequest,
) -> IpcResult<Option<()>> {
    let inner = bind(&app, &state);
    if req.roots.iter().any(|r| r.trim().is_empty()) {
        return invalid("roots must be non-empty paths").into();
    }
    let roots: Vec<String> = req.roots.iter().map(|r| normalise_dir(r)).collect();
    inner.set_watch(&roots, req.foreground);
    ok(None)
}

#[tauri::command(async)]
pub fn cohorte_list_runs(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteRootRequest,
) -> IpcResult<Vec<CohorteRun>> {
    bind(&app, &state).op_list_runs(&req.root).into()
}

#[tauri::command(async)]
pub fn cohorte_get_run(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteRunRequest,
) -> IpcResult<CohorteRun> {
    bind(&app, &state).op_get_run(&req.root, &req.run_id).into()
}

#[tauri::command(async)]
pub fn cohorte_run_log(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteRunLogRequest,
) -> IpcResult<Vec<LogEntry>> {
    bind(&app, &state)
        .op_run_log(&req.root, &req.run_id, req.limit)
        .into()
}

#[tauri::command(async)]
pub fn cohorte_approve(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteApproveRequest,
) -> IpcResult<CommandOutcome> {
    bind(&app, &state).op_approve(&req).into()
}

#[tauri::command(async)]
pub fn cohorte_send_to_fix(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteSendToFixRequest,
) -> IpcResult<CommandOutcome> {
    bind(&app, &state).op_send_to_fix(&req).into()
}

#[tauri::command(async)]
pub fn cohorte_deny(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteDenyRequest,
) -> IpcResult<CommandOutcome> {
    bind(&app, &state).op_deny(&req).into()
}

#[tauri::command(async)]
pub fn cohorte_pause(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteRunControlRequest,
) -> IpcResult<CommandOutcome> {
    bind(&app, &state).op_control(Control::Pause, &req).into()
}

#[tauri::command(async)]
pub fn cohorte_resume(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteRunControlRequest,
) -> IpcResult<CommandOutcome> {
    bind(&app, &state).op_control(Control::Resume, &req).into()
}

#[tauri::command(async)]
pub fn cohorte_cancel(
    app: AppHandle,
    state: State<'_, CohorteState>,
    req: CohorteRunControlRequest,
) -> IpcResult<CommandOutcome> {
    bind(&app, &state).op_control(Control::Cancel, &req).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::testutil::{approval_envelope, fixture_record, out, FakeRunner};
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    struct Env {
        dir: PathBuf,
        runner: Arc<FakeRunner>,
        inner: Inner,
    }
    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    impl Env {
        fn root(&self) -> String {
            self.dir.to_string_lossy().into_owned()
        }
    }

    /// A detected project with run_a WAITING_APPROVAL on gate apr_1.
    fn env() -> Env {
        let dir =
            std::env::temp_dir().join(format!("francois-cohorte-cmd-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(".cohorte")).unwrap();
        fs::write(dir.join(".cohorte").join("project.yaml"), "").unwrap();
        let runner = Arc::new(FakeRunner::default());
        runner
            .on("cohorte --version", out(0, "3.0.0-dev.8"))
            .on(
                "cohorte config get",
                out(
                    0,
                    r#"{"runtime":{"id":"pi"},"policy":{"approvals":{"ship":"human"}}}"#,
                ),
            )
            .on(
                "cohorte status run_a",
                out(0, &fixture_record("run_a", "WAITING_APPROVAL").to_string()),
            )
            .on(
                "cohorte status --json",
                out(
                    0,
                    &json!([fixture_record("run_a", "WAITING_APPROVAL")]).to_string(),
                ),
            )
            .on(
                "cohorte tail run_a",
                out(0, &approval_envelope(1, "apr_1", "ship", &[]).to_string()),
            );
        let inner = Inner::with_runner(runner.clone(), dirs::home_dir());
        Env { dir, runner, inner }
    }

    #[test]
    fn list_runs_polls_an_unwatched_root_once_and_hydrates() {
        let e = env();
        let runs = e.inner.op_list_runs(&e.root()).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(
            runs[0].view, "waiting",
            "status alone: the request is not seen yet"
        );
        assert_eq!(e.runner.count("cohorte status --json"), 1);
        e.inner.op_list_runs(&e.root()).unwrap();
        assert_eq!(
            e.runner.count("cohorte status --json"),
            1,
            "second call served from memory"
        );
        assert_eq!(e.inner.op_get_run(&e.root(), "run_a").unwrap().view, "gate");
        let log = e.inner.op_run_log(&e.root(), "run_a", None).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(
            e.inner
                .op_run_log(&e.root(), "run_zz", None)
                .unwrap_err()
                .code,
            ErrorCode::CohorteRunNotFound
        );
    }

    #[test]
    fn approve_checks_the_gate_then_runs_and_rereads() {
        let e = env();
        e.runner.on("cohorte approve", out(0, ""));
        let bad = CohorteApproveRequest {
            root: e.root(),
            run_id: "run_a".into(),
            approval_id: "apr_other".into(),
            answer: None,
        };
        assert_eq!(
            e.inner.op_approve(&bad).unwrap_err().code,
            ErrorCode::CohorteGateNotPending
        );
        assert_eq!(e.runner.count("cohorte approve"), 0);
        let good = CohorteApproveRequest {
            approval_id: "apr_1".into(),
            ..bad
        };
        let o = e.inner.op_approve(&good).unwrap();
        assert_eq!(o.steps[0].cli, "cohorte approve run_a apr_1");
        assert!(o.run.is_some());
        assert!(
            e.runner.count("cohorte status run_a") >= 2,
            "loaded, then re-read"
        );
    }

    #[test]
    fn deny_and_controls_through_the_surface() {
        let e = env();
        e.runner
            .on("cohorte deny", out(0, ""))
            .on("cohorte cancel", out(0, ""))
            .on("cohorte pause", out(4, ""));
        let o = e
            .inner
            .op_deny(&CohorteDenyRequest {
                root: e.root(),
                run_id: "run_a".into(),
                approval_id: "apr_1".into(),
                stop_run: true,
                note: Some("ignored".into()),
            })
            .unwrap();
        assert_eq!(o.steps.len(), 2);
        let o = e
            .inner
            .op_control(
                Control::Pause,
                &CohorteRunControlRequest {
                    root: e.root(),
                    run_id: "run_a".into(),
                    reason: None,
                },
            )
            .unwrap();
        assert_eq!(o.steps[0].outcome, "pending");
    }

    #[test]
    fn get_run_reports_unknown_runs() {
        let e = env();
        e.runner.on("cohorte status run_zz", out(1, "undefined\n"));
        assert_eq!(
            e.inner.op_get_run(&e.root(), "run_zz").unwrap_err().code,
            ErrorCode::CohorteRunNotFound
        );
        assert_eq!(
            e.inner.op_get_run(&e.root(), "run_a").unwrap().run_id,
            "run_a"
        );
    }

    #[test]
    fn doctor_and_policy_documents() {
        let e = env();
        e.runner
            .on("cohorte doctor --json", out(1, r#"{"documentVersion":1,"cohorteVersion":"3.0.0","ok":false,"generatedAt":"2026-01-01T00:00:00.000Z","checks":[{"id":"auth","status":"error","summary":"no login"}]}"#))
            .on("cohorte config validate", out(0, "valid\n"));
        let d = e.inner.op_doctor(&e.root()).unwrap();
        assert_eq!(
            d.cohorte_version, "3.0.0-dev.8",
            "from --version, not the report"
        );
        assert_eq!(d.rows.len(), 3);
        let p = e.inner.op_policy(&e.root()).unwrap();
        assert_eq!(p.gated_steps, vec!["ship"]);
        assert_eq!(p.file, ".cohorte/config.yaml");
    }

    #[test]
    fn detection_codes_guard_every_root_command() {
        let dir =
            std::env::temp_dir().join(format!("francois-cohorte-none-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let runner = Arc::new(FakeRunner::default());
        runner.on("cohorte --version", out(0, "3.0.0-dev.8"));
        let inner = Inner::with_runner(runner.clone(), dirs::home_dir());
        let root = dir.to_string_lossy().into_owned();
        assert_eq!(
            inner.op_doctor(&root).unwrap_err().code,
            ErrorCode::CohorteNotDetected
        );
        assert_eq!(
            inner.op_list_runs(&root).unwrap_err().code,
            ErrorCode::CohorteNotDetected
        );
        assert_eq!(
            inner
                .op_detect(&CohorteDetectRequest {
                    start_dir: " ".into(),
                    force: None
                })
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        // init: runs `cohorte init` with cwd = projectRoot, then re-detects
        runner.on("cohorte init", out(0, ""));
        let det = inner.op_init(&root).unwrap();
        assert_eq!(det.state, "not-initialised", "the fake init wrote nothing");
        assert_eq!(runner.count("cohorte init"), 1);
        fs::create_dir_all(dir.join(".cohorte")).unwrap();
        assert_eq!(
            inner.op_init(&root).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_failure_maps_to_command_failed() {
        let dir =
            std::env::temp_dir().join(format!("francois-cohorte-init-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let runner = Arc::new(FakeRunner::default());
        runner.on("cohorte --version", out(0, "3.0.0-dev.8"));
        let mut failed = out(1, "");
        failed.stderr = "EACCES: permission denied".into();
        runner.on("cohorte init", failed);
        let inner = Inner::with_runner(runner, dirs::home_dir());
        let e = inner.op_init(&dir.to_string_lossy()).unwrap_err();
        assert_eq!(e.code, ErrorCode::CohorteCommandFailed);
        assert_eq!(e.detail.unwrap()["stderr"], "EACCES: permission denied");
        let _ = fs::remove_dir_all(&dir);
    }

    /// AC-14 / FR-1b: nothing in this module writes under `.cohorte/`, and the
    /// only `.cohorte` path joins are the allow-listed stat-only checks.
    #[test]
    fn no_write_under_dot_cohorte_anywhere_in_the_module() {
        let sources = [
            ("mod.rs", include_str!("mod.rs")),
            ("actions.rs", include_str!("actions.rs")),
            ("catalogue.rs", include_str!("catalogue.rs")),
            ("payloads.rs", include_str!("payloads.rs")),
            ("cli.rs", include_str!("cli.rs")),
            ("commands.rs", include_str!("commands.rs")),
            ("detect.rs", include_str!("detect.rs")),
            ("documents.rs", include_str!("documents.rs")),
            ("gate.rs", include_str!("gate.rs")),
            ("projection/mod.rs", include_str!("projection/mod.rs")),
            ("projection/fold.rs", include_str!("projection/fold.rs")),
            ("sanitize.rs", include_str!("sanitize.rs")),
            ("watcher/mod.rs", include_str!("watcher/mod.rs")),
            ("watcher/root.rs", include_str!("watcher/root.rs")),
            ("watcher/driver.rs", include_str!("watcher/driver.rs")),
            ("wire.rs", include_str!("wire.rs")),
        ];
        let writes = [
            "fs::write",
            "File::create",
            "OpenOptions",
            "create_dir",
            "remove_file",
            "remove_dir",
            "fs::rename",
        ];
        for (name, src) in sources {
            let code = src.split("#[cfg(test)]").next().unwrap();
            for w in writes {
                assert!(!code.contains(w), "{name} uses {w}");
            }
            let flat: String = code.chars().filter(|c| !c.is_whitespace()).collect();
            let needle = ".join(\".cohorte\")";
            for (i, _) in flat.match_indices(needle) {
                assert_eq!(name, "detect.rs", "{name} joins .cohorte");
                let after = &flat[i + needle.len()..];
                let allowed = [".is_dir()", ".join(\"project.yaml\").is_file()", ";"];
                assert!(
                    allowed.iter().any(|a| after.starts_with(a)),
                    "detect.rs: .cohorte used as {}",
                    &after[..after.len().min(40)]
                );
            }
        }
        let detect = include_str!("detect.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for line in detect
            .lines()
            .filter(|l| l.contains("dot.join(") || l.contains(".join(\"state\")"))
        {
            assert!(
                ["project.yaml", "state", "cohorte.db"]
                    .iter()
                    .any(|a| line.contains(a)),
                "detect.rs stats an unlisted path: {line}"
            );
        }
    }

    /// R-4: a `command.rejected` for a command this app issued is marked.
    #[test]
    fn command_rejected_is_marked_when_francois_issued_it() {
        use crate::cohorte::testutil::envelope;
        let e = env();
        e.runner.on(
            "cohorte approve",
            out(
                4,
                r#"{"documentVersion":1,"commandId":"cmd_7","type":"approve","status":"pending"}"#,
            ),
        );
        let seen: Arc<Mutex<Vec<bool>>> = Arc::default();
        let s2 = seen.clone();
        *crate::cohorte::lock(&e.inner.emitter) = Some(Arc::new(move |ev: &CohorteEvent| {
            if let CohorteEvent::CommandRejected(w) = ev {
                s2.lock().unwrap().push(w.payload.issued_by_francois);
            }
        }));
        e.inner
            .op_approve(&CohorteApproveRequest {
                root: e.root(),
                run_id: "run_a".into(),
                approval_id: "apr_1".into(),
                answer: None,
            })
            .unwrap();
        let rejected = |id: &str| {
            let raw = json!({ "commandId": id, "type": "approve", "error": { "code": "conflict/x", "message": "m" } });
            crate::cohorte::wire::normalise("/r", &envelope(40, 0, "command.rejected", raw), 0)
                .unwrap()
                .event
        };
        e.inner.emit(&[rejected("cmd_7"), rejected("cmd_other")]);
        assert_eq!(*seen.lock().unwrap(), vec![true, false]);
    }

    /// R-6: listing an unwatched root runs status only — no inline tail.
    #[test]
    fn list_runs_on_an_unwatched_root_runs_status_only() {
        let e = env();
        e.inner.op_list_runs(&e.root()).unwrap();
        assert_eq!(e.runner.count("cohorte tail"), 0);
    }
}
