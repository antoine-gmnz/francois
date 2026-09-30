//! Explicit browser action for the exact pending MCP URL elicitation.
use crate::{
    ipc::{ok, AppError, ErrorCode, IpcResult},
    session::{application::ResourceRequest, Engine},
};
use tauri::State;
#[tauri::command(async)]
pub fn session_open_request_url(
    engine: State<'_, Engine>,
    session_id: String,
    block_id: String,
) -> IpcResult<Option<()>> {
    let result = (|| {
        let runtime = engine
            .with_session(&session_id, |session| {
                session
                    .session_runtime
                    .as_ref()
                    .map(|binding| binding.runtime.clone())
            })
            .flatten()
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::SessionNotRunning,
                    "This request's connection is unavailable",
                )
            })?;
        let url = runtime.resource(ResourceRequest::RequestUrl(block_id))?;
        let url = url
            .as_str()
            .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "This request has no URL"))?;
        crate::process_util::open_http_url(url).map_err(|_| {
            AppError::new(
                ErrorCode::RuntimeUnavailable,
                "Could not open the MCP request page",
            )
        })
    })();
    match result {
        Ok(()) => ok(None),
        Err(error) => error.into(),
    }
}
