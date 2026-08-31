// Shared Result<T> envelope (matches contract/common.ts `Result` / `AppError`).
// Every Tauri command in Francois RESOLVES one of these — it never rejects
// across the bridge, so the frontend always gets `{ ok, ... }`.
//
// core-architecture-wave3 module map:
//  * error_code — the 82-member `ErrorCode` vocabulary, compile-checked against
//    `contract/common.ts` (FR-4/FR-5).
//  * model — `ModelInfo`, the contract's model shape, built by the session
//    catalog and by endpoint accounts alike (FR-9).

mod error_code;
mod model;

pub use error_code::ErrorCode;
pub use model::{model, ModelInfo};

use serde::Serialize;
use serde_json::Value;

// `Debug`/`PartialEq` so a domain that carries an AppError INSIDE an event
// payload (extensions' `ext.stream.error`) can derive them on the union.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AppError {
    // core-architecture-wave3 FR-4: an `ErrorCode`, not a `String` — the
    // compiler now rejects a code the contract does not declare.
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        AppError {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(code: ErrorCode, message: impl Into<String>, detail: Value) -> Self {
        AppError {
            code,
            message: message.into(),
            detail: Some(detail),
        }
    }
}

// core-architecture-wave3 FR-6: FR-6 turns ~43 `Result<T, String>` signatures
// into `Result<T, AppError>`, and a good number of their callers only ever
// wanted the human sentence — `eprintln!("… {e}")` in a best-effort path, or a
// message folded into a larger one. `Display` is that sentence and NOTHING
// else: the code is machine-facing and belongs on the wire, not in a log line.
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

#[derive(Serialize)]
#[serde(untagged)]
pub enum IpcResult<T: Serialize> {
    Ok { ok: bool, data: T },
    Err { ok: bool, error: AppError },
}

// core-architecture-wave3 FR-6: internal fallible code returns
// `Result<T, AppError>`; a command body ends in `.into()` instead of the
// hand-written `match` ladder every command used to carry. `IpcResult` stays a
// non-`Result` untagged serde enum — that is deliberate and correct for the
// wire (the frontend reads `{ ok, data }` / `{ ok, error }`, not a serde-tagged
// `Result`); only the CONVERSION into it is shared.
impl<T: Serialize> From<Result<T, AppError>> for IpcResult<T> {
    fn from(result: Result<T, AppError>) -> Self {
        match result {
            Ok(data) => IpcResult::Ok { ok: true, data },
            Err(error) => IpcResult::Err { ok: false, error },
        }
    }
}

// core-architecture-wave3 FR-6: the early-return half. A command that bails
// part-way through (a validation guard, a lock that could not be taken) has an
// `AppError` in hand and no `Result` to convert — `return e.into()` is that
// conversion, and it is what replaced the `Err(AppError { code, message, .. })
// => err(code, message)` destructures the account surface used to carry.
impl<T: Serialize> From<AppError> for IpcResult<T> {
    fn from(error: AppError) -> Self {
        IpcResult::Err { ok: false, error }
    }
}

pub fn ok<T: Serialize>(data: T) -> IpcResult<T> {
    IpcResult::Ok { ok: true, data }
}

pub fn err<T: Serialize>(code: ErrorCode, message: impl Into<String>) -> IpcResult<T> {
    IpcResult::Err {
        ok: false,
        error: AppError::new(code, message),
    }
}

/// session-worktree FR-11 (WORKTREE_BRANCH_IN_USE detail: `{ path }`) — an error
/// with a machine-readable `detail` payload alongside the human message.
pub fn err_detail<T: Serialize>(
    code: ErrorCode,
    message: impl Into<String>,
    detail: Value,
) -> IpcResult<T> {
    IpcResult::Err {
        ok: false,
        error: AppError::with_detail(code, message, detail),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ok_serializes_as_the_contract_envelope() {
        let value = serde_json::to_value(ok(42)).expect("serialize");
        assert_eq!(value, serde_json::json!({ "ok": true, "data": 42 }));
    }

    #[test]
    fn err_serializes_the_code_as_the_union_spelling() {
        let value =
            serde_json::to_value(err::<()>(ErrorCode::SessionNotFound, "gone")).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "ok": false,
                "error": { "code": "SESSION_NOT_FOUND", "message": "gone" }
            })
        );
    }

    #[test]
    fn err_detail_carries_the_machine_readable_payload() {
        let value = serde_json::to_value(err_detail::<()>(
            ErrorCode::WorktreeBranchInUse,
            "taken",
            serde_json::json!({ "path": "/tmp/wt" }),
        ))
        .expect("serialize");
        assert_eq!(value["error"]["detail"]["path"], "/tmp/wt");
        assert_eq!(value["error"]["code"], "WORKTREE_BRANCH_IN_USE");
    }

    // FR-6: the conversion command bodies use instead of a `match` ladder.
    #[test]
    fn from_result_ok_becomes_the_ok_envelope() {
        let converted: IpcResult<u8> = Ok::<u8, AppError>(7).into();
        assert_eq!(
            serde_json::to_value(converted).expect("serialize"),
            serde_json::json!({ "ok": true, "data": 7 })
        );
    }

    // FR-6: the early-return half, and it must carry `detail` through — the
    // account/attachment/adopt surfaces used to hand-split detail-present from
    // detail-absent, and `.into()` is only a safe replacement if it does not
    // quietly drop the payload.
    #[test]
    fn from_app_error_becomes_the_err_envelope_with_its_detail() {
        let converted: IpcResult<u8> = AppError::with_detail(
            ErrorCode::AttachmentTooLarge,
            "too big",
            serde_json::json!({ "bytes": 11, "cap": 10 }),
        )
        .into();
        assert_eq!(
            serde_json::to_value(converted).expect("serialize"),
            serde_json::json!({
                "ok": false,
                "error": {
                    "code": "ATTACHMENT_TOO_LARGE",
                    "message": "too big",
                    "detail": { "bytes": 11, "cap": 10 },
                }
            })
        );
    }

    // FR-6: `Display` is the message, so a log line reads as prose and the
    // machine-facing code stays on the wire.
    #[test]
    fn display_is_the_message_alone() {
        let e = AppError::new(ErrorCode::SettingsWriteFailed, "could not write settings");
        assert_eq!(format!("{e}"), "could not write settings");
    }

    #[test]
    fn from_result_err_becomes_the_err_envelope() {
        let converted: IpcResult<u8> =
            Err::<u8, AppError>(AppError::new(ErrorCode::Internal, "boom")).into();
        assert_eq!(
            serde_json::to_value(converted).expect("serialize"),
            serde_json::json!({
                "ok": false,
                "error": { "code": "INTERNAL", "message": "boom" }
            })
        );
    }
}
