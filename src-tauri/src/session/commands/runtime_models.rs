//! session/commands/runtime_models.rs — pi-models-metrics §5:
//! `francois:runtime:models` (command `runtime_models`) and
//! `francois:session:metrics` (command `session_metrics`). Thin Tauri
//! wrappers: catalogue discovery/caching/the no-session probe live in
//! `adapter::pi::models`; the live per-session read goes through
//! `RuntimeSessionControl::read_metrics` on the session's own connection.

use crate::ipc::{err, ok, ErrorCode, IpcResult};
use crate::session::*;
use tauri::{AppHandle, State};

/// Wire shape for `francois:runtime:models` — `RuntimeModelCatalog`
/// (contract/pi-models-metrics.ts).
#[derive(serde::Serialize, Clone)]
pub struct RuntimeModelCatalogOut {
    #[serde(rename = "accountId")]
    account_id: String,
    models: Vec<events::RuntimeModelDescriptor>,
    #[serde(rename = "checkedAt")]
    checked_at: u64,
    stale: bool,
}

/// FR-1/FR-2: the account's AVAILABLE snapshot — cached 60 s;
/// `refresh: true` forces a fresh no-session probe. `accountId` must resolve
/// to a Pi account.
#[tauri::command(async)]
pub fn runtime_models(
    app: AppHandle,
    account_id: String,
    refresh: Option<bool>,
) -> IpcResult<RuntimeModelCatalogOut> {
    if crate::account::kind_of(&app, &account_id) != crate::account::AccountKind::Pi {
        return err(
            ErrorCode::RuntimeUnsupported,
            "this account is not a Pi account",
        );
    }
    match adapter::pi::runtime_models(&app, &account_id, refresh.unwrap_or(false)) {
        Ok((models, checked_at, stale)) => ok(RuntimeModelCatalogOut {
            account_id,
            models,
            checked_at,
            stale,
        }),
        Err(error) => crate::ipc::IpcResult::Err { ok: false, error },
    }
}

/// FR-7: an all-unknown, `stale: true` reading for a Pi session that has
/// never reported usage — never zero, never omitted (the command always
/// resolves SOMETHING for a valid Pi session).
fn unmeasured_metrics(now: u64) -> events::RuntimeMetrics {
    events::RuntimeMetrics {
        input_tokens: None,
        output_tokens: None,
        cache_read_tokens: None,
        cache_write_tokens: None,
        context_tokens: None,
        context_window: None,
        context_basis: "unknown".into(),
        cost_usd: None,
        cost_basis: "unknown".into(),
        measured_at: now,
        stale: true,
    }
}

/// FR-7: without `refresh`, the STORED value (stale after a restart until an
/// explicit or automatic refresh lands). With `refresh`, rate-limited to at
/// most once per second — a repeat within that window still answers the
/// stored value rather than re-dispatching — otherwise reads the session's
/// own live connection, persists, and publishes both `session.meta` and the
/// `metrics` runtime event.
#[tauri::command(async)]
pub fn session_metrics(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    refresh: Option<bool>,
) -> IpcResult<events::RuntimeMetrics> {
    match engine.with_session(&session_id, |s| s.agent_runtime) {
        None => return err(ErrorCode::SessionNotFound, "no such session"),
        Some(AgentRuntime::Pi) => {}
        Some(_) => {
            return err(
                ErrorCode::RuntimeUnsupported,
                "this session's runtime does not report metrics",
            )
        }
    }
    let now = now_ms();
    if !refresh.unwrap_or(false) {
        let stored = engine
            .with_session(&session_id, |s| s.metrics.clone())
            .flatten();
        return ok(stored.unwrap_or_else(|| unmeasured_metrics(now)));
    }
    let recent = engine
        .with_session(&session_id, |s| s.metrics.clone())
        .flatten()
        .filter(|m| now.saturating_sub(m.measured_at) < 1_000);
    if let Some(metrics) = recent {
        return ok(metrics);
    }
    let Some(connection) = engine.runtime_connection_for(&session_id) else {
        return err(
            ErrorCode::RuntimeExited,
            "this session has no live Pi connection",
        );
    };
    let metrics = match connection.read_metrics() {
        Ok(m) => m,
        Err(error) => return crate::ipc::IpcResult::Err { ok: false, error },
    };
    let meta = engine.with_session_mut(&session_id, |s| {
        s.metrics = Some(metrics.clone());
        s.meta(&app)
    });
    if let Some(meta) = meta {
        persist(&app, &engine);
        emit(&app, SessionEvent::Meta { meta });
    }
    if let Ok((batch, _block)) = engine.runtime_event_for_session(
        &app,
        &session_id,
        now,
        None,
        None,
        events::RuntimeEventPayload::Metrics {
            metrics: metrics.clone(),
        },
    ) {
        for ev in batch {
            emit(&app, ev);
        }
    }
    ok(metrics)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unmeasured_metrics_is_every_counter_unknown_and_stale() {
        let m = unmeasured_metrics(1_000);
        assert_eq!(m.input_tokens, None);
        assert_eq!(m.context_tokens, None);
        assert_eq!(m.context_basis, "unknown");
        assert_eq!(m.cost_usd, None);
        assert_eq!(m.cost_basis, "unknown");
        assert_eq!(m.measured_at, 1_000);
        assert!(m.stale);
    }
}
