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
//!
//! Three children, split by what a command is allowed to touch:
//!   settings.rs  — the registry: list, status, logs, settings, enablement, and
//!                  the injection decision. Never starts an isolate.
//!   lifecycle.rs — the filesystem: resolve, install, update, uninstall.
//!   render.rs    — plugin CODE: the two commands that open the isolate door,
//!                  and everything that must be true either side of it.
//! This file keeps the startup hooks and the three helpers all of them share.

use super::*;

use std::collections::HashSet;
use tauri::{AppHandle, Manager};

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

mod lifecycle;
mod render;
mod settings;

// NOT `mod install` — `plugin::install` is a sibling this module calls by path,
// and a child of the same name would shadow it at every call site.
pub(crate) use lifecycle::*;
pub(crate) use render::*;
pub(crate) use settings::*;

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
    let plugins_dir = registry::plugins_dir(app);
    let (mut entries, was_reset) = registry::load_registry(&path, plugins_dir.as_deref());

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

/// FR-55/§7 #31: a removed session takes its pending injection cards with it.
///
/// The transcript is deleted with the session, so a card left pending would be a
/// request the user can never see and never answer, still holding the plugin's
/// one-per-session slot.
pub fn on_session_removed(app: &AppHandle, session_id: &str) {
    let Some(state) = app.try_state::<PluginState>() else {
        return;
    };
    let expired = {
        let mut inner = state.inner.lock().unwrap();
        injection::expire(&mut inner, now_ms(), None, Some(session_id))
    };
    resolve_expired(app, expired);
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
