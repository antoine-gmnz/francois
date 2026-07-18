// Shared Result<T> envelope (matches contract/common.ts `Result` / `AppError`).
// Every Tauri command in Francois RESOLVES one of these — it never rejects
// across the bridge, so the frontend always gets `{ ok, ... }`.

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct AppError {
    pub code: String,
    pub message: String,
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
        error: AppError { code: code.into(), message: message.into() },
    }
}
