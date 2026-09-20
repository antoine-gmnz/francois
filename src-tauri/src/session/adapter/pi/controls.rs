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

/// FR-6: the budget the Stop operation gives the session to SETTLE IDLE.
///
/// MED (review): it used to start before `clear_queue`/`abort` were even
/// dispatched. Each of those already carries its own hard deadline
/// (`Deadlines::read_only`, protocol.rs), so counting their round trips
/// against this budget could exhaust it before the first poll ever ran — and
/// the `while elapsed < BUDGET` loop then ran ZERO times, reporting a
/// perfectly healthy, already-idle child as `BudgetExceeded` and killing it.
/// The budget now starts once both wire calls have returned, and the loop
/// checks at least once before escalating.
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
    use crate::session::admission;

    let result = stop_sequence(engine, session_id, STOP_BUDGET);
    // The two `AppHandle` side effects, hoisted out of every branch of the
    // sequence below so it needs no Tauri app of its own and stays testable
    // against a fake child (same shape `clear_queue_bracketed`,
    // commands/submit.rs, uses for the same reason). Both ran on every path
    // before, and still do.
    admission::write_admission_sidecar(app, engine, session_id);
    admission::publish_queue_changed(app, engine, accounts, session_id);
    result
}

/// `run_stop_sequence`'s whole decision, minus its two `AppHandle` side
/// effects. `settle_budget` is a parameter purely so a test can drive the
/// budget without a five-second wait; production always passes
/// [`STOP_BUDGET`].
fn stop_sequence(
    engine: &crate::session::Engine,
    session_id: &str,
    settle_budget: Duration,
) -> Result<(), AppError> {
    use crate::session::{admission::AdmissionClose, status};

    // FR-6: "Stop closes admission" — the very first step, so a submit
    // racing this call is refused rather than slipping in mid-stop. Held as a
    // guard: every return below reopens it, and so does a panic.
    let _closed = AdmissionClose::hold(engine, session_id);

    let Some(connection) = engine.runtime_connection_for(session_id) else {
        engine.with_admissions(session_id, |l| l.clear());
        return Ok(());
    };

    let clear_ok = connection.clear_queue().is_ok();
    let abort_ok = connection.abort().is_ok();

    // The settle budget starts HERE — see `STOP_BUDGET`'s own comment.
    let settled = await_settled(settle_budget, || {
        engine
            .with_session(session_id, |s| !status::is_busy(&s.status))
            .unwrap_or(true)
    });
    if settled {
        // FR-6: "clear again after idle to handle a queue transition race."
        let _ = connection.clear_queue();
    }

    let decision = StopDecision::decide(clear_ok, abort_ok, settled);
    if decision.must_terminate() {
        let _ = engine.shutdown_runtime(session_id);
    }

    engine.with_admissions(session_id, |l| {
        if decision.confirmed() {
            l.clear();
        } else {
            l.mark_all_pending_unknown();
        }
    });

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

/// FR-6: poll until the session reports itself settled, or `budget` runs out.
///
/// MED (review): the check comes FIRST and the deadline second, so an already
/// idle session settles even with no budget left at all. The old
/// `while start.elapsed() < BUDGET { .. }` shape could run its body zero
/// times, and a "never settled" verdict is what terminates the child tree.
fn await_settled(budget: Duration, mut is_settled: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    loop {
        if is_settled() {
            return true;
        }
        if start.elapsed() >= budget {
            return false;
        }
        std::thread::sleep(POLL_INTERVAL);
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

    /// MED (review): with the budget already spent by the two wire calls the
    /// old `while elapsed < BUDGET` loop ran ZERO times, so an already-idle
    /// session was reported "never settled" — and "never settled" is what
    /// terminates the child tree. The check must come before the deadline.
    #[test]
    fn an_already_settled_session_settles_even_with_no_budget_left() {
        let mut polls = 0;
        assert!(await_settled(Duration::ZERO, || {
            polls += 1;
            true
        }));
        assert_eq!(polls, 1, "the state must be read at least once");
    }

    #[test]
    fn a_session_that_never_settles_exhausts_the_budget_without_hanging() {
        let started = Instant::now();
        assert!(!await_settled(Duration::from_millis(80), || false));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use crate::ipc::ErrorCode as Code;
    use crate::session::adapter::RuntimeSessionControl as _;
    // ONE fake child for the whole `adapter::pi` module (`dispatcher`'s own
    // `mod testutil`, widened for exactly this): this module used to carry a
    // copy of the whole harness — its own pipe pair, its own publisher, its
    // own hand-rolled read deadline — which is one more place for a hang to
    // hide than there needs to be.
    use super::super::dispatcher::testutil::{
        connected, connected_with_deadlines, read_line, resp, write_line,
    };
    use std::sync::Arc;

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
        let (conn, _fake_child) = connected_with_deadlines(super::super::protocol::Deadlines {
            init: Duration::from_millis(200),
            read_only: Duration::from_millis(200),
            prompt: Duration::from_millis(200),
            compaction: Duration::from_millis(200),
        });

        // The fake child never answers "abort" at all — dispatch must time
        // out bounded rather than block forever on a silent child.
        let started = std::time::Instant::now();
        let err = abort(&conn).unwrap_err();
        assert_eq!(err.code, Code::RuntimeTimeout);
        assert!(started.elapsed() < Duration::from_secs(1));

        conn.shutdown().unwrap();
    }

    // ---------------------------------------------- the whole Stop sequence

    /// Tests (review): `run_stop_sequence` had no engine-level coverage at
    /// all — only the pure `StopDecision`. This drives the REAL sequence
    /// against a fake child: admission closed, `clear_queue`, `abort`, the
    /// settle poll, `clear_queue` again, then the pending drafts cancelled.
    ///
    /// The `Duration::ZERO` settle budget is the MED regression itself, not a
    /// convenience: the two wire calls above must not eat the settle budget,
    /// and the settle check must run at least once. With the old shape this
    /// perfectly idle session was declared `BudgetExceeded` and its healthy
    /// child terminated.
    #[test]
    fn a_stop_against_an_idle_child_confirms_and_cancels_its_drafts() {
        use crate::session::adapter::RuntimeSessionControl as Control;
        use crate::session::admission::{AdmissionState, DeliveryMode};
        use crate::session::testutil::{test_engine_with, test_session};

        let engine = Arc::new(test_engine_with(test_session()));
        let (conn, mut fake_child) = connected();
        engine
            .runtime_connections
            .lock()
            .unwrap()
            .insert("s1".into(), conn.clone() as Arc<dyn Control>);
        engine
            .with_admissions("s1", |l| {
                l.admit("c1", "keep my text", DeliveryMode::Normal, &[], 7)
            })
            .unwrap();

        let worker = engine.clone();
        let stop = std::thread::spawn(move || super::stop_sequence(&worker, "s1", Duration::ZERO));

        let mut seen = Vec::new();
        for _ in 0..3 {
            let v: serde_json::Value = serde_json::from_str(&read_line(&mut fake_child)).unwrap();
            let kind = v["type"].as_str().unwrap().to_string();
            write_line(
                &mut fake_child,
                &resp(v["id"].as_str().unwrap(), &kind, true),
            );
            seen.push(kind);
        }
        assert_eq!(
            seen,
            ["clear_queue", "abort", "clear_queue"],
            "FR-6: clear_queue is awaited before abort, and repeated once idle"
        );
        stop.join().unwrap().expect("a confirmed stop resolves Ok");

        let pending = engine.with_admissions("s1", |l| l.snapshot_pending());
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].receipt.state, AdmissionState::Cancelled);
        assert_eq!(pending[0].text, "keep my text", "FR-9: text is retained");
        assert!(
            !engine.with_admissions("s1", |l| l.is_closed()),
            "the close/reopen bracket must not leave the session stopping forever"
        );
        assert!(
            engine
                .runtime_connections
                .lock()
                .unwrap()
                .contains_key("s1"),
            "a confirmed stop must not terminate a healthy child"
        );

        conn.shutdown().unwrap();
    }

    /// FR-6: a command that FAILS is `ProtocolUncertain` — the drafts become
    /// `delivery-unknown` rather than a confident `cancelled`, and the tracked
    /// child tree is terminated.
    #[test]
    fn a_refused_abort_terminates_the_child_and_leaves_the_drafts_unknown() {
        use crate::session::adapter::RuntimeSessionControl as Control;
        use crate::session::admission::{AdmissionState, DeliveryMode};
        use crate::session::testutil::{test_engine_with, test_session};

        let engine = Arc::new(test_engine_with(test_session()));
        let (conn, mut fake_child) = connected();
        engine
            .runtime_connections
            .lock()
            .unwrap()
            .insert("s1".into(), conn.clone() as Arc<dyn Control>);
        engine
            .with_admissions("s1", |l| {
                l.admit("c1", "draft", DeliveryMode::Normal, &[], 7)
            })
            .unwrap();

        let worker = engine.clone();
        let stop = std::thread::spawn(move || super::stop_sequence(&worker, "s1", Duration::ZERO));

        for i in 0..3 {
            let v: serde_json::Value = serde_json::from_str(&read_line(&mut fake_child)).unwrap();
            let kind = v["type"].as_str().unwrap().to_string();
            write_line(
                &mut fake_child,
                &resp(v["id"].as_str().unwrap(), &kind, i != 1),
            );
        }
        let err = stop.join().unwrap().unwrap_err();
        assert_eq!(err.code, Code::RuntimeProtocolError);

        let pending = engine.with_admissions("s1", |l| l.snapshot_pending());
        assert_eq!(pending[0].receipt.state, AdmissionState::DeliveryUnknown);
        assert!(
            !engine
                .runtime_connections
                .lock()
                .unwrap()
                .contains_key("s1"),
            "FR-6: an unconfirmed stop terminates the tracked child tree"
        );
    }

    /// FR-7: "Idle Stop is a no-op success" — a session whose connection was
    /// already retired (a prior Stop) still closes/reopens admission and
    /// cancels whatever drafts are on record.
    #[test]
    fn a_stop_with_no_connection_is_a_no_op_success_that_still_cancels() {
        use crate::session::admission::{AdmissionState, DeliveryMode};
        use crate::session::testutil::{test_engine_with, test_session};

        let engine = test_engine_with(test_session());
        engine
            .with_admissions("s1", |l| {
                l.admit("c1", "draft", DeliveryMode::Normal, &[], 7)
            })
            .unwrap();
        super::stop_sequence(&engine, "s1", Duration::ZERO).unwrap();
        let pending = engine.with_admissions("s1", |l| l.snapshot_pending());
        assert_eq!(pending[0].receipt.state, AdmissionState::Cancelled);
        assert!(!engine.with_admissions("s1", |l| l.is_closed()));
    }
}
