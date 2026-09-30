//! Resource commands use the live native owner, or an isolated pre-turn probe.
use crate::ipc::{AppError, ErrorCode};
use crate::session::{
    application::{ResourceRequest, TurnMode},
    Engine,
};
use serde_json::Value;
use tauri::AppHandle;

pub(crate) fn dispatch(
    app: &AppHandle,
    engine: &Engine,
    id: &str,
    request: ResourceRequest,
) -> Result<Value, AppError> {
    let bound = engine
        .with_session(id, |session| {
            session
                .session_runtime
                .as_ref()
                .map(|binding| binding.runtime.clone())
        })
        .ok_or_else(|| AppError::new(ErrorCode::SessionNotFound, "no such session"))?;
    if let Some(runtime) = bound {
        let reconnect = matches!(&request, ResourceRequest::McpReconnect(_));
        let result = runtime.resource(request)?;
        if reconnect {
            if let Some(url) = result["authorizationUrl"].as_str() {
                crate::process_util::open_http_url(url).map_err(|_| {
                    AppError::new(
                        ErrorCode::McpError,
                        "Could not open the native MCP sign-in page",
                    )
                })?;
                return Ok(Value::Null);
            }
        }
        return Ok(result);
    }
    let mut ctx = crate::session::turn::build_turn_context(
        engine,
        id,
        String::new(),
        String::new(),
        TurnMode::Normal,
    )
    .ok_or_else(|| AppError::new(ErrorCode::SessionNotFound, "no such session"))?;
    let account = crate::account::execution_account(app, &ctx.account_id)?;
    crate::session::runtime_bridge::resolve_execution(
        &mut ctx,
        crate::session::AgentRuntime::Codex,
        account,
        |_, home| crate::account::codex_auth_file_exists(home),
    )?;
    if let Some(home) = &ctx.execution.identity.home {
        crate::account::inherit_codex_resources(home)?;
    }
    crate::session::adapter::codex::probe_resources(&ctx, request)
}
