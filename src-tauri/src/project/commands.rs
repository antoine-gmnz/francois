//! the francois:project:<verb> Tauri command surface (§5.3).
//!
//! Every handler is glue: it takes the registry lock, delegates to the pure
//! helpers in registry.rs / standards.rs, and maps their failures onto the
//! contract's error codes. The registry lock is ALWAYS released before touching
//! the session engine (`project_remove`), so the two mutexes can never deadlock.

use super::*;

use crate::ipc::{err, ok, IpcResult};
use tauri::{AppHandle, State};

/// Snapshot the registry, mutate the clone, persist, and only then commit — a
/// projects.json write failure must leave memory and disk agreeing (INTERNAL).
fn commit(app: &AppHandle, slot: &mut Vec<Project>, next: Vec<Project>) -> Result<(), String> {
    let previous = std::mem::replace(slot, next);
    match persist_registry(app, slot) {
        Ok(()) => Ok(()),
        Err(msg) => {
            *slot = previous;
            Err(msg)
        }
    }
}

/// francois:project:list (FR-2/FR-5). Never fails for registry reasons (FR-3) —
/// the registry is already in memory.
#[tauri::command(async)]
pub fn project_list(state: State<'_, ProjectRegistry>) -> IpcResult<Vec<ProjectMeta>> {
    // Snapshot under the lock, derive rootExists OUTSIDE it: list_metas stats every
    // root, and this app supports WSL/UNC roots where a dead share can block for
    // seconds. Holding the mutex across that stalls every project command and
    // session_create's link check along with it.
    let snapshot = { state.projects.lock().unwrap().clone() };
    ok(list_metas(&snapshot))
}

/// francois:project:create (FR-6).
#[tauri::command(async)]
pub fn project_create(
    app: AppHandle,
    state: State<'_, ProjectRegistry>,
    root: String,
    name: Option<String>,
    defaults: Option<ProjectDefaults>,
) -> IpcResult<ProjectMeta> {
    // FR-6 order: root shape/existence first, then duplication. The stat happens
    // BEFORE the lock is taken (see project_list) — the duplicate check needs the
    // registry, the filesystem check does not.
    let root = match validate_root(&root) {
        Ok(r) => r,
        Err(msg) => return err("INVALID_INPUT", msg),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::session::now_ms();

    let mut projects = state.projects.lock().unwrap();
    let project = match create_entry(&projects, &root, name.as_deref(), defaults, id, now) {
        Ok(p) => p,
        Err((code, msg)) => return err(code, msg),
    };
    let mut next = projects.clone();
    next.push(project.clone());
    match commit(&app, &mut projects, next) {
        Ok(()) => ok(meta_of(&project)),
        Err(msg) => err("INTERNAL", msg),
    }
}

/// francois:project:update (FR-7): patches only the fields present in the payload.
/// A present `defaults` REPLACES the whole object — that is how "inherit" is
/// restored. Changing `root` re-links nothing (FR-7) and re-emits nothing (FR-24).
#[tauri::command(async)]
pub fn project_update(
    app: AppHandle,
    state: State<'_, ProjectRegistry>,
    project_id: String,
    name: Option<String>,
    root: Option<String>,
    defaults: Option<ProjectDefaults>,
) -> IpcResult<ProjectMeta> {
    // Normalize + stat a new root before the lock (see project_list).
    let normalized = match root {
        Some(raw) => match validate_root(&raw) {
            Ok(r) => Some(r),
            Err(msg) => return err("INVALID_INPUT", msg),
        },
        None => None,
    };

    let mut projects = state.projects.lock().unwrap();
    let (idx, patched) = match patch_entry(
        &projects,
        &project_id,
        name.as_deref(),
        normalized.as_deref(),
        defaults,
    ) {
        Ok(v) => v,
        Err((code, msg)) => return err(code, msg),
    };
    let mut next = projects.clone();
    next[idx] = patched.clone();
    match commit(&app, &mut projects, next) {
        Ok(()) => ok(meta_of(&patched)),
        Err(msg) => err("INTERNAL", msg),
    }
}

/// francois:project:remove (FR-9): drop the entry, then clear `projectId` on every
/// session that referenced it — in memory AND in sessions.json — with one
/// `session.meta` per affected session. NOTHING under `root` is touched.
#[tauri::command(async)]
pub fn project_remove(
    app: AppHandle,
    state: State<'_, ProjectRegistry>,
    project_id: String,
) -> IpcResult<Option<()>> {
    {
        let mut projects = state.projects.lock().unwrap();
        if !projects.iter().any(|p| p.id == project_id) {
            return err("PROJECT_NOT_FOUND", NOT_FOUND_MSG);
        }
        let next: Vec<Project> = projects
            .iter()
            .filter(|p| p.id != project_id)
            .cloned()
            .collect();
        if let Err(msg) = commit(&app, &mut projects, next) {
            return err("INTERNAL", msg);
        }
    } // the registry lock is released BEFORE the engine lock is taken
    crate::session::unlink_project_sessions(&app, &project_id);
    // plugin-system FR-78 / §7 #45: the id also leaves every plugin's
    // `projectIds`; an emptied set then behaves as `off` (FR-77).
    crate::plugin::on_project_removed(&app, &project_id);
    ok(None)
}

/// The project's root, ready for a standards read/write.
fn root_for(
    state: &State<'_, ProjectRegistry>,
    project_id: &str,
) -> Result<String, (&'static str, &'static str)> {
    // Snapshot under the lock; root_of stats the root, so it runs outside it
    // (a dead UNC share must not stall the registry — see project_list).
    let snapshot = { state.projects.lock().unwrap().clone() };
    root_of(&snapshot, project_id)
}

/// francois:project:getStandards (FR-10). A missing CLAUDE.md is NOT an error.
#[tauri::command(async)]
pub fn project_get_standards(
    state: State<'_, ProjectRegistry>,
    project_id: String,
) -> IpcResult<StandardsRead> {
    let root = match root_for(&state, &project_id) {
        Ok(r) => r,
        Err((code, msg)) => return err(code, msg),
    };
    match read_standards(&root) {
        Ok(read) => ok(read),
        Err(msg) => err("INTERNAL", msg), // FR-15: reads fail as INTERNAL
    }
}

/// francois:project:setStandards (FR-13..FR-16). Validation runs BEFORE any file
/// is opened, so a rule carrying a marker (§7 #10) can never reach the disk.
#[tauri::command(async)]
pub fn project_set_standards(
    state: State<'_, ProjectRegistry>,
    project_id: String,
    standards: ProjectStandards,
) -> IpcResult<StandardsRead> {
    // Resolve the project first (an unknown id is not an INVALID_INPUT), but
    // validate before the root stat and before any file handle exists.
    let known = {
        let projects = state.projects.lock().unwrap();
        projects.iter().find(|p| p.id == project_id).cloned()
    };
    let Some(project) = known else {
        return err("PROJECT_NOT_FOUND", NOT_FOUND_MSG);
    };
    if let Err(msg) = validate_standards(&standards) {
        return err("INVALID_INPUT", msg);
    }
    if !root_exists(&project.root) {
        return err("PROJECT_ROOT_MISSING", ROOT_MISSING_MSG);
    }
    match write_standards(&project.root, &standards) {
        Ok(read) => ok(read), // FR-16: a fresh re-read, never the payload
        Err(msg) => err("STANDARDS_WRITE_FAILED", msg),
    }
}
