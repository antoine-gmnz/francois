//! francois:session:submit / francois:session:clearQueue — pi-turn-controls
//! (specs/pi-turn-controls.md §5). Both are thin Tauri wrappers: the whole
//! decision ladder lives in `session::admission` (the ONE internal admission
//! entry point + the pure ledger it owns).

use crate::ipc::{err, ok, AppError, ErrorCode, IpcResult};
use crate::session::admission::{self, DeliveryMode, RuntimeQueueEntry};
use crate::session::*;
use serde_json::Value;
use tauri::{AppHandle, State};

/// invoke('session_submit', { sessionId, clientMessageId, text, delivery,
/// attachmentIds }): Promise<Result<RuntimeMessageReceipt>>
#[tauri::command(async)]
pub fn session_submit(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    client_message_id: String,
    text: String,
    delivery: DeliveryMode,
    attachment_ids: Option<Vec<String>>,
) -> IpcResult<Value> {
    match admission::admit_and_deliver(
        &app,
        &engine,
        &app,
        &session_id,
        &client_message_id,
        &text,
        delivery,
        attachment_ids.unwrap_or_default(),
    ) {
        Ok(receipt) => ok(serde_json::to_value(receipt).unwrap()),
        Err(e) => e.into(),
    }
}

/// pi-turn-controls FR-5/FR-6: the close/reopen bracket around a queue clear,
/// with the remote half injected so the whole decision is testable without an
/// `AppHandle`. Same shape `run_stop_sequence` uses, and for the same reason:
/// with admission open across the wire call, a `session_submit` already
/// blocked on the connection's write lock can be written to Pi in the gap —
/// and is then reported `cancelled` by the ledger while Pi executes it.
/// Reopen happens on EVERY path, including the early error return.
fn clear_queue_bracketed(
    engine: &Engine,
    session_id: &str,
    clear_remote: impl FnOnce() -> Result<(), AppError>,
) -> Result<Vec<RuntimeQueueEntry>, AppError> {
    // Held as a guard (LOW, review): the reopen used to be written out on both
    // paths by hand, so a panic between the close and either of them leaked a
    // close and left the session refusing every later submit.
    let _closed = admission::AdmissionClose::hold(engine, session_id);
    // Pi may still be holding the messages — on failure leave the ledger
    // exactly as it was rather than reporting entries cancelled that the
    // remote never dropped. The guard reopens on the way out.
    clear_remote()?;
    Ok(engine.with_admissions(session_id, |l| l.clear()))
}

/// invoke('session_clear_queue', { sessionId }): Promise<Result<RuntimeQueueClearOutput>>
#[tauri::command(async)]
pub fn session_clear_queue(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Value> {
    if engine.with_session(&session_id, |_| ()).is_none() {
        return err(ErrorCode::SessionNotFound, "no such session");
    }
    // pi-turn-controls FR-5/FR-6: clear BOTH sides — whatever Pi is currently
    // holding in its own queue, and every local ledger entry — never
    // clear-and-re-enqueue a live queue, which can duplicate consumed work.
    let connection = engine.runtime_connection_for(&session_id);
    let entries = match clear_queue_bracketed(&engine, &session_id, || match connection {
        Some(connection) => connection.clear_queue(),
        None => Ok(()),
    }) {
        Ok(entries) => entries,
        Err(e) => return e.into(),
    };
    admission::write_admission_sidecar(&app, &engine, &session_id);
    admission::publish_queue_changed(&app, &engine, &app, &session_id);
    ok(serde_json::json!({ "entries": entries }))
}

// Both commands themselves are thin `AppHandle` wrappers — this crate wires up
// no `AppHandle` test harness at all (see `env.rs`'s own doc comment, and
// `TurnContext`'s test in `adapter/mod.rs` for the same constraint) — so the
// whole decision ladder lives elsewhere and is covered there: the FR-1
// mode/state matrix, the FR-4 cap/idempotency rules, FR-5's local-vs-Pi-owned
// unqueue split and FR-9's crash-draft recovery are pure and fully covered in
// `session::admission`'s own test module. The ONE decision that is this file's
// own — `session_clear_queue`'s close/reopen bracket — is extracted into
// `clear_queue_bracketed`, which takes the remote clear as a closure and needs
// only an `Engine` (`testutil::test_engine_with`), and is tested below.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::admission::AdmissionState;
    use std::cell::Cell;

    fn engine() -> Engine {
        testutil::test_engine_with(testutil::test_session())
    }

    fn admit(engine: &Engine, id: &str) {
        engine
            .with_admissions("s1", |l| l.admit(id, "m", DeliveryMode::Normal, &[], 0))
            .unwrap();
    }

    #[test]
    fn the_remote_clear_runs_with_admission_already_closed() {
        let engine = engine();
        let closed_during = Cell::new(false);
        let entries = clear_queue_bracketed(&engine, "s1", || {
            closed_during.set(engine.with_admissions("s1", |l| l.is_closed()));
            Ok(())
        })
        .unwrap();
        assert!(entries.is_empty());
        assert!(
            closed_during.get(),
            "a submit racing this clear must be refused while the wire call is in flight"
        );
    }

    #[test]
    fn admission_is_open_again_after_a_successful_clear() {
        let engine = engine();
        admit(&engine, "c1");
        let entries = clear_queue_bracketed(&engine, "s1", || Ok(())).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(
            !engine.with_admissions("s1", |l| l.is_closed()),
            "a clear must not leave the session permanently unable to accept a submit"
        );
    }

    #[test]
    fn a_failed_remote_clear_reopens_admission_and_cancels_nothing() {
        let engine = engine();
        admit(&engine, "c1");
        let failed = clear_queue_bracketed(&engine, "s1", || {
            Err(AppError::new(ErrorCode::RuntimeTimeout, "no answer"))
        });
        assert!(failed.is_err());
        assert!(
            !engine.with_admissions("s1", |l| l.is_closed()),
            "the error path must reopen admission too"
        );
        let pending = engine.with_admissions("s1", |l| l.snapshot_pending());
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].receipt.state,
            AdmissionState::Admitting,
            "Pi may still be holding the message — the ledger must not report it cancelled"
        );
    }
}
