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

/// pi-models-metrics §5 ("all verbs revalidate session/capability/state"):
/// the CONNECTION-then-CAPABILITY gate both Pi switch verbs run, spelled once
/// here so they cannot disagree. `session_switch_model` and
/// `session_switch_effort` reach it through their shared
/// `apply_pi_model_switch` (commands/lifecycle.rs); it lives in THIS module
/// rather than there because lifecycle.rs is already three times over the
/// 1000-line cap, and this is pi-models-metrics' own command module.
///
/// MED (review): `session_switch_effort`'s Pi branch carried no capability
/// check at all while `session_switch_model`'s did — and hoisting the model
/// one above the Pi branch changed what a DISCONNECTED Pi session answers:
/// `resolve_capability` reports every Pi capability unavailable once
/// `shutdown_runtime` clears the snapshot, so "not connected" started saying
/// `RUNTIME_UNSUPPORTED` where it used to say `RUNTIME_UNAVAILABLE`.
/// Connection FIRST is the honest order — the capability exists, the
/// connection does not, and the two need different fixes from the user
/// (reconnect vs. "this build cannot do that"). Both still run before
/// anything is dispatched, which is what the hoist was for.
pub(super) fn pi_switch_gate(
    engine: &Engine,
    session_id: &str,
) -> Result<std::sync::Arc<dyn adapter::RuntimeSessionControl>, AppError> {
    let connection = engine.runtime_connection_for(session_id).ok_or_else(|| {
        AppError::new(
            ErrorCode::RuntimeUnavailable,
            "this session has no live Pi connection",
        )
    })?;
    engine
        .require_capability(session_id, "modelSwitching")
        .map_err(|(code, message)| AppError::new(code, message))?;
    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::{test_engine_with, test_session};

    /// A connection that answers nothing — `pi_switch_gate` only needs one to
    /// EXIST, and never dispatches through it.
    struct IdleConnection;
    impl adapter::RuntimeSessionControl for IdleConnection {
        fn submit(
            &self,
            _: adapter::RuntimeSubmission,
        ) -> Result<adapter::SubmissionReceipt, AppError> {
            unreachable!("the gate never dispatches")
        }
        fn capabilities(&self) -> RuntimeCapabilities {
            Default::default()
        }
        fn cancel(&self) -> Result<(), AppError> {
            Ok(())
        }
        fn shutdown(&self) -> Result<(), AppError> {
            Ok(())
        }
    }

    /// A Pi session carrying a VALID FULL capability snapshot — a partial one
    /// fails `validate_capabilities` and reads as "nothing available", which
    /// would make this test pass for the wrong reason.
    fn pi_switch_engine(model_switching: bool, connected: bool) -> Engine {
        let mut s = test_session();
        s.agent_runtime = AgentRuntime::Pi;
        s.effective_capabilities = Some(
            adapter::RUNTIME_CAPABILITIES
                .into_iter()
                .map(|k| {
                    let available = k != "modelSwitching" || model_switching;
                    let state = adapter::CapabilityState {
                        available,
                        reason: (!available).then(|| "Disabled".to_string()),
                    };
                    (k.to_string(), state)
                })
                .collect(),
        );
        let engine = test_engine_with(s);
        if connected {
            let conn = std::sync::Arc::new(IdleConnection)
                as std::sync::Arc<dyn adapter::RuntimeSessionControl>;
            engine
                .runtime_connections
                .lock()
                .unwrap()
                .insert("s1".into(), conn);
        }
        engine
    }

    /// MED (review): a disconnected Pi session must answer
    /// `RUNTIME_UNAVAILABLE`, not `RUNTIME_UNSUPPORTED` — and the capability
    /// check must still refuse a connected session that cannot switch.
    /// `Arc<dyn RuntimeSessionControl>` is not `Debug`, so `unwrap_err` is
    /// unavailable — the refusal code is all these assertions want anyway.
    fn gate_error(engine: &Engine) -> ErrorCode {
        pi_switch_gate(engine, "s1")
            .err()
            .expect("the gate must refuse")
            .code
    }

    #[test]
    fn the_pi_switch_gate_checks_the_connection_before_the_capability() {
        for switching in [true, false] {
            let code = gate_error(&pi_switch_engine(switching, false));
            assert_eq!(code, ErrorCode::RuntimeUnavailable, "{switching}");
        }
        assert_eq!(
            gate_error(&pi_switch_engine(false, true)),
            ErrorCode::RuntimeUnsupported
        );
        assert!(pi_switch_gate(&pi_switch_engine(true, true), "s1").is_ok());
    }

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
