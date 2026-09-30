//! Framework composition for the same native process that owns the Codex thread.
use super::{RemoteState, RemoteStatus};
use crate::{
    ipc::{ok, AppError, ErrorCode, IpcResult},
    session::{application::ResourceRequest, Engine},
};

pub(super) fn command(
    engine: &Engine,
    id: &str,
    request: ResourceRequest,
) -> IpcResult<RemoteStatus> {
    let runtime = engine.with_session(id, |session| {
        session
            .session_runtime
            .as_ref()
            .map(|binding| binding.runtime.clone())
    });
    let Some(runtime) = runtime else {
        return AppError::new(ErrorCode::SessionNotFound, "no such session").into();
    };
    let state = if let Some(runtime) = runtime {
        match runtime.resource(request).and_then(|value| {
            serde_json::from_value(value).map_err(|_| {
                AppError::new(
                    ErrorCode::RuntimeProtocolError,
                    "Codex returned invalid remote-control status",
                )
            })
        }) {
            Ok(state) => state,
            Err(error) => return error.into(),
        }
    } else if matches!(
        request,
        ResourceRequest::RemoteGet | ResourceRequest::RemoteStop
    ) {
        RemoteState::Off
    } else {
        return AppError::new(
            ErrorCode::RuntimeUnavailable,
            "Send a first message to connect this Codex session before enabling remote control",
        )
        .into();
    };
    ok(RemoteStatus {
        session_id: id.into(),
        state,
    })
}
