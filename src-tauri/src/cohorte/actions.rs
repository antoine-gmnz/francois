//! FR-42..FR-47 — the run controls. Every one shells out to the CLI, step by
//! step, and maps each exit per FR-47: a rejection on the FIRST step fails the
//! call (`COHORTE_REJECTED`, or `COHORTE_GATE_NOT_PENDING` when Cohorte says
//! the approval is not pending); on a later step it is reported in `steps`
//! and the call stays ok. After every call the run is re-read.

use super::cli::{self, argv, Kind, Runner};
use super::gate::fix_option;
use super::{CohorteRun, CommandOutcome, CommandStep};
use crate::ipc::{AppError, ErrorCode};
use serde_json::json;

/// R-4: the window within which a `command.rejected` is ours.
const ISSUED_WINDOW_MS: u64 = 60_000;

struct Issued {
    command_id: Option<String>,
    command_type: String,
    run_id: String,
    at: u64,
}

/// R-4: the commands this app issued in the last 60 s — by `commandId` when
/// the CLI's CommandResultDocument gave one, else by (commandType, runId).
#[derive(Default)]
pub(crate) struct IssuedCommands {
    entries: Vec<Issued>,
}

impl IssuedCommands {
    /// The Cohorte command type a CLI verb sends (`fix` is a `retry`).
    pub(crate) fn command_type(verb: &str) -> Option<&'static str> {
        Some(match verb {
            "approve" => "approve",
            "deny" => "deny",
            "fix" => "retry",
            "pause" => "pause",
            "resume" => "resume",
            "cancel" => "cancel",
            _ => return None,
        })
    }

    pub(crate) fn record(
        &mut self,
        command_id: Option<String>,
        command_type: &str,
        run_id: &str,
        now: u64,
    ) {
        self.entries
            .retain(|e| now.saturating_sub(e.at) <= ISSUED_WINDOW_MS);
        self.entries.push(Issued {
            command_id,
            command_type: command_type.to_string(),
            run_id: run_id.to_string(),
            at: now,
        });
    }

    pub(crate) fn issued(
        &self,
        command_id: &str,
        command_type: &str,
        run_id: &str,
        now: u64,
    ) -> bool {
        self.entries
            .iter()
            .filter(|e| now.saturating_sub(e.at) <= ISSUED_WINDOW_MS)
            .any(|e| match &e.command_id {
                Some(id) => id == command_id,
                None => e.command_type == command_type && e.run_id == run_id,
            })
    }
}

/// What the pre-checks need from the current projection (no spawn).
pub(crate) struct RunFacts {
    pub(crate) state: String,
    /// `approval_id` is one of the run's pending approvals.
    pub(crate) approval_pending: bool,
    pub(crate) options: Option<Vec<String>>,
}

pub(crate) type Refresh<'a> = &'a dyn Fn() -> Result<CohorteRun, AppError>;

fn run_step(runner: &dyn Runner, root: &str, args: &[String]) -> Result<CommandStep, AppError> {
    let out = cli::run(
        runner,
        Kind::Mutate,
        root,
        args,
        cli::MUTATE_TIMEOUT,
        cli::READ_CAP,
    );
    cli::map_step(args, &out, cli::MUTATE_TIMEOUT)
}

/// The first step: a rejection fails the whole call.
fn first(runner: &dyn Runner, root: &str, args: &[String]) -> Result<CommandStep, AppError> {
    let step = run_step(runner, root, args)?;
    if step.outcome != "rejected" {
        return Ok(step);
    }
    if cli::is_not_pending(&step) {
        return Err(AppError::with_detail(
            ErrorCode::CohorteGateNotPending,
            "the approval is no longer pending",
            json!({ "cli": step.cli, "cohorteCode": step.error_code, "message": step.message }),
        ));
    }
    Err(AppError::with_detail(
        ErrorCode::CohorteRejected,
        step.message
            .clone()
            .unwrap_or_else(|| "Cohorte rejected the command".into()),
        json!({ "cli": step.cli, "cohorteCode": step.error_code, "message": step.message }),
    ))
}

/// A later step: every failure is reported in `steps`, never raised.
fn later(runner: &dyn Runner, root: &str, args: &[String]) -> CommandStep {
    run_step(runner, root, args).unwrap_or_else(|e| CommandStep {
        cli: cli::display(args),
        outcome: "rejected".into(),
        exit_code: -1,
        message: Some(e.message),
        error_code: Some(e.code.as_str().to_string()),
    })
}

fn outcome(run_id: &str, steps: Vec<CommandStep>, refresh: Refresh) -> CommandOutcome {
    CommandOutcome {
        run_id: run_id.to_string(),
        steps,
        run: refresh().ok(),
    }
}

fn not_pending() -> AppError {
    AppError::new(
        ErrorCode::CohorteGateNotPending,
        "the approval is no longer pending",
    )
}

/// FR-42 — `approve <run> <apr> [answer]`.
pub(crate) fn approve(
    runner: &dyn Runner,
    root: &str,
    run_id: &str,
    approval_id: &str,
    answer: Option<&str>,
    facts: &RunFacts,
    refresh: Refresh,
) -> Result<CommandOutcome, AppError> {
    let args = argv::approve(run_id, approval_id, answer)?;
    if !facts.approval_pending {
        return Err(not_pending());
    }
    if let Some(a) = answer {
        if !facts
            .options
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|o| o == a)
        {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "the answer is not one of the approval's options",
            ));
        }
    }
    let step = first(runner, root, &args)?;
    Ok(outcome(run_id, vec![step], refresh))
}

/// FR-43 — "Send to fix": the request's own fix option when it offers one;
/// else deny, then `fix` only if the run is FAILED after the denial.
pub(crate) fn send_to_fix(
    runner: &dyn Runner,
    root: &str,
    run_id: &str,
    approval_id: &str,
    facts: &RunFacts,
    refresh: Refresh,
) -> Result<CommandOutcome, AppError> {
    let deny = argv::deny(run_id, approval_id)?;
    if !facts.approval_pending {
        return Err(not_pending());
    }
    if let Some(opt) = fix_option(facts.options.as_deref()) {
        let args = argv::approve(run_id, approval_id, Some(opt))?;
        let step = first(runner, root, &args)?;
        return Ok(outcome(run_id, vec![step], refresh));
    }
    let mut steps = vec![first(runner, root, &deny)?];
    let fix = argv::fix(run_id)?;
    let failed = refresh().is_ok_and(|r| r.state == "FAILED");
    steps.push(if failed {
        later(runner, root, &fix)
    } else {
        CommandStep {
            cli: cli::display(&fix),
            outcome: "skipped".into(),
            exit_code: 0,
            message: Some("Cohorte routes the findings after the denial".into()),
            error_code: None,
        }
    });
    Ok(outcome(run_id, steps, refresh))
}

/// FR-44 — `deny`, then `cancel` iff `stop_run` and the deny landed (0/4).
pub(crate) fn deny(
    runner: &dyn Runner,
    root: &str,
    run_id: &str,
    approval_id: &str,
    stop_run: bool,
    facts: &RunFacts,
    refresh: Refresh,
) -> Result<CommandOutcome, AppError> {
    let args = argv::deny(run_id, approval_id)?;
    if !facts.approval_pending {
        return Err(not_pending());
    }
    let mut steps = vec![first(runner, root, &args)?];
    if stop_run {
        steps.push(later(runner, root, &argv::cancel(run_id)?));
    }
    Ok(outcome(run_id, steps, refresh))
}

pub(crate) enum Control {
    Pause,
    Resume,
    Cancel,
}

/// FR-46 — the single verb; a terminal run is rejected without spawning.
pub(crate) fn control(
    runner: &dyn Runner,
    root: &str,
    verb: Control,
    run_id: &str,
    reason: Option<&str>,
    facts: &RunFacts,
    refresh: Refresh,
) -> Result<CommandOutcome, AppError> {
    let args = match verb {
        Control::Pause => argv::pause(run_id, reason)?,
        Control::Resume => argv::resume(run_id)?,
        Control::Cancel => argv::cancel(run_id)?,
    };
    if super::projection::is_terminal(&facts.state) {
        return Err(AppError::with_detail(
            ErrorCode::CohorteRejected,
            format!("run is {}", facts.state),
            json!({ "cli": cli::display(&args), "cohorteCode": null, "message": format!("run is {}", facts.state) }),
        ));
    }
    let step = first(runner, root, &args)?;
    Ok(outcome(run_id, vec![step], refresh))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::testutil::{out, sample_run, FakeRunner};

    /// R-4.
    #[test]
    fn issued_commands_match_by_id_else_by_type_and_run_within_60s() {
        let mut c = IssuedCommands::default();
        c.record(Some("cmd_1".into()), "approve", "run_a", 0);
        c.record(None, "retry", "run_b", 0);
        assert!(c.issued("cmd_1", "approve", "run_x", 1_000));
        assert!(
            !c.issued("cmd_2", "approve", "run_a", 1_000),
            "an id entry only matches its id"
        );
        assert!(c.issued("cmd_9", "retry", "run_b", 59_000));
        assert!(
            !c.issued("cmd_9", "retry", "run_b", 61_000),
            "outside the window"
        );
        assert_eq!(IssuedCommands::command_type("fix"), Some("retry"));
        assert_eq!(IssuedCommands::command_type("status"), None);
    }

    const REJECTED: &str = r#"{"documentVersion":1,"status":"rejected","error":{"code":"conflict/run-active","message":"run is active"}}"#;
    const NOT_PENDING: &str = r#"{"status":"rejected","error":{"code":"conflict/unexpected","message":"approval apr_1 is not pending"}}"#;

    fn facts(options: Option<Vec<&str>>) -> RunFacts {
        RunFacts {
            state: "WAITING_APPROVAL".into(),
            approval_pending: true,
            options: options.map(|o| o.into_iter().map(String::from).collect()),
        }
    }
    fn run_in(state: &str) -> impl Fn() -> Result<CohorteRun, AppError> {
        let state = state.to_string();
        move || {
            let mut r = sample_run();
            r.state = state.clone();
            Ok(r)
        }
    }
    fn outcomes(o: &CommandOutcome) -> Vec<(String, String)> {
        o.steps
            .iter()
            .map(|s| (s.cli.clone(), s.outcome.clone()))
            .collect()
    }

    /// AC-8.
    #[test]
    fn a_fix_option_is_one_approve_step() {
        let r = FakeRunner::default();
        r.on("cohorte approve", out(0, ""));
        let o = send_to_fix(
            &r,
            "/r",
            "run_a",
            "apr_1",
            &facts(Some(vec!["ship", "send to fix"])),
            &run_in("REVIEW"),
        )
        .unwrap();
        assert_eq!(
            outcomes(&o),
            vec![(
                "cohorte approve run_a apr_1 'send to fix'".into(),
                "completed".into()
            )]
        );
        assert_eq!(r.calls(), vec!["cohorte approve run_a apr_1 send to fix"]);
    }

    #[test]
    fn without_options_a_waiting_run_skips_fix_and_a_failed_run_runs_it() {
        let r = FakeRunner::default();
        r.on("cohorte deny", out(0, ""))
            .on("cohorte fix", out(4, ""));
        let o = send_to_fix(
            &r,
            "/r",
            "run_a",
            "apr_1",
            &facts(None),
            &run_in("WAITING_APPROVAL"),
        )
        .unwrap();
        assert_eq!(
            outcomes(&o),
            vec![
                ("cohorte deny run_a apr_1".into(), "completed".into()),
                ("cohorte fix run_a".into(), "skipped".into())
            ]
        );
        assert_eq!(r.count("cohorte fix"), 0);
        let o = send_to_fix(&r, "/r", "run_a", "apr_1", &facts(None), &run_in("FAILED")).unwrap();
        assert_eq!(o.steps[1].outcome, "pending");
        assert_eq!(r.count("cohorte fix"), 1);
    }

    #[test]
    fn a_rejected_deny_fails_send_to_fix_without_a_second_spawn() {
        let r = FakeRunner::default();
        r.on("cohorte deny", out(3, REJECTED));
        let e =
            send_to_fix(&r, "/r", "run_a", "apr_1", &facts(None), &run_in("FAILED")).unwrap_err();
        assert_eq!(e.code, ErrorCode::CohorteRejected);
        assert_eq!(e.detail.unwrap()["cohorteCode"], "conflict/run-active");
        assert_eq!(r.calls().len(), 1);
    }

    #[test]
    fn a_conflict_on_the_fix_step_is_reported_but_ok() {
        let r = FakeRunner::default();
        r.on("cohorte deny", out(0, ""))
            .on("cohorte fix", out(3, REJECTED));
        let o = send_to_fix(&r, "/r", "run_a", "apr_1", &facts(None), &run_in("FAILED")).unwrap();
        assert_eq!(o.steps[1].outcome, "rejected");
        assert_eq!(
            o.steps[1].error_code.as_deref(),
            Some("conflict/run-active")
        );
    }

    /// AC-9.
    #[test]
    fn deny_stop_run_denies_then_cancels() {
        let r = FakeRunner::default();
        r.on("cohorte deny", out(4, ""))
            .on("cohorte cancel", out(0, ""));
        let o = deny(
            &r,
            "/r",
            "run_a",
            "apr_1",
            true,
            &facts(None),
            &run_in("CANCELLED"),
        )
        .unwrap();
        assert_eq!(
            outcomes(&o),
            vec![
                ("cohorte deny run_a apr_1".into(), "pending".into()),
                ("cohorte cancel run_a".into(), "completed".into())
            ]
        );
        assert_eq!(o.run.unwrap().state, "CANCELLED");
        let r = FakeRunner::default();
        r.on("cohorte deny", out(3, REJECTED));
        assert!(deny(&r, "/r", "run_a", "apr_1", true, &facts(None), &run_in("X")).is_err());
        assert_eq!(r.count("cohorte cancel"), 0);
        let r = FakeRunner::default();
        r.on("cohorte deny", out(0, ""));
        let o = deny(
            &r,
            "/r",
            "run_a",
            "apr_1",
            false,
            &facts(None),
            &run_in("X"),
        )
        .unwrap();
        assert_eq!(o.steps.len(), 1);
        assert_eq!(r.calls().len(), 1);
    }

    /// AC-10.
    #[test]
    fn exit_codes_on_first_and_later_steps() {
        let r = FakeRunner::default();
        r.on("cohorte approve", out(4, ""));
        let o = approve(&r, "/r", "run_a", "apr_1", None, &facts(None), &run_in("X")).unwrap();
        assert_eq!(o.steps[0].outcome, "pending");
        let r = FakeRunner::default();
        r.on("cohorte deny", out(0, ""))
            .on("cohorte cancel", out(3, REJECTED));
        let o = deny(&r, "/r", "run_a", "apr_1", true, &facts(None), &run_in("X")).unwrap();
        assert_eq!(o.steps[1].outcome, "rejected");
        let r = FakeRunner::default();
        r.on("cohorte approve", out(2, ""));
        let e = approve(&r, "/r", "run_a", "apr_1", None, &facts(None), &run_in("X")).unwrap_err();
        assert_eq!(e.code, ErrorCode::CohorteCommandFailed);
        let r = FakeRunner::default();
        r.on("cohorte approve", out(3, NOT_PENDING));
        let e = approve(&r, "/r", "run_a", "apr_1", None, &facts(None), &run_in("X")).unwrap_err();
        assert_eq!(e.code, ErrorCode::CohorteGateNotPending);
    }

    #[test]
    fn pre_checks_never_spawn() {
        let r = FakeRunner::default();
        let mut f = facts(Some(vec!["a"]));
        let e = approve(&r, "/r", "run_a", "apr_1", Some("b"), &f, &run_in("X")).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        let e = approve(&r, "/r", "run a", "apr_1", None, &f, &run_in("X")).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        f.approval_pending = false;
        let e = deny(&r, "/r", "run_a", "apr_1", true, &f, &run_in("X")).unwrap_err();
        assert_eq!(e.code, ErrorCode::CohorteGateNotPending);
        f.state = "COMPLETED".into();
        let e = control(&r, "/r", Control::Pause, "run_a", None, &f, &run_in("X")).unwrap_err();
        assert_eq!(e.code, ErrorCode::CohorteRejected);
        assert_eq!(e.message, "run is COMPLETED");
        assert!(r.calls().is_empty());
    }

    #[test]
    fn pause_passes_its_reason_positionally() {
        let r = FakeRunner::default();
        r.on("cohorte pause", out(0, ""));
        control(
            &r,
            "/r",
            Control::Pause,
            "run_a",
            Some("coffee break"),
            &facts(None),
            &run_in("PAUSED"),
        )
        .unwrap();
        assert_eq!(r.calls(), vec!["cohorte pause run_a coffee break"]);
    }
}
