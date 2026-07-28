//! §5.4 — the `francois:plugins:*` commands.
//!
//! Every one is `#[command(async)]`: a SYNC Tauri command runs on the main
//! thread, and this domain clones repositories, downloads tarballs and runs
//! QuickJS. One sync command here would freeze the whole window (the same
//! reasoning `diff/commands.rs` records for git).
//!
//! The isolate goes further and runs on `spawn_blocking`, because "async" only
//! means "not the main thread" — parking a runtime worker for ten seconds on a
//! plugin's wall-clock deadline would starve every other command.
//!
//! Shape throughout: take the lock, decide, DROP the lock, then do the slow or
//! fallible thing. `PluginInner` is a leaf lock (§6) and no isolate, clone or
//! HTTP call ever runs while it is held.

use super::*;

use serde::Deserialize;
use std::collections::HashSet;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::ipc::{err, ok, IpcResult};

// ---------- shared helpers ----------

/// FR-80: every registry mutation broadcasts the whole snapshot, so the modal,
/// the panes, the status bar and the palette converge on one source of truth
/// rather than each patching its own copy.
fn broadcast(app: &AppHandle, entries: &[PluginEntry]) {
    emit(
        app,
        PluginEvent::Registry {
            plugins: registry::snapshot(entries),
        },
    );
}

/// The obfuscation key, or `None` when it cannot be read. `None` is not fatal:
/// secrets read as unset and the modal says so (§7 #42).
fn secret_key(app: &AppHandle) -> Option<[u8; 32]> {
    let path = secrets::secret_key_path(app)?;
    secrets::load_or_create_key(&path).ok()
}

fn find<'a>(entries: &'a [PluginEntry], id: &str) -> Option<&'a PluginEntry> {
    entries.iter().find(|e| e.manifest.id == id)
}

// ============================================================================
// FR-69 — startup
// ============================================================================

/// Load the registry once, at startup. Never executes plugin code (FR-69).
///
/// Runs AFTER `project::load_projects` so FR-77's prune has a real id set to
/// compare against — before it, every `projectIds` entry would look unresolvable
/// and every project-scoped plugin would silently turn itself off.
pub fn load_plugins(app: &AppHandle) {
    let Some(path) = registry::plugins_json_path(app) else {
        return;
    };
    let (mut entries, was_reset) = registry::load_registry(&path);

    let known = crate::project::known_ids(app);
    if registry::prune_project_ids(&mut entries, &known) {
        let _ = registry::save_to(&path, &entries);
    }

    // FR-5: staging is not persisted, so anything on disk is debris.
    if let Some(dir) = registry::staging_dir(app) {
        install::sweep_staging(&dir, &HashSet::new());
    }

    if let Some(state) = app.try_state::<PluginState>() {
        let mut inner = state.inner.lock().unwrap();
        inner.plugins = entries;
        inner.registry_reset = was_reset;
    }
}

/// FR-78: a removed project drops out of every plugin's `projectIds`.
pub fn on_project_removed(app: &AppHandle, project_id: &str) {
    let Some(state) = app.try_state::<PluginState>() else {
        return;
    };
    let changed = {
        let mut inner = state.inner.lock().unwrap();
        let known: HashSet<String> = inner
            .plugins
            .iter()
            .flat_map(|e| match &e.enablement {
                PluginEnablement::Projects { project_ids } => project_ids.clone(),
                _ => Vec::new(),
            })
            .filter(|id| id != project_id)
            .collect();
        let snapshot = inner.plugins.clone();
        if registry::prune_project_ids(&mut inner.plugins, &known) {
            registry::persist_or_rollback(app, &mut inner.plugins, snapshot).is_ok()
        } else {
            false
        }
    };
    if changed {
        let inner = state.inner.lock().unwrap();
        broadcast(app, &inner.plugins);
    }
}

// ============================================================================
// list / settings / enablement
// ============================================================================

#[tauri::command(async)]
pub fn plugins_list(state: State<'_, PluginState>) -> IpcResult<Vec<InstalledPlugin>> {
    let inner = state.inner.lock().unwrap();
    ok(registry::snapshot(&inner.plugins))
}

/// FR-26: the per-plugin log ring, for the modal's log view.
#[tauri::command(async)]
pub fn plugins_logs(state: State<'_, PluginState>, plugin_id: String) -> IpcResult<Vec<String>> {
    let inner = state.inner.lock().unwrap();
    ok(inner
        .logs
        .get(&plugin_id)
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

fn resolve_expired(app: &AppHandle, expired: Vec<(String, String)>) {
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
    plugin_id: String,
}

#[tauri::command(async)]
pub fn plugins_get_settings(
    state: State<'_, PluginState>,
    req: PluginIdInput,
) -> IpcResult<Map<String, Value>> {
    let inner = state.inner.lock().unwrap();
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

fn contributed_surfaces(m: &PluginManifest) -> Vec<PluginSurface> {
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
// FR-1..FR-15 — resolve / install / update / uninstall
// ============================================================================

#[derive(Deserialize)]
pub struct ResolveInput {
    spec: String,
    kind: Option<PluginSourceKind>,
}

#[derive(serde::Serialize)]
pub struct InstallPreview {
    #[serde(rename = "stagingId")]
    staging_id: String,
    manifest: PluginManifest,
    source: PluginSource,
    #[serde(rename = "resolvedRef")]
    resolved_ref: String,
    #[serde(rename = "unpackedBytes")]
    unpacked_bytes: u64,
}

#[tauri::command(async)]
pub fn plugins_resolve(app: AppHandle, req: ResolveInput) -> IpcResult<InstallPreview> {
    match resolve_into_staging(&app, &req.spec, req.kind, None) {
        Ok(preview) => ok(preview),
        Err((code, msg)) => err(code, msg),
    }
}

/// The shared resolve used by both install and update. `updating` carries the
/// plugin id when this is an update, which changes exactly one thing: the
/// already-installed check (FR-2) must not fire against the plugin being updated.
fn resolve_into_staging(
    app: &AppHandle,
    spec: &str,
    kind: Option<PluginSourceKind>,
    updating: Option<&str>,
) -> Result<InstallPreview, (&'static str, String)> {
    let parsed = install::parse_source(spec, kind).map_err(|m| ("INVALID_INPUT", m))?;
    let staging_id = uuid();

    let root = registry::staging_dir(app).ok_or((
        "INTERNAL",
        "could not resolve the app data directory".to_string(),
    ))?;
    let dir = root.join(&staging_id);
    let _ = std::fs::remove_dir_all(&dir);

    emit(
        app,
        PluginEvent::InstallProgress {
            staging_id: staging_id.clone(),
            phase: PluginInstallPhase::Resolving,
            message: None,
        },
    );

    let outcome = fetch_into(app, &parsed, &dir, &staging_id);
    let (source, resolved_ref, bytes) = match outcome {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            emit(
                app,
                PluginEvent::InstallProgress {
                    staging_id,
                    phase: PluginInstallPhase::Failed,
                    message: Some(e.1.clone()),
                },
            );
            return Err(e);
        }
    };

    // FR-8: drop anything that would make this look like a Claude Code plugin,
    // BEFORE the manifest is read, so nothing downstream can act on it.
    install::strip_claude_dirs(&dir);

    let manifest = match install::read_staged_manifest(&dir) {
        Ok(m) => m,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    };

    // §7 #8: the collision is reported at RESOLVE time, so the consent card is
    // never shown for an install that cannot succeed.
    if let Some(state) = app.try_state::<PluginState>() {
        let inner = state.inner.lock().unwrap();
        let collides = inner
            .plugins
            .iter()
            .any(|e| e.manifest.id == manifest.id && Some(e.manifest.id.as_str()) != updating);
        if collides {
            drop(inner);
            let _ = std::fs::remove_dir_all(&dir);
            return Err((
                E_ALREADY_INSTALLED,
                format!(
                    "\"{}\" is already installed — uninstall it first",
                    clean_text(&manifest.id, 64, false)
                ),
            ));
        }
    }
    // An update must land on the SAME id, or it is not an update.
    if let Some(id) = updating {
        if manifest.id != id {
            let _ = std::fs::remove_dir_all(&dir);
            return Err((
                E_MANIFEST_INVALID,
                "the update declares a different plugin id".to_string(),
            ));
        }
    }

    emit(
        app,
        PluginEvent::InstallProgress {
            staging_id: staging_id.clone(),
            phase: PluginInstallPhase::Done,
            message: None,
        },
    );

    if let Some(state) = app.try_state::<PluginState>() {
        state.inner.lock().unwrap().staging.insert(
            staging_id.clone(),
            StagedTree {
                dir,
                manifest: manifest.clone(),
                source: source.clone(),
                resolved_ref: resolved_ref.clone(),
                unpacked_bytes: bytes,
                created_at: now_ms(),
                updating: updating.map(String::from),
            },
        );
    }

    // Read the size back out of the staged record rather than from the local,
    // so the number on the consent card and the number in memory cannot drift.
    let unpacked_bytes = app
        .try_state::<PluginState>()
        .and_then(|state| {
            let inner = state.inner.lock().unwrap();
            inner.staging.get(&staging_id).map(|s| s.unpacked_bytes)
        })
        .unwrap_or(bytes);

    Ok(InstallPreview {
        staging_id,
        manifest,
        source,
        resolved_ref,
        unpacked_bytes,
    })
}

fn fetch_into(
    app: &AppHandle,
    parsed: &install::ParsedSource,
    dir: &std::path::Path,
    staging_id: &str,
) -> Result<(PluginSource, String, u64), (&'static str, String)> {
    let progress = |phase: PluginInstallPhase| {
        emit(
            app,
            PluginEvent::InstallProgress {
                staging_id: staging_id.to_string(),
                phase,
                message: None,
            },
        );
    };
    match parsed {
        install::ParsedSource::Github {
            owner,
            repo,
            git_ref,
        } => {
            progress(PluginInstallPhase::Downloading);
            let sha = install::clone_github(owner, repo, git_ref.as_deref(), dir)?;
            progress(PluginInstallPhase::Verifying);
            // FR-6: a clone gets the same limits a tarball does.
            let tally = install::scan_tree(dir).map_err(|m| (E_MANIFEST_INVALID, m))?;
            let spec = match git_ref {
                Some(r) => format!("{owner}/{repo}@{r}"),
                None => format!("{owner}/{repo}"),
            };
            Ok((
                PluginSource {
                    kind: PluginSourceKind::Github,
                    spec,
                },
                sha,
                tally.bytes,
            ))
        }
        install::ParsedSource::Npm { name, version } => {
            progress(PluginInstallPhase::Resolving);
            let (resolved, tarball, integrity, shasum) =
                install::resolve_npm(name, version.as_deref())?;
            progress(PluginInstallPhase::Downloading);
            let bytes = install::download_tarball(&tarball)?;
            progress(PluginInstallPhase::Verifying);
            install::verify_integrity(&bytes, integrity.as_deref(), shasum.as_deref())
                .map_err(|m| (E_SOURCE_UNREACHABLE, m))?;
            progress(PluginInstallPhase::Unpacking);
            let tally = install::unpack_tar_gz(bytes.as_slice(), dir, true)
                .map_err(|m| (E_MANIFEST_INVALID, m))?;
            let spec = match version {
                Some(v) => format!("{name}@{v}"),
                None => name.clone(),
            };
            Ok((
                PluginSource {
                    kind: PluginSourceKind::Npm,
                    spec,
                },
                resolved,
                tally.bytes,
            ))
        }
    }
}

#[derive(Deserialize)]
pub struct InstallInput {
    #[serde(rename = "stagingId")]
    staging_id: String,
}

#[tauri::command(async)]
pub fn plugins_install(
    app: AppHandle,
    state: State<'_, PluginState>,
    req: InstallInput,
) -> IpcResult<InstalledPlugin> {
    // FR-5: take the staging OUT of the map, so a double-install cannot commit
    // the same tree twice.
    let staged = {
        let mut inner = state.inner.lock().unwrap();
        match inner.staging.remove(&req.staging_id) {
            Some(s) if now_ms().saturating_sub(s.created_at) <= STAGING_TTL_MS => s,
            Some(s) => {
                let _ = std::fs::remove_dir_all(&s.dir);
                return err("INVALID_INPUT", "this install expired — resolve it again");
            }
            None => return err("INVALID_INPUT", "this install expired — resolve it again"),
        }
    };

    let Some(plugins_root) = registry::plugins_dir(&app) else {
        return err("INTERNAL", "could not resolve the app data directory");
    };
    let install_path = plugins_root.join(&staged.manifest.id);
    if let Err(msg) = install::swap_install(&staged.dir, &install_path) {
        return err("INTERNAL", msg);
    }

    let now = now_ms();
    let entry = PluginEntry {
        // FR-9: granted is EXACTLY what the consented manifest declared.
        granted_capabilities: staged.manifest.capabilities.clone(),
        disk_manifest: Some(staged.manifest.clone()),
        manifest: staged.manifest,
        source: staged.source,
        resolved_ref: staged.resolved_ref,
        install_path: install_path.to_string_lossy().into_owned(),
        installed_at: now,
        updated_at: now,
        // FR-75: install is not activation.
        enablement: PluginEnablement::Off,
        settings: Map::new(),
        consent_pending: false,
        last_error: None,
    };
    let id = entry.manifest.id.clone();

    let mut inner = state.inner.lock().unwrap();
    let snapshot = inner.plugins.clone();
    inner.plugins.push(entry);
    if let Err((code, msg)) = registry::persist_or_rollback(&app, &mut inner.plugins, snapshot) {
        // The tree is on disk but the registry is not — remove it so a retry is
        // a clean install rather than an ALREADY_INSTALLED against a phantom.
        let _ = std::fs::remove_dir_all(&install_path);
        return err(code, msg);
    }
    let view = find(&inner.plugins, &id).map(registry::to_view);
    broadcast(&app, &inner.plugins);
    match view {
        Some(v) => ok(v),
        None => err("INTERNAL", "the plugin could not be registered"),
    }
}

#[tauri::command(async)]
pub fn plugins_uninstall(
    app: AppHandle,
    state: State<'_, PluginState>,
    req: PluginIdInput,
) -> IpcResult<Option<()>> {
    let (paths, expired) = {
        let mut inner = state.inner.lock().unwrap();
        let Some(idx) = inner
            .plugins
            .iter()
            .position(|e| e.manifest.id == req.plugin_id)
        else {
            return err(E_NOT_FOUND, "no such plugin");
        };
        let snapshot = inner.plugins.clone();
        let removed = inner.plugins.remove(idx);
        if let Err((code, msg)) = registry::persist_or_rollback(&app, &mut inner.plugins, snapshot)
        {
            return err(code, msg);
        }
        // FR-74: the log ring and the failure counters go with it.
        inner.logs.remove(&req.plugin_id);
        inner.failures.retain(|(id, _), _| id != &req.plugin_id);
        inner.injection_window.remove(&req.plugin_id);
        inner.last_panel.remove(&req.plugin_id);
        inner.last_status.remove(&req.plugin_id);
        let expired = injection::expire(&mut inner, now_ms(), Some(&req.plugin_id), None);
        broadcast(&app, &inner.plugins);
        (
            (
                removed.install_path,
                registry::storage_path(&app, &req.plugin_id),
            ),
            expired,
        )
    };
    // FR-74: the code and the store go; TRANSCRIPTS are never touched — a past
    // `↳ via plugin` attribution is a record of what happened.
    let _ = std::fs::remove_dir_all(PathBuf::from(paths.0));
    if let Some(store) = paths.1 {
        let _ = std::fs::remove_file(store);
    }
    resolve_expired(&app, expired);
    ok(None)
}

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    available: bool,
    #[serde(rename = "currentRef")]
    current_ref: String,
    #[serde(rename = "currentVersion")]
    current_version: String,
    #[serde(rename = "newRef", skip_serializing_if = "Option::is_none")]
    new_ref: Option<String>,
    #[serde(rename = "newVersion", skip_serializing_if = "Option::is_none")]
    new_version: Option<String>,
    #[serde(rename = "newManifest", skip_serializing_if = "Option::is_none")]
    new_manifest: Option<PluginManifest>,
    #[serde(rename = "capabilitiesWidened")]
    capabilities_widened: bool,
    #[serde(rename = "addedCapabilities")]
    added_capabilities: Vec<String>,
    #[serde(rename = "addedHosts")]
    added_hosts: Vec<String>,
}

/// FR-12: re-resolve the recorded spec. Never mutates the registry, never runs
/// plugin code — the staged tree it produces is thrown away.
#[tauri::command(async)]
pub fn plugins_check_update(app: AppHandle, req: PluginIdInput) -> IpcResult<UpdateInfo> {
    let Some((spec, kind, current_ref, current_version, granted)) =
        with_entry(&app, &req.plugin_id)
    else {
        return err(E_NOT_FOUND, "no such plugin");
    };
    let preview = match resolve_into_staging(&app, &spec, Some(kind), Some(&req.plugin_id)) {
        Ok(p) => p,
        Err((code, msg)) => return err(code, msg),
    };
    // FR-12 is explicit that this mutates nothing, so the staging is dropped
    // rather than left for `plugins_update` to reuse. An update re-resolves.
    drop_staging(&app, &preview.staging_id);

    let (added_capabilities, added_hosts) =
        registry::capability_diff(&granted, &preview.manifest.capabilities);
    let widened = !added_capabilities.is_empty() || !added_hosts.is_empty();
    let available = preview.resolved_ref != current_ref;

    ok(UpdateInfo {
        available,
        current_ref,
        current_version,
        new_ref: available.then(|| preview.resolved_ref.clone()),
        new_version: available.then(|| preview.manifest.version.clone()),
        new_manifest: available.then(|| preview.manifest.clone()),
        capabilities_widened: widened,
        added_capabilities,
        added_hosts,
    })
}

fn with_entry(
    app: &AppHandle,
    id: &str,
) -> Option<(String, PluginSourceKind, String, String, PluginCapabilities)> {
    let state = app.try_state::<PluginState>()?;
    let inner = state.inner.lock().unwrap();
    let e = find(&inner.plugins, id)?;
    Some((
        e.source.spec.clone(),
        e.source.kind,
        e.resolved_ref.clone(),
        e.manifest.version.clone(),
        e.granted_capabilities.clone(),
    ))
}

fn drop_staging(app: &AppHandle, staging_id: &str) {
    if let Some(state) = app.try_state::<PluginState>() {
        if let Some(staged) = state.inner.lock().unwrap().staging.remove(staging_id) {
            let _ = std::fs::remove_dir_all(&staged.dir);
        }
    }
}

#[derive(Deserialize)]
pub struct UpdateInput {
    #[serde(rename = "pluginId")]
    plugin_id: String,
    consented: Option<bool>,
}

#[tauri::command(async)]
pub fn plugins_update(
    app: AppHandle,
    state: State<'_, PluginState>,
    req: UpdateInput,
) -> IpcResult<InstalledPlugin> {
    let Some((spec, kind, _, _, granted)) = with_entry(&app, &req.plugin_id) else {
        return err(E_NOT_FOUND, "no such plugin");
    };
    let preview = match resolve_into_staging(&app, &spec, Some(kind), Some(&req.plugin_id)) {
        Ok(p) => p,
        Err((code, msg)) => return err(code, msg),
    };

    // FR-14: a widening update needs consent; a narrowing one is applied
    // silently and REPLACES the granted set (never a union).
    if registry::is_widening(&granted, &preview.manifest.capabilities)
        && req.consented != Some(true)
    {
        drop_staging(&app, &preview.staging_id);
        return err(
            E_CONSENT_REQUIRED,
            "this update asks for more than you granted — review it first",
        );
    }

    let staged = {
        let mut inner = state.inner.lock().unwrap();
        match inner.staging.remove(&preview.staging_id) {
            // The staging must be the one THIS update resolved. A mismatch means
            // two updates raced, and installing the other one's tree under this
            // one's consent is exactly what FR-14 exists to prevent.
            Some(s) if s.updating.as_deref() == Some(req.plugin_id.as_str()) => s,
            Some(s) => {
                let _ = std::fs::remove_dir_all(&s.dir);
                return err("INTERNAL", "the staged update did not match this plugin");
            }
            None => return err("INTERNAL", "the staged update went missing"),
        }
    };

    let Some(plugins_root) = registry::plugins_dir(&app) else {
        return err("INTERNAL", "could not resolve the app data directory");
    };
    let install_path = plugins_root.join(&req.plugin_id);
    // §7 #38: a failed swap leaves the previous version live and changes nothing.
    if let Err(msg) = install::swap_install(&staged.dir, &install_path) {
        return err("INTERNAL", msg);
    }

    let mut inner = state.inner.lock().unwrap();
    let snapshot = inner.plugins.clone();
    let Some(entry) = inner
        .plugins
        .iter_mut()
        .find(|e| e.manifest.id == req.plugin_id)
    else {
        return err(E_NOT_FOUND, "no such plugin");
    };
    // FR-15: settings survive; a key the new manifest no longer declares is
    // dropped, and a newly declared one takes its default.
    entry.settings = registry::migrate_settings(&entry.settings, &staged.manifest);
    entry.granted_capabilities = staged.manifest.capabilities.clone();
    entry.disk_manifest = Some(staged.manifest.clone());
    entry.manifest = staged.manifest;
    entry.resolved_ref = staged.resolved_ref;
    entry.updated_at = now_ms();
    entry.consent_pending = false;
    entry.last_error = None;
    if let Err((code, msg)) = registry::persist_or_rollback(&app, &mut inner.plugins, snapshot) {
        return err(code, msg);
    }
    inner.failures.retain(|(id, _), _| id != &req.plugin_id);
    let view = find(&inner.plugins, &req.plugin_id).map(registry::to_view);
    broadcast(&app, &inner.plugins);
    match view {
        Some(v) => ok(v),
        None => err(E_NOT_FOUND, "no such plugin"),
    }
}

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
    let handler = match req.surface.as_str() {
        "panel" => isolate::Handler::Panel,
        "statusBar" => isolate::Handler::StatusBar,
        _ => return err("INVALID_INPUT", "surface must be panel or statusBar"),
    };
    let surface = match handler {
        isolate::Handler::Panel => PluginSurface::Panel,
        _ => PluginSurface::StatusBar,
    };
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
        Ok(None) => ok(match surface {
            PluginSurface::Panel => RenderOutput::Panel {
                surface: "panel",
                spec: None,
            },
            _ => RenderOutput::Status {
                surface: "statusBar",
                item: None,
            },
        }),
        Ok(Some(value)) => {
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

/// The one path into the isolate. Gathers everything under the lock, releases it,
/// then runs on a blocking worker (FR-22).
async fn invoke(
    app: &AppHandle,
    plugin_id: &str,
    handler: isolate::Handler,
    context: Value,
    project_id: Option<String>,
    surface: PluginSurface,
) -> Result<Option<Value>, (&'static str, String)> {
    let key = secret_key(app);
    let (entry_source, plugin_name, version, settings, capabilities, unreadable) = {
        let state = app
            .try_state::<PluginState>()
            .ok_or(("INTERNAL", "plugins are unavailable".to_string()))?;
        let mut inner = state.inner.lock().unwrap();
        let entry = find(&inner.plugins, plugin_id)
            .ok_or((E_NOT_FOUND, "no such plugin".to_string()))?
            .clone();

        // FR-16/FR-23: consent-pending plugins run nothing at all.
        if entry.consent_pending {
            return Err((
                E_CONSENT_REQUIRED,
                "new permissions — review to re-enable".to_string(),
            ));
        }
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
    });

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
        Some(isolate::run(&invocation, host))
    })
    .await
    .map_err(|_| ("INTERNAL", "the isolate could not be started".to_string()))?;

    let Some(result) = outcome else {
        // A dropped tick is not an error and must not touch the failure counter —
        // the previous render is still on screen and still correct.
        return Ok(None);
    };

    match result {
        Ok(out) => {
            push_logs(app, plugin_id, out.logs);
            Ok(if out.value.is_null() {
                None
            } else {
                Some(out.value)
            })
        }
        Err(msg) => {
            record_failure(app, plugin_id, surface, &msg);
            Err((E_RUNTIME, msg))
        }
    }
}

/// FR-26: append to the per-plugin ring, oldest out first.
fn push_logs(app: &AppHandle, plugin_id: &str, lines: Vec<String>) {
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
}
