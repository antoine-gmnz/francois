//! FR-1..FR-15 — resolve, install, update, uninstall.
//!
//! The slow half of the domain: it clones repositories, downloads tarballs and
//! renames directories. Every one of these is `#[command(async)]` for that
//! reason, and every one follows the same shape — take the lock, decide, DROP
//! the lock, then do the slow or fallible thing.

use super::*;

use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};

use crate::ipc::{err, ok, IpcResult};

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

/// FR-5/FR-10: claim a staged tree for install.
///
/// Takes it OUT of the map, so a double-install cannot commit the same tree
/// twice, and refuses one older than the TTL — the consent card the user saw
/// described THAT tree, and ten minutes later it is no longer evidence of
/// anything. An unknown id and an expired one give the same message on purpose:
/// both mean "resolve it again", and distinguishing them would only tell a
/// caller which staging ids exist.
fn take_staging(
    inner: &mut PluginInner,
    staging_id: &str,
    now: u64,
) -> Result<StagedTree, &'static str> {
    const EXPIRED: &str = "this install expired — resolve it again";
    match inner.staging.remove(staging_id) {
        Some(s) if now.saturating_sub(s.created_at) <= STAGING_TTL_MS => Ok(s),
        Some(s) => {
            let _ = std::fs::remove_dir_all(&s.dir);
            Err(EXPIRED)
        }
        None => Err(EXPIRED),
    }
}

#[tauri::command(async)]
pub fn plugins_install(
    app: AppHandle,
    state: State<'_, PluginState>,
    req: InstallInput,
) -> IpcResult<InstalledPlugin> {
    let staged = {
        let mut inner = state.inner.lock().unwrap();
        match take_staging(&mut inner, &req.staging_id, now_ms()) {
            Ok(s) => s,
            Err(msg) => return err("INVALID_INPUT", msg),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::*;

    // ---------- FR-5/FR-10: the staging TTL ----------

    fn staged_at(created_at: u64, dir: &std::path::Path) -> StagedTree {
        StagedTree {
            dir: dir.to_path_buf(),
            manifest: manifest_fixture("acme-ci"),
            source: PluginSource {
                kind: PluginSourceKind::Github,
                spec: "acme/francois-ci".into(),
            },
            resolved_ref: "a".repeat(40),
            unpacked_bytes: 1024,
            created_at,
            updating: None,
        }
    }

    #[test]
    fn a_staged_tree_installs_once_and_only_inside_its_ttl() {
        let dir = tmp_dir("staging-ttl");
        let mut inner = PluginInner::default();
        inner.staging.insert("s1".into(), staged_at(1_000, &dir));

        // §9: `plugins:install` with an UNKNOWN stagingId fails.
        assert!(take_staging(&mut inner, "nope", 1_000).is_err());
        // …inside the TTL it is claimed…
        assert!(take_staging(&mut inner, "s1", 1_000 + STAGING_TTL_MS).is_ok());
        // …and claiming is destructive, so a double install cannot commit the
        // same tree twice.
        assert!(take_staging(&mut inner, "s1", 1_000).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_staged_tree_past_its_ttl_is_refused_and_swept() {
        // FR-5: the consent card described THAT tree ten minutes ago. The tree
        // goes with the refusal rather than lingering on disk.
        let dir = tmp_dir("staging-expired");
        std::fs::write(dir.join("plugin.js"), "x").unwrap();
        let mut inner = PluginInner::default();
        inner.staging.insert("s1".into(), staged_at(1_000, &dir));

        let err = take_staging(&mut inner, "s1", 1_000 + STAGING_TTL_MS + 1).unwrap_err();
        assert!(err.contains("expired"), "{err}");
        assert!(
            !dir.exists(),
            "the expired tree is removed, not left behind"
        );
        assert!(inner.staging.is_empty());
    }
}
