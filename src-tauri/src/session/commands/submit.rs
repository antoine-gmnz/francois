//! francois:session:submit / francois:session:clearQueue — pi-turn-controls
//! (specs/pi-turn-controls.md §5). Both are thin Tauri wrappers: the whole
//! decision ladder lives in `session::admission` (the ONE internal admission
//! entry point + the pure ledger it owns).

use crate::ipc::{err, ok, ErrorCode, IpcResult};
use crate::session::admission::{self, DeliveryMode};
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
    if let Some(connection) = engine.runtime_connection_for(&session_id) {
        if let Err(e) = connection.clear_queue() {
            return e.into();
        }
    }
    let entries = engine.with_admissions(&session_id, |l| l.clear());
    admission::write_admission_sidecar(&app, &engine, &session_id);
    admission::publish_queue_changed(&app, &engine, &app, &session_id);
    ok(serde_json::json!({ "entries": entries }))
}

// No unit tests in this file: both commands are thin `AppHandle` wrappers —
// this crate wires up no `AppHandle` test harness at all (see `env.rs`'s own
// doc comment, and `TurnContext`'s test in `adapter/mod.rs` for the same
// constraint). The whole decision ladder — the FR-1 mode/state matrix, the
// FR-4 cap/idempotency rules, FR-5's local-vs-Pi-owned unqueue split, and
// FR-9's crash-draft recovery — is pure and fully covered in
// `session::admission`'s own test module.
