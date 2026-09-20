//! session/adapter/pi/controls.rs — pi-turn-controls (specs/pi-turn-controls.md
//! FR-5/FR-6/FR-7/FR-8): the `clear_queue`/`abort`/`compact` wire calls, and
//! the shared Stop sequence built from them.
//!
//! `clear_queue`/`abort`/`compact` are thin — each is a single
//! `PiConnection::dispatch` call (widened `pub(super)` for exactly this in
//! dispatcher.rs) — because the wire shape for all three is "no fields",
//! same as `get_state`/`interrupt` (wire.rs). `RuntimeSessionControl`'s
//! matching trait methods (adapter/mod.rs) delegate straight here.
//!
//! `run_stop_sequence` is FR-6/FR-7's whole Stop operation: close admission
//! → clear_queue (await) → abort → wait for the session to settle idle
//! (polling `Session.status`, since that is what a Pi `run.state` transition
//! already updates — no separate connection-state accessor was added purely
//! for this) → clear again after idle → confirm, all within a 5s total
//! budget. On any command failure or budget exhaustion it terminates the
//! tracked child tree (`Engine::shutdown_runtime`, the same owner
//! `session_remove`/app-exit already use) and marks every still-pending
//! admission `delivery-unknown`; a clean confirmation cancels them instead.
//!
//! PROVISIONAL (readiness gap, flagged in this feature's handoff — the spec
//! names this ambiguity explicitly): `clear_queue` and `abort` are
//! audit-named verbs (specs/research/pi-integration-audit.md: "`clear_queue`
//! and `abort` are separate") with no certified wire capture — this module's
//! best-effort mirror sends no fields for either, and never assumes `abort`
//! also empties Pi's queue (hence dispatching both, in that order, rather
//! than treating one as redundant). Reconciled against a real capture once
//! one exists.

use std::time::{Duration, Instant};

use crate::ipc::{AppError, ErrorCode};

use super::dispatcher::PiConnection;
use super::wire::PiCommandBody;

// ---------------------------------------------------------------- wire calls

/// pi-turn-controls FR-5/FR-6: clear whatever Pi is currently holding in its
/// OWN queue — the sole cancellation path for a message once it has moved
/// past `session_unqueue`'s "still local" window.
pub(super) fn clear_queue(conn: &PiConnection) -> Result<(), AppError> {
    conn.dispatch(PiCommandBody::ClearQueue).map(|_| ())
}

/// pi-turn-controls FR-6: abort the in-flight turn.
pub(super) fn abort(conn: &PiConnection) -> Result<(), AppError> {
    conn.dispatch(PiCommandBody::Abort).map(|_| ())
}

/// pi-turn-controls FR-8: manual compaction over this connection, bounded by
/// `Deadlines::compaction` (180s).
pub(super) fn compact(conn: &PiConnection) -> Result<(), AppError> {
    conn.dispatch(PiCommandBody::Compact).map(|_| ())
}

// ---------------------------------------------------------------- stop sequence

/// FR-6: the whole Stop operation's total budget.
const STOP_BUDGET: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// FR-6: the pure branch `run_stop_sequence` decides on, given what the wire
/// half reported and whether the session settled idle within budget —
/// separated out so the decision itself is unit-testable with no process,
/// no `AppHandle`, and no clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopDecision {
    /// clear_queue and abort both succeeded, and the session settled idle
    /// within budget — every pending admission is cleanly `Cancelled`.
    Confirmed,
    /// The session settled, but at least one command failed — cleanup is
    /// uncertain (FR-6), so every pending admission becomes `delivery-unknown`
    /// rather than a confident `Cancelled`.
    ProtocolUncertain,
    /// The session never confirmed idle within the 5s budget — same
    /// `delivery-unknown` outcome, plus the tracked child tree is terminated.
    BudgetExceeded,
}

impl StopDecision {
    fn decide(clear_ok: bool, abort_ok: bool, settled: bool) -> Self {
        if settled && clear_ok && abort_ok {
            Self::Confirmed
        } else if settled {
            Self::ProtocolUncertain
        } else {
            Self::BudgetExceeded
        }
    }

    fn confirmed(self) -> bool {
        self == Self::Confirmed
    }

    /// Whether the caller must terminate the tracked child tree (FR-6:
    /// "terminate the tracked child tree" on failure/timeout) — everything
    /// except a clean confirmation.
    fn must_terminate(self) -> bool {
        !self.confirmed()
    }
}

/// FR-6/FR-7: close admission → clear_queue (await) → abort → wait for idle
/// → clear again → confirm, all within a 5s budget; on failure, terminate
/// the tracked child tree and mark uncertain entries `delivery-unknown`.
///
/// Idempotent by construction (FR-7's "double Stop"): once a prior call has
/// already retired the connection (`Engine::shutdown_runtime`), this call
/// finds none and takes the "idle Stop" branch below — a no-op success that
/// still closes/reopens admission and re-publishes the (now empty or
/// unchanged) pending snapshot. A Stop issued before any connection was ever
/// installed (mid-startup) takes the SAME branch: admission is closed and
/// cleared immediately, but an in-flight `connect_session` call itself is
/// not separately cancelled by this function — see this feature's handoff.
pub(crate) fn run_stop_sequence(
    app: &tauri::AppHandle,
    engine: &crate::session::Engine,
    accounts: &dyn crate::account::AccountKinds,
    session_id: &str,
) -> Result<(), AppError> {
    use crate::session::{admission, status};

    // FR-6: "Stop closes admission" — the very first step, so a submit
    // racing this call is refused rather than slipping in mid-stop.
    engine.with_admissions(session_id, |l| l.close());

    let Some(connection) = engine.runtime_connection_for(session_id) else {
        engine.with_admissions(session_id, |l| {
            l.reopen();
            l.clear();
        });
        admission::write_admission_sidecar(app, engine, session_id);
        admission::publish_queue_changed(app, engine, accounts, session_id);
        return Ok(());
    };

    let start = Instant::now();
    let clear_ok = connection.clear_queue().is_ok();
    let abort_ok = connection.abort().is_ok();

    let mut settled = false;
    while start.elapsed() < STOP_BUDGET {
        if engine
            .with_session(session_id, |s| !status::is_busy(&s.status))
            .unwrap_or(true)
        {
            settled = true;
            break;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    if settled {
        // FR-6: "clear again after idle to handle a queue transition race."
        let _ = connection.clear_queue();
    }

    let decision = StopDecision::decide(clear_ok, abort_ok, settled);
    if decision.must_terminate() {
        let _ = engine.shutdown_runtime(session_id);
    }

    engine.with_admissions(session_id, |l| {
        l.reopen();
        if decision.confirmed() {
            l.clear();
        } else {
            l.mark_all_pending_unknown();
        }
    });
    admission::write_admission_sidecar(app, engine, session_id);
    admission::publish_queue_changed(app, engine, accounts, session_id);

    match decision {
        StopDecision::Confirmed => Ok(()),
        StopDecision::ProtocolUncertain => Err(AppError::new(
            ErrorCode::RuntimeProtocolError,
            "stop could not confirm clear_queue/abort",
        )),
        StopDecision::BudgetExceeded => Err(AppError::new(
            ErrorCode::RuntimeTimeout,
            "stop did not settle within its 5s budget",
        )),
    }
}

#[cfg(test)]
mod decision_tests {
    use super::*;

    #[test]
    fn both_commands_succeeding_and_settling_in_time_is_confirmed() {
        let d = StopDecision::decide(true, true, true);
        assert_eq!(d, StopDecision::Confirmed);
        assert!(d.confirmed());
        assert!(!d.must_terminate());
    }

    #[test]
    fn a_failed_command_that_still_settles_is_protocol_uncertain_not_confirmed() {
        for (clear_ok, abort_ok) in [(false, true), (true, false), (false, false)] {
            let d = StopDecision::decide(clear_ok, abort_ok, true);
            assert_eq!(d, StopDecision::ProtocolUncertain);
            assert!(!d.confirmed());
            assert!(d.must_terminate());
        }
    }

    #[test]
    fn never_settling_is_budget_exceeded_regardless_of_command_outcomes() {
        for (clear_ok, abort_ok) in [(true, true), (false, false)] {
            let d = StopDecision::decide(clear_ok, abort_ok, false);
            assert_eq!(d, StopDecision::BudgetExceeded);
            assert!(d.must_terminate());
        }
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use crate::ipc::ErrorCode as Code;
    use crate::session::adapter::RuntimeSessionControl as _;
    use crate::session::events::{RuntimeEventPayload, RuntimeRunState};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};

    // Self-contained fake-process harness (same shape dispatcher_tests.rs
    // uses) — duplicated locally rather than reaching into that file's
    // private `mod connection_tests`, which this module cannot see.

    fn test_pipe_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = TcpStream::connect(addr).unwrap();
        let (server, _) = listener.accept().unwrap();
        client.set_nodelay(true).ok();
        server.set_nodelay(true).ok();
        (client, server)
    }

    struct NoopPublisher;
    impl super::super::dispatcher::EventPublisher for NoopPublisher {
        fn run_state(&self, _state: RuntimeRunState) {}
        fn failure(
            &self,
            _code: Code,
            _reason: &str,
            _ctx: super::super::dispatcher::DiagnosticContext,
        ) {
        }
        fn diagnostic(&self, _message: &str, _ctx: super::super::dispatcher::DiagnosticContext) {}
        fn transcript(&self, _event: RuntimeEventPayload) {}
    }

    /// FIX (this feature's own regression): `wait_timeout` used to always
    /// return `true` ("already exited"), which made every `shutdown()` skip
    /// `kill()` entirely — the fake socket was then NEVER closed, so the
    /// reader thread's `read()` looped on its own 50ms poll timeout forever
    /// and `shutdown()`'s `handle.join()` hung the test for good. Mirrors
    /// `dispatcher_tests.rs::handle_over`'s working shape: `wait_timeout`
    /// reports NOT-yet-exited until `kill()` actually runs and closes the
    /// socket, which is what every test's trailing `conn.shutdown()` needs to
    /// return at all.
    fn handle_over(dispatcher_end: TcpStream) -> super::super::process::ProcessHandle {
        let stdout = dispatcher_end.try_clone().unwrap();
        stdout
            .set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        let socket = dispatcher_end.try_clone().unwrap();
        let exited = Arc::new(Mutex::new(false));
        let exited_for_wait = exited.clone();
        super::super::process::ProcessHandle {
            stdin: Box::new(dispatcher_end),
            stdout: Box::new(stdout),
            wait_timeout: Box::new(move |_| *exited_for_wait.lock().unwrap()),
            kill: Box::new(move || {
                *exited.lock().unwrap() = true;
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }),
            stderr_ring: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn read_line(child: &mut TcpStream) -> String {
        let mut byte = [0u8; 1];
        let mut line = Vec::new();
        loop {
            let n = child.read(&mut byte).unwrap();
            assert!(n > 0, "peer closed before a full line arrived");
            if byte[0] == b'\n' {
                break;
            }
            line.push(byte[0]);
        }
        String::from_utf8(line).unwrap()
    }

    fn write_line(child: &mut TcpStream, line: &str) {
        child.write_all(line.as_bytes()).unwrap();
        child.write_all(b"\n").unwrap();
    }

    fn extract_id(line: &str) -> String {
        serde_json::from_str::<serde_json::Value>(line).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn resp(id: &str, command: &str, success: bool) -> String {
        serde_json::json!({ "id": id, "command": command, "success": success }).to_string()
    }

    /// Handshake, THEN hand back the connected `PiConnection` — every test
    /// below starts from an idle connection, bounded by the harness's own
    /// short deadlines so a stuck test fails fast rather than hanging the
    /// shared suite (rule: fake-process tests must be bounded).
    fn connected() -> (Arc<PiConnection>, TcpStream) {
        let (dispatcher_end, mut fake_child) = test_pipe_pair();
        let handle = handle_over(dispatcher_end);
        let connect =
            std::thread::spawn(move || PiConnection::connect_with(Arc::new(NoopPublisher), handle));
        let req = read_line(&mut fake_child);
        write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
        (connect.join().unwrap().unwrap(), fake_child)
    }

    #[test]
    fn clear_queue_dispatches_the_named_command_with_no_fields() {
        let (conn, mut fake_child) = connected();
        let conn2 = conn.clone();
        let call = std::thread::spawn(move || clear_queue(&conn2));
        let req = read_line(&mut fake_child);
        let v: serde_json::Value = serde_json::from_str(&req).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "id": v["id"], "type": "clear_queue" })
        );
        write_line(
            &mut fake_child,
            &resp(v["id"].as_str().unwrap(), "clear_queue", true),
        );
        call.join().unwrap().unwrap();
        conn.shutdown().unwrap();
    }

    #[test]
    fn abort_dispatches_the_named_command_and_is_distinct_from_interrupt() {
        let (conn, mut fake_child) = connected();
        let conn2 = conn.clone();
        let call = std::thread::spawn(move || abort(&conn2));
        let req = read_line(&mut fake_child);
        let v: serde_json::Value = serde_json::from_str(&req).unwrap();
        assert_eq!(v["type"], "abort");
        assert_ne!(v["type"], "interrupt");
        write_line(
            &mut fake_child,
            &resp(v["id"].as_str().unwrap(), "abort", true),
        );
        call.join().unwrap().unwrap();
        conn.shutdown().unwrap();
    }

    #[test]
    fn compact_dispatches_the_named_command() {
        let (conn, mut fake_child) = connected();
        let conn2 = conn.clone();
        let call = std::thread::spawn(move || compact(&conn2));
        let req = read_line(&mut fake_child);
        let v: serde_json::Value = serde_json::from_str(&req).unwrap();
        assert_eq!(v["type"], "compact");
        write_line(
            &mut fake_child,
            &resp(v["id"].as_str().unwrap(), "compact", true),
        );
        call.join().unwrap().unwrap();
        conn.shutdown().unwrap();
    }

    #[test]
    fn a_clean_rejection_surfaces_as_an_error_not_a_panic() {
        let (conn, mut fake_child) = connected();
        let conn2 = conn.clone();
        let call = std::thread::spawn(move || abort(&conn2));
        let req = read_line(&mut fake_child);
        let v: serde_json::Value = serde_json::from_str(&req).unwrap();
        write_line(
            &mut fake_child,
            &serde_json::json!({ "id": v["id"], "command": "abort", "success": false, "error": "nothing to abort" })
                .to_string(),
        );
        assert!(call.join().unwrap().is_err());
        conn.shutdown().unwrap();
    }

    /// pi-turn-controls FR-6: `clear_queue`/`abort`/`compact` must each have
    /// a hard deadline — a silent child surfaces `RUNTIME_TIMEOUT`, never an
    /// unbounded wait. Deadlines are shortened to 200ms purely so THIS TEST
    /// finishes in well under a second; production keeps FR-6/FR-8's real
    /// 10s/180s bounds (`Deadlines::default`, `protocol.rs`).
    #[test]
    fn abort_surfaces_a_bounded_runtime_timeout_when_the_child_goes_silent() {
        let (dispatcher_end, mut fake_child) = test_pipe_pair();
        let handle = handle_over(dispatcher_end);
        let deadlines = super::super::protocol::Deadlines {
            init: Duration::from_millis(200),
            read_only: Duration::from_millis(200),
            prompt: Duration::from_millis(200),
            compaction: Duration::from_millis(200),
        };
        let connect = std::thread::spawn(move || {
            PiConnection::connect_with_deadlines(Arc::new(NoopPublisher), handle, deadlines)
        });
        let req = read_line(&mut fake_child);
        write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
        let conn = connect.join().unwrap().unwrap();

        // The fake child never answers "abort" at all — dispatch must time
        // out bounded rather than block forever on a silent child.
        let started = std::time::Instant::now();
        let err = abort(&conn).unwrap_err();
        assert_eq!(err.code, Code::RuntimeTimeout);
        assert!(started.elapsed() < Duration::from_secs(1));

        conn.shutdown().unwrap();
    }
}
