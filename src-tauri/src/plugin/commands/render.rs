//! FR-17..FR-24 / FR-70..FR-73 — the only two commands that run plugin code.
//!
//! `invoke` is the single door into the isolate, and everything around it is
//! about what must be true BEFORE that door opens (consent, enablement, a
//! surface the manifest actually contributes) and what must happen after it
//! closes (the failure counter, the log ring, FR-71's invalidation).

use super::*;

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::ipc::{err, ok, IpcResult};

// ============================================================================
// FR-17..FR-24 / FR-72 — rendering and commands
// ============================================================================

#[derive(Deserialize)]
pub struct RenderInput {
    #[serde(rename = "pluginId")]
    plugin_id: String,
    surface: String,
    #[serde(rename = "projectId")]
    project_id: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

#[derive(serde::Serialize)]
#[cfg_attr(test, derive(Debug, PartialEq))]
#[serde(untagged)]
pub enum RenderOutput {
    Panel {
        surface: &'static str,
        spec: Option<PanelSpec>,
    },
    Status {
        surface: &'static str,
        item: Option<StatusItemSpec>,
    },
}

#[tauri::command(async)]
pub async fn plugins_render(app: AppHandle, req: RenderInput) -> IpcResult<RenderOutput> {
    // FR-81: `tab` is NOT a render surface. A contributed tab is static manifest
    // data validated at install; there is no handler to call and nothing an
    // isolate could return.
    let handler = match req.surface.as_str() {
        "panel" => isolate::Handler::Panel,
        "statusBar" => isolate::Handler::StatusBar,
        _ => return err("INVALID_INPUT", "surface must be panel or statusBar"),
    };
    let surface = match handler {
        isolate::Handler::Panel => PluginSurface::Panel,
        _ => PluginSurface::StatusBar,
    };
    // §7 #45 / FR-44: the surface must be one the manifest actually contributes.
    // "an exported handler with no matching `contributes` entry is never called"
    // has to hold in the core — the webview asking for a panel a manifest never
    // declared must not start an isolate.
    match contributes_surface(&app, &req.plugin_id, surface) {
        None => return err(E_NOT_FOUND, "no such plugin"),
        Some(false) => {
            return err(
                "INVALID_INPUT",
                "this plugin does not contribute that surface",
            )
        }
        Some(true) => {}
    }
    // FR-55: expire whatever ran out of time. The render tick is the only clock
    // this domain has — FR-70 deliberately puts the timer in the frontend so a
    // hidden window costs nothing, which means the core has no periodic wakeup
    // of its own to hang the sweep on.
    sweep_injections(&app);

    let context = serde_json::json!({
        "surface": req.surface,
        "projectId": req.project_id,
        "sessionId": req.session_id,
        "now": now_ms(),
    });

    match invoke(
        &app,
        &req.plugin_id,
        handler,
        context,
        req.project_id,
        surface,
    )
    .await
    {
        // FR-22 / §7 #24: the tick was DROPPED because an invocation was already
        // in flight. `spec: null` means "the handler returned nothing" and clears
        // the surface, which is a visible flicker for a non-event — so the last
        // validated spec is returned instead, and the pane simply does not move.
        Ok(InvokeOutcome::Dropped) => ok(cached_render(&app, &req.plugin_id, surface)),
        Ok(InvokeOutcome::Empty) => {
            store_render(&app, &req.plugin_id, surface, None, None);
            ok(match surface {
                PluginSurface::Panel => RenderOutput::Panel {
                    surface: "panel",
                    spec: None,
                },
                _ => RenderOutput::Status {
                    surface: "statusBar",
                    item: None,
                },
            })
        }
        Ok(InvokeOutcome::Value(value)) => {
            // FR-36: the core validates, then the frontend renders. The webview
            // never sees a raw plugin value.
            let validated = match surface {
                PluginSurface::Panel => {
                    panelspec::validate_panel(&value).map(|spec| RenderOutput::Panel {
                        surface: "panel",
                        spec: Some(spec),
                    })
                }
                _ => panelspec::validate_status(&value).map(|item| RenderOutput::Status {
                    surface: "statusBar",
                    item: Some(item),
                }),
            };
            match validated {
                Ok(out) => {
                    record_success(&app, &req.plugin_id, surface);
                    match &out {
                        RenderOutput::Panel { spec, .. } => {
                            store_render(&app, &req.plugin_id, surface, spec.clone(), None)
                        }
                        RenderOutput::Status { item, .. } => {
                            store_render(&app, &req.plugin_id, surface, None, item.clone())
                        }
                    }
                    ok(out)
                }
                Err(msg) => {
                    record_failure(&app, &req.plugin_id, surface, &msg);
                    err(E_RUNTIME, msg)
                }
            }
        }
        Err((code, msg)) => err(code, msg),
    }
}

/// FR-44/§7 #45: does this plugin's manifest actually declare `surface`?
/// `None` ⇒ no such plugin.
fn contributes_surface(app: &AppHandle, plugin_id: &str, surface: PluginSurface) -> Option<bool> {
    let state = app.try_state::<PluginState>()?;
    let inner = state.inner.lock().unwrap();
    let entry = find(&inner.plugins, plugin_id)?;
    Some(contributed_surfaces(&entry.manifest).contains(&surface))
}

/// FR-22: remember the last validated spec per surface, so a dropped tick can
/// answer with what is already on screen rather than blanking it.
fn remember_render(
    inner: &mut PluginInner,
    plugin_id: &str,
    surface: PluginSurface,
    spec: Option<PanelSpec>,
    item: Option<StatusItemSpec>,
) {
    match surface {
        PluginSurface::Panel => {
            inner.last_panel.insert(plugin_id.to_string(), spec);
        }
        _ => {
            inner.last_status.insert(plugin_id.to_string(), item);
        }
    }
}

/// The cached answer for a dropped tick (FR-22 / §7 #24). Nothing cached yet ⇒
/// an empty surface, which is what the pane already shows.
fn last_render(inner: &PluginInner, plugin_id: &str, surface: PluginSurface) -> RenderOutput {
    match surface {
        PluginSurface::Panel => RenderOutput::Panel {
            surface: "panel",
            spec: inner.last_panel.get(plugin_id).cloned().flatten(),
        },
        _ => RenderOutput::Status {
            surface: "statusBar",
            item: inner.last_status.get(plugin_id).cloned().flatten(),
        },
    }
}

/// The two above, with the lock taken. Split so the CACHE RULE is testable and
/// the locking is not part of it.
fn store_render(
    app: &AppHandle,
    plugin_id: &str,
    surface: PluginSurface,
    spec: Option<PanelSpec>,
    item: Option<StatusItemSpec>,
) {
    if let Some(state) = app.try_state::<PluginState>() {
        let mut inner = state.inner.lock().unwrap();
        remember_render(&mut inner, plugin_id, surface, spec, item);
    }
}

fn cached_render(app: &AppHandle, plugin_id: &str, surface: PluginSurface) -> RenderOutput {
    match app.try_state::<PluginState>() {
        Some(state) => {
            let inner = state.inner.lock().unwrap();
            last_render(&inner, plugin_id, surface)
        }
        None => last_render(&PluginInner::default(), plugin_id, surface),
    }
}

#[derive(Deserialize)]
pub struct InvokeCommandInput {
    #[serde(rename = "pluginId")]
    plugin_id: String,
    #[serde(rename = "commandId")]
    command_id: String,
    args: Option<Map<String, Value>>,
    #[serde(rename = "projectId")]
    project_id: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

#[tauri::command(async)]
pub async fn plugins_invoke_command(
    app: AppHandle,
    req: InvokeCommandInput,
) -> IpcResult<Option<()>> {
    // §7 #22: an unknown commandId is INVALID_INPUT, checked against the
    // manifest before an isolate is started.
    let declared = {
        let Some(state) = app.try_state::<PluginState>() else {
            return err("INTERNAL", "plugins are unavailable");
        };
        let inner = state.inner.lock().unwrap();
        match find(&inner.plugins, &req.plugin_id) {
            None => return err(E_NOT_FOUND, "no such plugin"),
            Some(e) => e
                .manifest
                .contributes
                .commands()
                .iter()
                .any(|c| c.id == req.command_id),
        }
    };
    if !declared {
        return err("INVALID_INPUT", "unknown command");
    }

    let context = serde_json::json!({
        "surface": "command",
        "commandId": req.command_id,
        "args": req.args.clone().unwrap_or_default(),
        "projectId": req.project_id,
        "sessionId": req.session_id,
        "now": now_ms(),
    });

    let surfaces = {
        let Some(state) = app.try_state::<PluginState>() else {
            return err("INTERNAL", "plugins are unavailable");
        };
        let inner = state.inner.lock().unwrap();
        find(&inner.plugins, &req.plugin_id)
            .map(|e| contributed_surfaces(&e.manifest))
            .unwrap_or_default()
    };

    match invoke(
        &app,
        &req.plugin_id,
        isolate::Handler::Command(req.command_id.clone()),
        context,
        req.project_id,
        PluginSurface::Command,
    )
    .await
    {
        Ok(_) => {
            record_success(&app, &req.plugin_id, PluginSurface::Command);
            // FR-71: a successful command invalidates every surface the plugin
            // contributes — it may have written storage the panel reads.
            for surface in surfaces {
                emit(
                    &app,
                    PluginEvent::Invalidated {
                        plugin_id: req.plugin_id.clone(),
                        surface,
                    },
                );
            }
            ok(None)
        }
        Err((code, msg)) => err(code, msg),
    }
}

/// What one invocation produced. `Dropped` is NOT `Empty`: the contract reads a
/// `null` spec as "the handler returned nothing, clear the surface" (FR-43),
/// while a dropped tick means nothing ran and the previous render still stands
/// (FR-22).
enum InvokeOutcome {
    Dropped,
    Empty,
    Value(Value),
}

/// The two gates every invocation passes before an isolate is started.
///
/// Pure over the entry, so the rule is testable without an app: the isolate is
/// the thing that holds `fetch`, `readState` and `session.prompt`, and deciding
/// whether to start one is not a judgement the webview may make on the core's
/// behalf (FR-16, FR-23, FR-76).
fn check_runnable(
    entry: &PluginEntry,
    project_id: Option<&str>,
) -> Result<(), (&'static str, String)> {
    // FR-16: consent-pending plugins run nothing at all.
    if entry.consent_pending {
        return Err((
            E_CONSENT_REQUIRED,
            "new permissions — review to re-enable".to_string(),
        ));
    }
    // FR-23/FR-76: `off`, or scoped to a different project, means no isolate —
    // so no panel, no status item, no command, and no host call of any kind.
    if !registry::is_active(entry, project_id) {
        return Err((E_NOT_FOUND, "this plugin is not enabled here".to_string()));
    }
    Ok(())
}

/// The one path into the isolate. Gathers everything under the lock, releases it,
/// then runs on a blocking worker (FR-22).
async fn invoke(
    app: &AppHandle,
    plugin_id: &str,
    handler: isolate::Handler,
    context: Value,
    project_id: Option<String>,
    surface: PluginSurface,
) -> Result<InvokeOutcome, (&'static str, String)> {
    let key = secret_key(app);
    let (entry_source, plugin_name, version, settings, capabilities, unreadable) = {
        let state = app
            .try_state::<PluginState>()
            .ok_or(("INTERNAL", "plugins are unavailable".to_string()))?;
        let mut inner = state.inner.lock().unwrap();
        let entry = find(&inner.plugins, plugin_id)
            .ok_or((E_NOT_FOUND, "no such plugin".to_string()))?
            .clone();

        check_runnable(&entry, project_id.as_deref())?;
        let entry_path = std::path::Path::new(&entry.install_path).join(&entry.manifest.entry);
        let source = std::fs::read_to_string(&entry_path)
            .map_err(|_| (E_RUNTIME, registry::MISSING_DIR_MSG.to_string()))?;
        let (settings, unreadable) = registry::resolve_settings(&entry, key.as_ref());
        if unreadable {
            inner.secrets_unreadable = true;
        }
        (
            source,
            entry.manifest.name.clone(),
            entry.manifest.version.clone(),
            settings,
            entry.granted_capabilities.clone(),
            unreadable,
        )
    };
    let _ = unreadable;

    let host = std::sync::Arc::new(hostapi::HostContext {
        app: app.clone(),
        plugin_id: plugin_id.to_string(),
        plugin_name,
        capabilities: capabilities.clone(),
        project_id,
        storage_path: registry::storage_path(app, plugin_id),
        storage_dirty: std::sync::atomic::AtomicBool::new(false),
    });
    let host_for_isolate: std::sync::Arc<dyn isolate::Host> = host.clone();

    let invocation = isolate::Invocation {
        plugin_id: plugin_id.to_string(),
        plugin_version: version,
        entry_source,
        handler,
        context,
        settings,
        capabilities,
    };

    let app_for_pool = app.clone();
    let id_for_pool = plugin_id.to_string();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let state = app_for_pool.state::<PluginState>();
        // FR-22 / §7 #24: a tick for a plugin that is already running is DROPPED.
        let Some(_slot) = state.pool.acquire(&id_for_pool) else {
            return None;
        };
        Some(isolate::run(&invocation, host_for_isolate))
    })
    .await
    .map_err(|_| ("INTERNAL", "the isolate could not be started".to_string()))?;

    // FR-71: a write to `francois.storage` invalidates the plugin's OTHER
    // surfaces — after the isolate has settled, never during it, and never the
    // surface that just rendered. A panel that writes on every render would
    // otherwise invalidate itself into an endless refresh.
    if host
        .storage_dirty
        .load(std::sync::atomic::Ordering::Relaxed)
        && surface != PluginSurface::Command
    {
        invalidate_other_surfaces(app, plugin_id, surface);
    }

    let Some(result) = outcome else {
        // A dropped tick is not an error and must not touch the failure counter —
        // the previous render is still on screen and still correct.
        return Ok(InvokeOutcome::Dropped);
    };

    match result {
        Ok(out) => {
            push_logs(app, plugin_id, out.logs);
            Ok(if out.value.is_null() {
                InvokeOutcome::Empty
            } else {
                InvokeOutcome::Value(out.value)
            })
        }
        Err(msg) => {
            record_failure(app, plugin_id, surface, &msg);
            Err((E_RUNTIME, msg))
        }
    }
}

/// FR-71: invalidate every contributed surface EXCEPT the one that just ran.
/// (A command invocation already invalidates all of them on success.)
fn invalidate_other_surfaces(app: &AppHandle, plugin_id: &str, just_rendered: PluginSurface) {
    let surfaces = {
        let Some(state) = app.try_state::<PluginState>() else {
            return;
        };
        let inner = state.inner.lock().unwrap();
        find(&inner.plugins, plugin_id)
            .map(|e| contributed_surfaces(&e.manifest))
            .unwrap_or_default()
    };
    for surface in surfaces {
        if surface == just_rendered || surface == PluginSurface::Command {
            continue;
        }
        emit(
            app,
            PluginEvent::Invalidated {
                plugin_id: plugin_id.to_string(),
                surface,
            },
        );
    }
}

/// FR-26: append to the per-plugin ring, oldest out first.
fn push_logs(app: &AppHandle, plugin_id: &str, lines: VecDeque<String>) {
    if lines.is_empty() {
        return;
    }
    let Some(state) = app.try_state::<PluginState>() else {
        return;
    };
    let mut inner = state.inner.lock().unwrap();
    let ring = inner.logs.entry(plugin_id.to_string()).or_default();
    for line in lines {
        if ring.len() >= LOG_RING_MAX_LINES {
            ring.pop_front();
        }
        ring.push_back(line);
    }
}

/// FR-73: a success resets the counter — five consecutive failures is about a
/// plugin that is persistently broken, not one that hiccuped an hour ago.
fn record_success(app: &AppHandle, plugin_id: &str, surface: PluginSurface) {
    let Some(state) = app.try_state::<PluginState>() else {
        return;
    };
    let mut inner = state.inner.lock().unwrap();
    inner.failures.remove(&(plugin_id.to_string(), surface));
    if let Some(e) = inner
        .plugins
        .iter_mut()
        .find(|e| e.manifest.id == plugin_id)
    {
        e.last_error = None;
    }
}

fn record_failure(app: &AppHandle, plugin_id: &str, surface: PluginSurface, message: &str) {
    let Some(state) = app.try_state::<PluginState>() else {
        return;
    };
    let error = PluginRuntimeError {
        at: now_ms(),
        surface,
        message: clean_text(message, 400, false),
    };
    let consecutive = {
        let mut inner = state.inner.lock().unwrap();
        let counter = inner
            .failures
            .entry((plugin_id.to_string(), surface))
            .or_insert(0);
        *counter += 1;
        let consecutive = *counter;
        if let Some(e) = inner
            .plugins
            .iter_mut()
            .find(|e| e.manifest.id == plugin_id)
        {
            e.last_error = Some(error.clone());
        }
        consecutive
    };
    emit(
        app,
        PluginEvent::Error {
            plugin_id: plugin_id.to_string(),
            error,
            consecutive,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::*;

    // ---------- FR-16/FR-23/FR-76: the gate in front of every isolate ----------

    fn entry_scoped(enablement: PluginEnablement) -> PluginEntry {
        let mut e = entry_fixture("acme-ci", "/tmp/plugins/acme-ci");
        e.enablement = enablement;
        e
    }

    #[test]
    fn a_disabled_plugin_never_reaches_the_isolate() {
        // FR-23: the webview is not the gate. `plugins_render` and
        // `plugins_invoke_command` are callable by anything inside the webview,
        // and starting an isolate hands the plugin fetch, readState and
        // session.prompt — so the core decides.
        let off = entry_scoped(PluginEnablement::Off);
        assert_eq!(
            check_runnable(&off, None).unwrap_err().0,
            E_NOT_FOUND,
            "an `off` plugin renders nothing"
        );
        assert_eq!(check_runnable(&off, Some("p1")).unwrap_err().0, E_NOT_FOUND);

        assert!(check_runnable(&entry_scoped(PluginEnablement::All), None).is_ok());
        assert!(check_runnable(&entry_scoped(PluginEnablement::All), Some("p1")).is_ok());
    }

    #[test]
    fn a_project_scoped_plugin_only_runs_inside_its_scope() {
        // FR-76: switching the sidebar filter must actually stop the isolate,
        // not merely hide the pane.
        let scoped = entry_scoped(PluginEnablement::Projects {
            project_ids: vec!["p1".into()],
        });
        assert!(check_runnable(&scoped, Some("p1")).is_ok());
        assert_eq!(
            check_runnable(&scoped, Some("p2")).unwrap_err().0,
            E_NOT_FOUND
        );
        // *All projects* is the union view: enabled somewhere ⇒ visible here.
        assert!(check_runnable(&scoped, None).is_ok());

        let empty = entry_scoped(PluginEnablement::Projects {
            project_ids: vec![],
        });
        assert_eq!(check_runnable(&empty, None).unwrap_err().0, E_NOT_FOUND);
    }

    #[test]
    fn a_consent_pending_plugin_is_inert_however_it_is_enabled() {
        // FR-16: the on-disk manifest wants more than was granted, so nothing
        // runs until the human has looked at it.
        let mut e = entry_scoped(PluginEnablement::All);
        e.consent_pending = true;
        assert_eq!(
            check_runnable(&e, None).unwrap_err().0,
            E_CONSENT_REQUIRED,
            "consent outranks enablement, and says so"
        );
    }

    // ---------- FR-22/§7 #24: a dropped tick ----------

    #[test]
    fn a_dropped_tick_answers_with_the_last_render_not_an_empty_one() {
        // The contract reads `spec: null` as "the handler returned nothing —
        // clear the surface" (FR-43). A tick dropped because the previous
        // invocation is still running means nothing ran at all, and FR-22 wants
        // "no error, no log line" — so the pane must not blink empty.
        let mut inner = PluginInner::default();
        let spec = PanelSpec {
            version: 1,
            title: Some("CI".into()),
            nodes: vec![PanelNode::Divider],
        };
        let item = StatusItemSpec {
            version: 1,
            text: "3 failing".into(),
            tone: None,
            badge: None,
            command_id: None,
        };

        // nothing cached yet: an empty surface, which is what is on screen
        assert_eq!(
            last_render(&inner, "acme-ci", PluginSurface::Panel),
            RenderOutput::Panel {
                surface: "panel",
                spec: None
            }
        );

        remember_render(
            &mut inner,
            "acme-ci",
            PluginSurface::Panel,
            Some(spec.clone()),
            None,
        );
        remember_render(
            &mut inner,
            "acme-ci",
            PluginSurface::StatusBar,
            None,
            Some(item.clone()),
        );

        assert_eq!(
            last_render(&inner, "acme-ci", PluginSurface::Panel),
            RenderOutput::Panel {
                surface: "panel",
                spec: Some(spec)
            }
        );
        assert_eq!(
            last_render(&inner, "acme-ci", PluginSurface::StatusBar),
            RenderOutput::Status {
                surface: "statusBar",
                item: Some(item)
            }
        );
        // another plugin's cache is not this one's
        assert_eq!(
            last_render(&inner, "other", PluginSurface::Panel),
            RenderOutput::Panel {
                surface: "panel",
                spec: None
            }
        );

        // a handler that really returns nothing DOES clear the cache, so the
        // next dropped tick does not resurrect a stale panel.
        remember_render(&mut inner, "acme-ci", PluginSurface::Panel, None, None);
        assert_eq!(
            last_render(&inner, "acme-ci", PluginSurface::Panel),
            RenderOutput::Panel {
                surface: "panel",
                spec: None
            }
        );
    }
}
