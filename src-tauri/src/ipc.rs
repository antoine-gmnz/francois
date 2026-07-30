// Shared Result<T> envelope (matches contract/common.ts `Result` / `AppError`).
// Every Tauri command in Francois RESOLVES one of these — it never rejects
// across the bridge, so the frontend always gets `{ ok, ... }`.

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone)]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum IpcResult<T: Serialize> {
    Ok { ok: bool, data: T },
    Err { ok: bool, error: AppError },
}

pub fn ok<T: Serialize>(data: T) -> IpcResult<T> {
    IpcResult::Ok { ok: true, data }
}

pub fn err<T: Serialize>(code: &str, message: impl Into<String>) -> IpcResult<T> {
    IpcResult::Err {
        ok: false,
        error: AppError {
            code: code.into(),
            message: message.into(),
            detail: None,
        },
    }
}

/// session-worktree FR-11 (WORKTREE_BRANCH_IN_USE detail: `{ path }`) — an error
/// with a machine-readable `detail` payload alongside the human message.
pub fn err_detail<T: Serialize>(
    code: &str,
    message: impl Into<String>,
    detail: Value,
) -> IpcResult<T> {
    IpcResult::Err {
        ok: false,
        error: AppError {
            code: code.into(),
            message: message.into(),
            detail: Some(detail),
        },
    }
}
