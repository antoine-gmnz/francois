//! §5.4 — list, status, logs, settings, enablement, and the injection decision.
//!
//! The commands that read or write the REGISTRY, never plugin code. None of
//! them starts an isolate, which is why they can afford to be synchronous
//! inside the lock: every decision here is a map lookup or a validation pass.

use super::*;

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::ipc::{err, ok, IpcResult};

// ============================================================================
// list / settings / enablement
// ============================================================================

#[tauri::command(async)]
pub fn plugins_list(
    app: AppHandle,
    state: State<'_, PluginState>,
) -> IpcResult<Vec<InstalledPlugin>> {
    let key = secret_key(&app);
    let mut inner = state.inner.lock().unwrap();
    // FR-66/§7 #42: listing is where the modal is about to show the secret
    // fields, so it is the honest moment to notice that the key cannot open
    // them — waiting for an invocation would mean the user reads `••••••` for a
    // value nothing can decrypt.
    note_unreadable_secrets(&mut inner, key.as_ref());
    ok(registry::snapshot(&inner.plugins))
}

/// FR-79 (§7 #40) + FR-66 (§7 #42) — the two startup conditions the user has to
/// be told about, neither of which belongs on a per-plugin row.
#[derive(serde::Serialize, PartialEq, Debug)]
pub struct PluginStatus {
    /// An unparseable plugins.json was backed up to `.bak` and reset ONCE.
    #[serde(rename = "registryWasReset")]
    registry_was_reset: bool,
    /// A stored `enc:v1:` value could not be opened (missing/rotated key).
    #[serde(rename = "secretsUnreadable")]
    secrets_unreadable: bool,
}

/// Read the two flags and CLEAR the reset one: it reports a thing that happened
/// once, at startup, and re-announcing it on every poll would train the user to
/// dismiss it. `secretsUnreadable` is a standing condition and stays set.
fn take_status(inner: &mut PluginInner) -> PluginStatus {
    let out = PluginStatus {
        registry_was_reset: inner.registry_reset,
        secrets_unreadable: inner.secrets_unreadable,
    };
    inner.registry_reset = false;
    out
}

/// Set `secrets_unreadable` when any stored secret fails to open under the
/// current key. Cheap: a handful of entries, each with a handful of settings.
fn note_unreadable_secrets(inner: &mut PluginInner, key: Option<&[u8; 32]>) {
    let unreadable = inner
        .plugins
        .iter()
        .any(|e| registry::resolve_settings(e, key).1);
    if unreadable {
        inner.secrets_unreadable = true;
    }
}

#[tauri::command(async)]
pub fn plugins_status(state: State<'_, PluginState>) -> IpcResult<PluginStatus> {
    let mut inner = state.inner.lock().unwrap();
    ok(take_status(&mut inner))
}

/// FR-26 / §5.4 `francois:plugins:logs`: the per-plugin log ring, oldest first,
/// for the modal's LOG group. Takes the same `{ pluginId }` request object every
/// other command in the domain takes.
#[tauri::command(async)]
pub fn plugins_logs(state: State<'_, PluginState>, req: PluginIdInput) -> IpcResult<Vec<String>> {
    let inner = state.inner.lock().unwrap();
    // A plugin that exists but has logged nothing returns an empty list; one that
    // does not exist is an error, so the modal can tell "quiet" from "gone".
    if find(&inner.plugins, &req.plugin_id).is_none() {
        return err(E_NOT_FOUND, "no such plugin");
    }
    ok(inner
        .logs
        .get(&req.plugin_id)
        .map(|ring| ring.iter().cloned().collect())
        .unwrap_or_default())
}

#[derive(Deserialize)]
pub struct SetEnablementInput {
    #[serde(rename = "pluginId")]
    plugin_id: String,
    enablement: PluginEnablement,
}

#[tauri::command(async)]
pub fn plugins_set_enablement(
    app: AppHandle,
    state: State<'_, PluginState>,
    req: SetEnablementInput,
) -> IpcResult<InstalledPlugin> {
    // FR-77: unknown project ids are DROPPED, not rejected — the sidebar and the
    // registry can disagree for an instant, and refusing would surface a race to
    // the user as an error they cannot act on.
    let known = crate::project::known_ids(&app);
    let enablement = match req.enablement {
        PluginEnablement::Projects { project_ids } => PluginEnablement::Projects {
            project_ids: project_ids
                .into_iter()
                .filter(|id| known.contains(id))
                .collect(),
        },
        other => other,
    };
    let turning_off = enablement == PluginEnablement::Off;

    let (view, expired) = {
        let mut inner = state.inner.lock().unwrap();
        let snapshot = inner.plugins.clone();
        let Some(entry) = inner
            .plugins
            .iter_mut()
            .find(|e| e.manifest.id == req.plugin_id)
        else {
            return err(E_NOT_FOUND, "no such plugin");
        };
        // FR-16: a consent-pending plugin may only be set to `off`.
        if entry.consent_pending && !turning_off {
            return err(
                E_CONSENT_REQUIRED,
                "review this plugin's new permissions before enabling it",
            );
        }
        entry.enablement = enablement;
        if let Err((code, msg)) = registry::persist_or_rollback(&app, &mut inner.plugins, snapshot)
        {
            return err(code, msg);
        }
        // FR-55/§7 #34: disabling expires every pending injection it holds.
        let expired = if turning_off {
            injection::expire(&mut inner, now_ms(), Some(&req.plugin_id), None)
        } else {
            Vec::new()
        };
        let view = find(&inner.plugins, &req.plugin_id).map(registry::to_view);
        broadcast(&app, &inner.plugins);
        (view, expired)
    };
    resolve_expired(&app, expired);
    match view {
        Some(v) => ok(v),
        None => err(E_NOT_FOUND, "no such plugin"),
    }
}

pub(super) fn resolve_expired(app: &AppHandle, expired: Vec<(String, String)>) {
    for (session_id, block_id) in expired {
        crate::session::buffer_plugin_injection(
            app,
            &session_id,
            &block_id,
            &Value::Null,
            "expired",
        );
        crate::session::emit_injection_resolved(app, &session_id, &block_id, "expired");
    }
}

#[derive(Deserialize)]
pub struct PluginIdInput {
    #[serde(rename = "pluginId")]
    pub(super) plugin_id: String,
}

#[tauri::command(async)]
pub fn plugins_get_settings(
    app: AppHandle,
    state: State<'_, PluginState>,
    req: PluginIdInput,
) -> IpcResult<Map<String, Value>> {
    let key = secret_key(&app);
    let mut inner = state.inner.lock().unwrap();
    note_unreadable_secrets(&mut inner, key.as_ref()); // FR-66/§7 #42
    match find(&inner.plugins, &req.plugin_id) {
        Some(e) => ok(registry::settings_view(e)),
        None => err(E_NOT_FOUND, "no such plugin"),
    }
}

#[derive(Deserialize)]
pub struct SetSettingsInput {
    #[serde(rename = "pluginId")]
    plugin_id: String,
    settings: Map<String, Value>,
}

#[tauri::command(async)]
pub fn plugins_set_settings(
    app: AppHandle,
    state: State<'_, PluginState>,
    req: SetSettingsInput,
) -> IpcResult<InstalledPlugin> {
    let key = secret_key(&app);
    let (view, surfaces) = {
        let mut inner = state.inner.lock().unwrap();
        let snapshot = inner.plugins.clone();
        let Some(entry) = inner
            .plugins
            .iter_mut()
            .find(|e| e.manifest.id == req.plugin_id)
        else {
            return err(E_NOT_FOUND, "no such plugin");
        };
        // FR-63: validated wholesale first — nothing is written unless all of it
        // is valid.
        let next = match registry::validate_settings_patch(entry, &req.settings, key.as_ref()) {
            Ok(next) => next,
            Err(msg) => return err("INVALID_INPUT", msg),
        };
        entry.settings = next;
        let surfaces = contributed_surfaces(&entry.manifest);
        if let Err((code, msg)) = registry::persist_or_rollback(&app, &mut inner.plugins, snapshot)
        {
            return err(code, msg);
        }
        // FR-68: a settings change resets the failure counter — the user has
        // plausibly just fixed the reason it was failing.
        for surface in &surfaces {
            inner.failures.remove(&(req.plugin_id.clone(), *surface));
        }
        let view = find(&inner.plugins, &req.plugin_id).map(registry::to_view);
        broadcast(&app, &inner.plugins);
        (view, surfaces)
    };
    for surface in surfaces {
        emit(
            &app,
            PluginEvent::Invalidated {
                plugin_id: req.plugin_id.clone(),
                surface,
            },
        );
    }
    match view {
        Some(v) => ok(v),
        None => err(E_NOT_FOUND, "no such plugin"),
    }
}

pub(super) fn contributed_surfaces(m: &PluginManifest) -> Vec<PluginSurface> {
    let mut out = Vec::new();
    if m.contributes.panel.is_some() {
        out.push(PluginSurface::Panel);
    }
    if m.contributes.status_bar.is_some() {
        out.push(PluginSurface::StatusBar);
    }
    if !m.contributes.commands().is_empty() {
        out.push(PluginSurface::Command);
    }
    out
}

// ============================================================================
// FR-57 — the injection decision
// ============================================================================

#[derive(Deserialize)]
pub struct ResolveInjectionInput {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "blockId")]
    block_id: String,
    decision: String,
}

#[derive(serde::Serialize)]
pub struct ResolveInjectionOutput {
    queued: bool,
    #[serde(rename = "queuePosition", skip_serializing_if = "Option::is_none")]
    queue_position: Option<u32>,
}

#[tauri::command(async)]
pub fn plugins_resolve_injection(
    app: AppHandle,
    req: ResolveInjectionInput,
) -> IpcResult<ResolveInjectionOutput> {
    let approve = match req.decision.as_str() {
        "approve" => true,
        "deny" => false,
        _ => return err("INVALID_INPUT", "decision must be approve or deny"),
    };
    match injection::resolve(&app, &req.session_id, &req.block_id, approve) {
        Ok((queued, position)) => ok(ResolveInjectionOutput {
            queued,
            queue_position: position,
        }),
        Err((code, msg)) => err(code, msg),
    }
}

/// FR-55: sweep expired requests. Called from the render tick, which is the only
/// clock this domain has — there is no background timer in the core (FR-70 puts
/// the tick in the frontend so a hidden window costs nothing).
pub fn sweep_injections(app: &AppHandle) {
    let Some(state) = app.try_state::<PluginState>() else {
        return;
    };
    let expired = {
        let mut inner = state.inner.lock().unwrap();
        injection::expire(&mut inner, now_ms(), None, None)
    };
    resolve_expired(app, expired);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::*;

    #[test]
    fn contributed_surfaces_follow_the_manifest() {
        // FR-68/FR-71 invalidate exactly what a plugin actually contributes.
        let mut m = manifest_fixture("acme-ci");
        assert_eq!(
            contributed_surfaces(&m),
            vec![PluginSurface::Panel, PluginSurface::Command]
        );

        m.contributes.status_bar = Some(Map::new());
        assert_eq!(
            contributed_surfaces(&m),
            vec![
                PluginSurface::Panel,
                PluginSurface::StatusBar,
                PluginSurface::Command
            ]
        );

        m.contributes.panel = None;
        m.contributes.commands = None;
        assert_eq!(contributed_surfaces(&m), vec![PluginSurface::StatusBar]);

        m.contributes = PluginContributes::default();
        assert!(contributed_surfaces(&m).is_empty());
    }

    #[test]
    fn a_contributed_tab_is_not_a_render_surface() {
        // FR-81: the tab never renders, so it can never be invalidated and never
        // starts an isolate. `contributes.tab` must not add a surface here.
        let m = manifest_with_tab("acme-ci", "https://dash.acme.dev/", "dash.acme.dev");
        assert_eq!(
            contributed_surfaces(&m),
            vec![PluginSurface::Panel, PluginSurface::Command]
        );
    }

    // ---------- FR-79/FR-66: the two startup conditions ----------

    #[test]
    fn the_registry_reset_notice_is_surfaced_once_and_then_cleared() {
        // §7 #40: it reports something that happened once, at startup. Repeating
        // it on every poll trains the user to dismiss it.
        let mut inner = PluginInner::default();
        inner.registry_reset = true;
        inner.secrets_unreadable = true;

        let first = take_status(&mut inner);
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::json!({ "registryWasReset": true, "secretsUnreadable": true })
        );
        let second = take_status(&mut inner);
        assert!(!second.registry_was_reset, "surfaced once");
        assert!(
            second.secrets_unreadable,
            "§7 #42 is a STANDING condition — the key is still unreadable"
        );
    }
}
