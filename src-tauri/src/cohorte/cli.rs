//! FR-1a / FR-45 / FR-47 — the ONE way Francois spawns `cohorte` (and the two
//! `git` probes detection needs): a `Runner` over `github::gh::run_argv_bounded`
//! (login-shell PATH via `process_util::spawn`, `CREATE_NO_WINDOW`, bounded),
//! the pure argv builders of the `positional-3.0` dialect, and the exit-code
//! mapping. No other code path spawns `cohorte`.
//!
//! Routing (`spawn_plan`): a native root resolves `cohorte` through
//! `process_util::resolve_cli_program` (FR-6b — on Windows it is an npm `.cmd`
//! shim); a WSL root runs `wsl.exe … --exec bash -lc 'exec cohorte "$@"' _ <args…>`
//! (R-2/R-3) — a login shell so nvm-installed node resolves, and the args as
//! separate values so no shell ever parses them.

use super::sanitize;
use super::CommandStep;
use crate::diff::{wsl_cd_target, GitHost};
use crate::github::gh::{program_argv, run_argv_bounded, RoutedRun};
use crate::ipc::{AppError, ErrorCode};
use serde_json::{json, Value};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

pub(crate) const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const GIT_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const READ_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const DOCTOR_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const INIT_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const MUTATE_TIMEOUT: Duration = Duration::from_secs(15);
/// FR-95: reads 4 MiB, tail 8 MiB.
pub(crate) const READ_CAP: usize = 4 * 1024 * 1024;
pub(crate) const TAIL_CAP: usize = 8 * 1024 * 1024;
const STDERR_TAIL_BYTES: usize = 2 * 1024;

/// The injectable process runner (tests substitute a stub CLI).
pub(crate) trait Runner: Send + Sync {
    fn run(
        &self,
        program: &str,
        dir: &str,
        args: &[String],
        timeout: Duration,
        cap: usize,
    ) -> RoutedRun;
}

/// Pure: the exact (bin, argv) a spawn of `program args` in `dir` runs.
pub(crate) fn spawn_plan(program: &str, dir: &str, args: &[String]) -> (String, Vec<String>) {
    match (GitHost::of(dir), program) {
        (GitHost::Wsl(distro), "cohorte") => {
            let cd = wsl_cd_target(dir);
            let mut argv: Vec<String> = [
                "-d",
                distro.as_str(),
                "--cd",
                cd.as_str(),
                "--exec",
                "bash",
                "-lc",
                "exec cohorte \"$@\"",
                "_",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
            argv.extend(args.iter().cloned());
            ("wsl.exe".into(), argv)
        }
        (GitHost::Native, "cohorte") => (
            crate::process_util::resolve_cli_program("cohorte"),
            args.to_vec(),
        ),
        (host, _) => {
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            program_argv(program, &host, dir, &refs)
        }
    }
}

/// Production: routed by the dialect of `dir` (FR-6/FR-6b), `cwd = dir` (FR-1a).
pub(crate) struct SystemRunner;

impl Runner for SystemRunner {
    fn run(
        &self,
        program: &str,
        dir: &str,
        args: &[String],
        timeout: Duration,
        cap: usize,
    ) -> RoutedRun {
        let (bin, argv) = spawn_plan(program, dir, args);
        let tree = program == "cohorte";
        run_argv_bounded(
            program,
            &bin,
            &argv,
            &GitHost::of(dir),
            dir,
            timeout,
            cap,
            tree,
        )
    }
}

/// FR-16: at most 4 concurrent READ spawns across all roots; mutating
/// commands bypass it (they are serialised per run instead).
struct ReadSlots {
    used: Mutex<usize>,
    freed: Condvar,
}
static READ_SLOTS: ReadSlots = ReadSlots {
    used: Mutex::new(0),
    freed: Condvar::new(),
};
const MAX_READS: usize = 4;

/// RAII read slot (R-10): released even if the spawn panics.
struct ReadSlot;

impl ReadSlot {
    fn acquire() -> Self {
        let mut used = READ_SLOTS.used.lock().unwrap_or_else(|e| e.into_inner());
        while *used >= MAX_READS {
            used = READ_SLOTS
                .freed
                .wait(used)
                .unwrap_or_else(|e| e.into_inner());
        }
        *used += 1;
        ReadSlot
    }
}

impl Drop for ReadSlot {
    fn drop(&mut self) {
        *READ_SLOTS.used.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        READ_SLOTS.freed.notify_one();
    }
}

pub(crate) enum Kind {
    Read,
    Mutate,
}

/// Spawn `cohorte <args>` with cwd = `root`.
pub(crate) fn run(
    runner: &dyn Runner,
    kind: Kind,
    root: &str,
    args: &[String],
    timeout: Duration,
    cap: usize,
) -> RoutedRun {
    if let Kind::Mutate = kind {
        return runner.run("cohorte", root, args, timeout, cap);
    }
    let _slot = ReadSlot::acquire();
    runner.run("cohorte", root, args, timeout, cap)
}

// ---------- argv (FR-45, dialect positional-3.0) ----------

pub(crate) mod argv {
    use super::super::sanitize::valid_id;
    use crate::ipc::{AppError, ErrorCode};

    fn id(kind: &str, v: &str) -> Result<String, AppError> {
        if valid_id(v) {
            Ok(v.to_string())
        } else {
            Err(AppError::new(
                ErrorCode::InvalidInput,
                format!("invalid {kind}: {v:?}"),
            ))
        }
    }

    /// R-2 defence in depth: free text (an approve answer, a pause reason)
    /// must match `^[A-Za-z0-9 ._,:/'-]+$` and never start with `-` (R-10: it
    /// cannot be read as a flag). Anything else is INVALID_INPUT.
    pub(crate) fn free_text(kind: &str, v: &str) -> Result<String, AppError> {
        let ok = !v.trim().is_empty()
            && !v.starts_with('-')
            && v.chars()
                .all(|c| c.is_ascii_alphanumeric() || " ._,:/'-".contains(c));
        if ok {
            Ok(v.to_string())
        } else {
            Err(AppError::new(
                ErrorCode::InvalidInput,
                format!("{kind} may only contain letters, digits, spaces and ._,:/'-"),
            ))
        }
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    pub(crate) fn approve(
        run: &str,
        apr: &str,
        answer: Option<&str>,
    ) -> Result<Vec<String>, AppError> {
        let mut a = vec!["approve".into(), id("runId", run)?, id("approvalId", apr)?];
        if let Some(ans) = answer {
            a.push(free_text("answer", ans)?);
        }
        Ok(a)
    }
    pub(crate) fn deny(run: &str, apr: &str) -> Result<Vec<String>, AppError> {
        Ok(vec![
            "deny".into(),
            id("runId", run)?,
            id("approvalId", apr)?,
        ])
    }
    pub(crate) fn fix(run: &str) -> Result<Vec<String>, AppError> {
        Ok(vec!["fix".into(), id("runId", run)?])
    }
    /// `pause <run> [reason words…]` — the reason's words, positionally;
    /// a word starting with `-` is dropped (R-10: never read as a flag).
    pub(crate) fn pause(run: &str, reason: Option<&str>) -> Result<Vec<String>, AppError> {
        let mut a = vec!["pause".into(), id("runId", run)?];
        if let Some(r) = reason {
            let words: Vec<&str> = r
                .split_whitespace()
                .filter(|w| !w.starts_with('-'))
                .collect();
            if !words.is_empty() {
                free_text("reason", &words.join(" "))?;
                a.extend(words.into_iter().map(str::to_string));
            }
        }
        Ok(a)
    }
    pub(crate) fn resume(run: &str) -> Result<Vec<String>, AppError> {
        Ok(vec!["resume".into(), id("runId", run)?])
    }
    pub(crate) fn cancel(run: &str) -> Result<Vec<String>, AppError> {
        Ok(vec!["cancel".into(), id("runId", run)?])
    }
    pub(crate) fn tail(run: &str, hwm: u64) -> Result<Vec<String>, AppError> {
        Ok(vec![
            "tail".into(),
            id("runId", run)?,
            "--json".into(),
            "--since-seq".into(),
            hwm.to_string(),
        ])
    }
    pub(crate) fn status(run: Option<&str>) -> Result<Vec<String>, AppError> {
        let mut a = vec!["status".to_string()];
        if let Some(r) = run {
            a.push(id("runId", r)?);
        }
        a.push("--json".into());
        Ok(a)
    }
    pub(crate) fn doctor() -> Vec<String> {
        s(&["doctor", "--json"])
    }
    pub(crate) fn config_validate() -> Vec<String> {
        s(&["config", "validate"])
    }
    pub(crate) fn config_get() -> Vec<String> {
        s(&["config", "get"])
    }
    pub(crate) fn init() -> Vec<String> {
        s(&["init"])
    }
    pub(crate) fn version() -> Vec<String> {
        s(&["--version"])
    }
}

/// The display form of an argv: `cohorte <args joined by space>` (FR-41);
/// an arg with whitespace is single-quoted so the hint pastes as one value (R-10).
pub(crate) fn display(args: &[String]) -> String {
    let quoted: Vec<String> = args
        .iter()
        .map(|a| {
            if a.is_empty() || a.chars().any(char::is_whitespace) {
                format!("'{}'", a.replace('\'', "'\\''"))
            } else {
                a.clone()
            }
        })
        .collect();
    format!("cohorte {}", quoted.join(" "))
}

/// A CommandResultDocument's `commandId` / `type` (R-4), when stdout holds one.
pub(crate) fn command_doc(stdout: &[u8]) -> (Option<String>, Option<String>) {
    let doc = String::from_utf8_lossy(stdout)
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .filter(Value::is_object);
    let Some(doc) = doc else {
        return (None, None);
    };
    (
        doc["commandId"].as_str().map(|s| sanitize::line(s, 128)),
        doc["type"].as_str().map(|s| sanitize::line(s, 64)),
    )
}

fn stderr_tail(stderr: &str) -> String {
    sanitize::cap_bytes_tail(sanitize::strip(stderr, true), STDERR_TAIL_BYTES)
}

pub(crate) fn command_failed(args: &[String], out: &RoutedRun) -> AppError {
    let first = sanitize::line(out.stderr.lines().next().unwrap_or(""), 512);
    AppError::with_detail(
        ErrorCode::CohorteCommandFailed,
        if first.is_empty() {
            format!("{} exited with code {}", display(args), out.code)
        } else {
            first
        },
        json!({ "cli": display(args), "code": out.code, "stderr": stderr_tail(&out.stderr) }),
    )
}

pub(crate) fn cli_missing() -> AppError {
    AppError::new(
        ErrorCode::CohorteCliMissing,
        "the cohorte CLI does not resolve on the login-shell PATH",
    )
}

pub(crate) fn timeout_error(args: &[String], timeout: Duration) -> AppError {
    AppError::with_detail(
        ErrorCode::CohorteTimeout,
        "Cohorte did not answer in time",
        json!({ "cli": display(args), "timeoutMs": timeout.as_millis() as u64 }),
    )
}

pub(crate) fn output_invalid(args: &[String]) -> AppError {
    AppError::with_detail(
        ErrorCode::CohorteOutputInvalid,
        "Cohorte printed a document Francois cannot read",
        json!({ "cli": display(args) }),
    )
}

/// A read's early ends (spawn failure, timeout, cap) — `None` when the
/// process ran to completion (the caller interprets its exit code).
pub(crate) fn read_failure(
    args: &[String],
    out: &RoutedRun,
    timeout: Duration,
    cap: usize,
) -> Option<AppError> {
    if out.spawn_failed {
        return Some(cli_missing());
    }
    if out.timed_out {
        return Some(timeout_error(args, timeout));
    }
    if out.capped {
        return Some(AppError::with_detail(
            ErrorCode::CohorteOutputCapped,
            "Cohorte printed more than Francois reads",
            json!({ "cli": display(args), "capBytes": cap }),
        ));
    }
    None
}

/// The rejected document's `error.code`/`error.message` (CommandResultDocument).
pub(crate) fn rejection(stdout: &[u8]) -> (Option<String>, Option<String>) {
    let doc: Option<Value> = String::from_utf8_lossy(stdout)
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .filter(Value::is_object);
    let Some(doc) = doc else {
        return (None, None);
    };
    let err = &doc["error"];
    (
        err["code"].as_str().map(|s| sanitize::line(s, 128)),
        err["message"]
            .as_str()
            .map(|s| sanitize::line(s, sanitize::MESSAGE_BYTES)),
    )
}

/// FR-47 — one mutating step's exit, mapped. `Ok` for 0/3/4 (a rejection is a
/// step outcome here; the caller decides whether it fails the whole call).
pub(crate) fn map_step(
    args: &[String],
    out: &RoutedRun,
    timeout: Duration,
) -> Result<CommandStep, AppError> {
    if out.spawn_failed {
        return Err(cli_missing());
    }
    if out.timed_out {
        return Err(timeout_error(args, timeout));
    }
    let step = |outcome: &str, message: Option<String>, error_code: Option<String>| CommandStep {
        cli: display(args),
        outcome: outcome.into(),
        exit_code: out.code,
        message,
        error_code,
    };
    match out.code {
        0 => Ok(step("completed", None, None)),
        4 => Ok(step("pending", None, None)),
        3 => {
            let (code, message) = rejection(&out.stdout);
            Ok(step("rejected", message, code))
        }
        _ => Err(command_failed(args, out)),
    }
}

/// FR-47: `conflict/unexpected` + "not pending" → the approval was answered elsewhere.
pub(crate) fn is_not_pending(step: &CommandStep) -> bool {
    step.error_code.as_deref() == Some("conflict/unexpected")
        && step
            .message
            .as_deref()
            .is_some_and(|m| m.to_ascii_lowercase().contains("not pending"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::testutil::{out, StubCli};
    use std::time::Duration;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn argv_builders_produce_the_positional_dialect() {
        assert_eq!(
            argv::approve("run_a1", "apr_b2", None).unwrap(),
            v(&["approve", "run_a1", "apr_b2"])
        );
        assert_eq!(
            argv::approve("run_a1", "apr_b2", Some("send to fix")).unwrap(),
            v(&["approve", "run_a1", "apr_b2", "send to fix"])
        );
        assert_eq!(
            argv::deny("run_a1", "apr_b2").unwrap(),
            v(&["deny", "run_a1", "apr_b2"])
        );
        assert_eq!(argv::fix("run_a1").unwrap(), v(&["fix", "run_a1"]));
        assert_eq!(
            argv::pause("run_a1", Some("lunch  break")).unwrap(),
            v(&["pause", "run_a1", "lunch", "break"])
        );
        assert_eq!(
            argv::pause("run_a1", None).unwrap(),
            v(&["pause", "run_a1"])
        );
        assert_eq!(argv::resume("run_a1").unwrap(), v(&["resume", "run_a1"]));
        assert_eq!(argv::cancel("run_a1").unwrap(), v(&["cancel", "run_a1"]));
        assert_eq!(
            argv::tail("run_a1", 42).unwrap(),
            v(&["tail", "run_a1", "--json", "--since-seq", "42"])
        );
        assert_eq!(argv::status(None).unwrap(), v(&["status", "--json"]));
        assert_eq!(
            argv::status(Some("run_a1")).unwrap(),
            v(&["status", "run_a1", "--json"])
        );
        assert_eq!(argv::doctor(), v(&["doctor", "--json"]));
        assert_eq!(argv::config_validate(), v(&["config", "validate"]));
        assert_eq!(argv::config_get(), v(&["config", "get"]));
        assert_eq!(argv::init(), v(&["init"]));
        assert_eq!(argv::version(), v(&["--version"]));
    }

    #[test]
    fn a_run_id_with_a_space_or_semicolon_is_invalid_input() {
        for bad in ["run_a b", "run_a;rm", "--version"] {
            let e = argv::cancel(bad).unwrap_err();
            assert_eq!(e.code, ErrorCode::InvalidInput);
            assert_eq!(
                argv::approve("run_a", bad, None).unwrap_err().code,
                ErrorCode::InvalidInput
            );
        }
    }

    #[test]
    fn display_is_cohorte_plus_args() {
        assert_eq!(display(&v(&["cancel", "run_a"])), "cohorte cancel run_a");
    }

    #[test]
    fn exit_codes_map_per_fr47() {
        let a = v(&["deny", "run_a", "apr_b"]);
        assert_eq!(
            map_step(&a, &out(0, ""), MUTATE_TIMEOUT).unwrap().outcome,
            "completed"
        );
        let p = map_step(&a, &out(4, ""), MUTATE_TIMEOUT).unwrap();
        assert_eq!((p.outcome.as_str(), p.exit_code), ("pending", 4));
        let r = map_step(
            &a,
            &out(3, r#"{"documentVersion":1,"status":"rejected","error":{"code":"conflict/run-active","message":"run is active"}}"#),
            MUTATE_TIMEOUT,
        )
        .unwrap();
        assert_eq!(r.outcome, "rejected");
        assert_eq!(r.error_code.as_deref(), Some("conflict/run-active"));
        assert_eq!(r.message.as_deref(), Some("run is active"));
        assert_eq!(
            map_step(&a, &out(2, ""), MUTATE_TIMEOUT).unwrap_err().code,
            ErrorCode::CohorteCommandFailed
        );
        let e = map_step(&a, &out(7, ""), MUTATE_TIMEOUT).unwrap_err();
        assert_eq!(e.code, ErrorCode::CohorteCommandFailed);
        assert_eq!(e.detail.unwrap()["code"], 7);
    }

    #[test]
    fn not_pending_rejections_are_recognised() {
        let a = v(&["approve", "run_a", "apr_b"]);
        let r = map_step(
            &a,
            &out(3, r#"{"status":"rejected","error":{"code":"conflict/unexpected","message":"approval apr_b is not pending"}}"#),
            MUTATE_TIMEOUT,
        )
        .unwrap();
        assert!(is_not_pending(&r));
    }

    #[test]
    fn read_failures_are_distinct_codes() {
        let a = v(&["status", "--json"]);
        let mut o = out(0, "");
        o.capped = true;
        assert_eq!(
            read_failure(&a, &o, READ_TIMEOUT, READ_CAP).unwrap().code,
            ErrorCode::CohorteOutputCapped
        );
        o.capped = false;
        o.spawn_failed = true;
        assert_eq!(
            read_failure(&a, &o, READ_TIMEOUT, READ_CAP).unwrap().code,
            ErrorCode::CohorteCliMissing
        );
        assert!(read_failure(&a, &out(0, "[]"), READ_TIMEOUT, READ_CAP).is_none());
    }

    /// AC-10: a stub sleeping past the deadline → COHORTE_TIMEOUT (real spawn).
    #[test]
    fn a_stub_sleeping_past_the_deadline_times_out() {
        let stub = StubCli::sleeping();
        let a = argv::cancel("run_a").unwrap();
        let o = run(
            &stub,
            Kind::Mutate,
            &stub.dir(),
            &a,
            Duration::from_millis(300),
            READ_CAP,
        );
        let e = map_step(&a, &o, Duration::from_millis(300)).unwrap_err();
        assert_eq!(e.code, ErrorCode::CohorteTimeout);
        assert_eq!(e.detail.unwrap()["timeoutMs"], 300);
    }

    /// The real runner resolves and runs a script, capturing stdout.
    #[test]
    fn the_system_runner_captures_a_stub_version() {
        let stub = StubCli::printing("3.0.0-dev.8");
        let o = run(
            &stub,
            Kind::Read,
            &stub.dir(),
            &argv::version(),
            VERSION_TIMEOUT,
            READ_CAP,
        );
        assert_eq!(o.code, 0);
        assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "3.0.0-dev.8");
    }

    /// R-2/R-3: a WSL root runs cohorte through a login bash with the args as
    /// separate values — no shell parses them.
    #[test]
    fn a_wsl_root_spawns_through_a_login_shell_exec() {
        let (bin, a) = spawn_plan(
            "cohorte",
            r"\\wsl$\Ubuntu\home\u\api",
            &v(&["approve", "run_a", "apr_b", "send to fix"]),
        );
        assert_eq!(bin, "wsl.exe");
        assert_eq!(
            a,
            v(&[
                "-d",
                "Ubuntu",
                "--cd",
                "/home/u/api",
                "--exec",
                "bash",
                "-lc",
                "exec cohorte \"$@\"",
                "_",
                "approve",
                "run_a",
                "apr_b",
                "send to fix"
            ])
        );
        // git keeps the github-page form
        let (bin, a) = spawn_plan("git", r"\\wsl$\Ubuntu\home\u\api", &v(&["status"]));
        assert_eq!((bin.as_str(), a[4].as_str()), ("wsl.exe", "--"));
    }

    /// FR-6b: a native root resolves the CLI (the `.cmd` shim on Windows).
    #[test]
    fn a_native_root_resolves_the_cli_program() {
        let (bin, a) = spawn_plan("cohorte", "/tmp/p", &v(&["--version"]));
        assert_eq!(bin, crate::process_util::resolve_cli_program("cohorte"));
        assert_eq!(a, v(&["--version"]));
        assert_eq!(spawn_plan("git", "/tmp/p", &v(&["x"])).0, "git");
    }

    /// R-2 defence in depth + R-10: free text is allow-listed, flags dropped.
    #[test]
    fn free_text_is_allow_listed() {
        for bad in ["a&b", "x|y", "%PATH%", "a\"b", "$(id)", "-rf", "a\nb", "é"] {
            assert_eq!(
                argv::approve("run_a", "apr_b", Some(bad)).unwrap_err().code,
                ErrorCode::InvalidInput,
                "{bad:?}"
            );
        }
        assert!(argv::approve("run_a", "apr_b", Some("ship it: v1.2/x, don't")).is_ok());
        assert_eq!(
            argv::pause("run_a", Some("--force stop --now please")).unwrap(),
            v(&["pause", "run_a", "stop", "please"])
        );
        assert_eq!(
            argv::pause("run_a", Some("a;b")).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    /// R-10: a display hint with whitespace is quoted as one value.
    #[test]
    fn display_quotes_args_with_whitespace() {
        assert_eq!(
            display(&v(&["approve", "run_a", "apr_b", "send to fix"])),
            "cohorte approve run_a apr_b 'send to fix'"
        );
        assert_eq!(
            display(&v(&["approve", "run_a", "apr_b", "don't stop"])),
            r"cohorte approve run_a apr_b 'don'\''t stop'"
        );
    }

    #[test]
    fn a_command_document_yields_its_id_and_type() {
        let (id, ty) = command_doc(
            br#"{"documentVersion":1,"commandId":"cmd_1","type":"approve","status":"completed"}"#,
        );
        assert_eq!(
            (id.as_deref(), ty.as_deref()),
            (Some("cmd_1"), Some("approve"))
        );
        assert_eq!(command_doc(b"nope"), (None, None));
    }

    /// FR-6b: a stub whose grandchild holds the pipe (the `.cmd` → node
    /// shape) still returns at the deadline, with what it printed first.
    #[test]
    fn a_timed_out_tree_is_killed_and_keeps_its_early_stdout() {
        let stub = StubCli::printing_then_hanging("partial");
        let started = std::time::Instant::now();
        let o = run(
            &stub,
            Kind::Read,
            &stub.dir(),
            &argv::doctor(),
            Duration::from_millis(1500),
            READ_CAP,
        );
        assert!(o.timed_out);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
        assert!(String::from_utf8_lossy(&o.stdout).contains("partial"));
    }

    /// FR-6b, against the REAL installed CLI (run with `--ignored`): the
    /// spawn path resolves `cohorte` (on Windows the npm `.cmd` shim) and
    /// both `--version` and `doctor --json` answer.
    #[test]
    #[ignore = "needs a real cohorte on PATH"]
    fn the_real_cli_resolves_through_the_spawn_path() {
        // A scratch dir of its own: `doctor` creates `.cohorte/state` in its cwd.
        let scratch =
            std::env::temp_dir().join(format!("francois-cohorte-real-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        let dir = scratch.to_string_lossy().into_owned();
        let o = run(
            &SystemRunner,
            Kind::Read,
            &dir,
            &argv::version(),
            VERSION_TIMEOUT,
            READ_CAP,
        );
        assert!(!o.spawn_failed, "cohorte did not resolve: {}", o.stderr);
        let version = String::from_utf8_lossy(&o.stdout).trim().to_string();
        assert!(
            crate::cohorte::detect::parse_version(&version).is_some(),
            "{version:?} code={} timed_out={} stderr={}",
            o.code,
            o.timed_out,
            o.stderr
        );
        // `doctor --json` resolves through the same path. dev.1 on Windows
        // never exits when stdout is a pipe and only flushes on a graceful
        // exit, so the check here is that the tree kill returns at the
        // deadline instead of hanging (a document is read when one arrives).
        let started = std::time::Instant::now();
        let o = run(
            &SystemRunner,
            Kind::Read,
            &dir,
            &argv::doctor(),
            DOCTOR_TIMEOUT,
            READ_CAP,
        );
        assert!(!o.spawn_failed, "{}", o.stderr);
        assert!(started.elapsed() < DOCTOR_TIMEOUT + Duration::from_secs(10));
        assert!(
            o.timed_out || crate::cohorte::documents::parse_doctor(&o.stdout).is_some(),
            "doctor --json unreadable: {:?}",
            String::from_utf8_lossy(&o.stdout)
        );
        let _ = std::fs::remove_dir_all(&scratch);
    }
}
