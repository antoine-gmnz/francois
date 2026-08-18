//! the francois:project:<verb> Tauri command surface (§5.3).
//!
//! Every handler is glue: it takes the registry lock, delegates to the pure
//! helpers in registry.rs / standards.rs, and maps their failures onto the
//! contract's error codes. Projects and groups share ONE `RegistryDocument`
//! mutex (see `mod.rs`) — a single lock per command, never nested — so a
//! project mutation and a group mutation can neither deadlock against each
//! other nor race to clobber each other's half of projects.json. The registry
//! lock is ALWAYS released before touching the session engine
//! (`project_remove`), so the two subsystems' locks can never deadlock either.

use super::*;

use crate::ipc::{err, ok, IpcResult};
use tauri::{AppHandle, State};

/// Snapshot the projects slot, mutate the clone, persist the whole document, and
/// only then commit — a projects.json write failure must leave memory and disk
/// agreeing (INTERNAL). Delegates the actual swap/rollback to `commit_with` so
/// this and `commit_groups` share one tested rollback shape.
fn commit_projects(
    app: &AppHandle,
    doc: &mut RegistryDocument,
    next: Vec<Project>,
) -> Result<(), String> {
    let groups = doc.groups.clone();
    commit_with(&mut doc.projects, next, |projects| {
        persist(app, projects, &groups)
    })
}

/// project-groups FR-10: the same commit shape, for the groups array.
fn commit_groups(
    app: &AppHandle,
    doc: &mut RegistryDocument,
    next: Vec<ProjectGroup>,
) -> Result<(), String> {
    let projects = doc.projects.clone();
    commit_with(&mut doc.groups, next, |groups| {
        persist(app, &projects, groups)
    })
}

/// francois:project:list (FR-2/FR-5, project-groups FR-5). Never fails for
/// registry reasons (FR-3) — the registry is already in memory.
#[tauri::command(async)]
pub fn project_list(state: State<'_, ProjectRegistry>) -> IpcResult<ProjectRegistrySnapshot> {
    // Snapshot under the lock, derive rootExists OUTSIDE it: list_metas stats every
    // root, and this app supports WSL/UNC roots where a dead share can block for
    // seconds. Holding the mutex across that stalls every project command and
    // session_create's link check along with it.
    let (projects_snapshot, groups_snapshot) = {
        let doc = state.doc.lock().unwrap();
        (doc.projects.clone(), doc.groups.clone())
    };
    ok(ProjectRegistrySnapshot {
        projects: list_metas(&projects_snapshot),
        groups: list_groups(&groups_snapshot),
    })
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

    let mut doc = state.doc.lock().unwrap();
    let project = match create_entry(&doc.projects, &root, name.as_deref(), defaults, id, now) {
        Ok(p) => p,
        Err((code, msg)) => return err(code, msg),
    };
    let mut next = doc.projects.clone();
    next.push(project.clone());
    match commit_projects(&app, &mut doc, next) {
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

    let mut doc = state.doc.lock().unwrap();
    let (idx, patched) = match patch_entry(
        &doc.projects,
        &project_id,
        name.as_deref(),
        normalized.as_deref(),
        defaults,
    ) {
        Ok(v) => v,
        Err((code, msg)) => return err(code, msg),
    };
    let mut next = doc.projects.clone();
    next[idx] = patched.clone();
    match commit_projects(&app, &mut doc, next) {
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
        let mut doc = state.doc.lock().unwrap();
        if !doc.projects.iter().any(|p| p.id == project_id) {
            return err("PROJECT_NOT_FOUND", NOT_FOUND_MSG);
        }
        let next: Vec<Project> = doc
            .projects
            .iter()
            .filter(|p| p.id != project_id)
            .cloned()
            .collect();
        if let Err(msg) = commit_projects(&app, &mut doc, next) {
            return err("INTERNAL", msg);
        }
    } // the registry lock is released BEFORE the engine lock is taken
    crate::session::unlink_project_sessions(&app, &project_id);
    ok(None)
}

/// francois:project:createGroup (FR-1).
#[tauri::command(async)]
pub fn project_create_group(
    app: AppHandle,
    state: State<'_, ProjectRegistry>,
    name: String,
) -> IpcResult<ProjectGroup> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::session::now_ms();

    let mut doc = state.doc.lock().unwrap();
    let group = match create_group_entry(&name, id, now) {
        Ok(g) => g,
        Err((code, msg)) => return err(code, msg),
    };
    let mut next = doc.groups.clone();
    next.push(group.clone());
    match commit_groups(&app, &mut doc, next) {
        Ok(()) => ok(group),
        Err(msg) => err("INTERNAL", msg),
    }
}

/// francois:project:renameGroup (FR-4).
#[tauri::command(async)]
pub fn project_rename_group(
    app: AppHandle,
    state: State<'_, ProjectRegistry>,
    group_id: String,
    name: String,
) -> IpcResult<ProjectGroup> {
    let mut doc = state.doc.lock().unwrap();
    let (idx, patched) = match rename_group_entry(&doc.groups, &group_id, &name) {
        Ok(v) => v,
        Err((code, msg)) => return err(code, msg),
    };
    let mut next = doc.groups.clone();
    next[idx] = patched.clone();
    match commit_groups(&app, &mut doc, next) {
        Ok(()) => ok(patched),
        Err(msg) => err("INTERNAL", msg),
    }
}

/// francois:project:removeGroup (FR-8/FR-9): deletes the group, then clears
/// `groupId` on every member — best-effort, AFTER the delete commits. Touches
/// no session state and emits nothing (FR-9).
#[tauri::command(async)]
pub fn project_remove_group(
    app: AppHandle,
    state: State<'_, ProjectRegistry>,
    group_id: String,
) -> IpcResult<Option<()>> {
    {
        let mut doc = state.doc.lock().unwrap();
        if !group_exists(&doc.groups, &group_id) {
            return err("GROUP_NOT_FOUND", GROUP_NOT_FOUND_MSG);
        }
        let next: Vec<ProjectGroup> = doc
            .groups
            .iter()
            .filter(|g| g.id != group_id)
            .cloned()
            .collect();
        if let Err(msg) = commit_groups(&app, &mut doc, next) {
            return err("INTERNAL", msg);
        }
    } // the registry lock is released BEFORE clear_group re-acquires it (FR-8)
    clear_group(&app, &group_id);
    ok(None)
}

/// francois:project:assignGroup (FR-7): sets or clears a project's `groupId`,
/// re-validating an incoming `groupId` against the LIVE registry rather than
/// trusting the frontend's list.
#[tauri::command(async)]
pub fn project_assign_group(
    app: AppHandle,
    state: State<'_, ProjectRegistry>,
    project_id: String,
    group_id: Option<String>,
) -> IpcResult<ProjectMeta> {
    // ONE lock covers both arrays, so reading groups and patching projects can
    // never race a concurrent group mutation the way two separate locks could.
    let mut doc = state.doc.lock().unwrap();
    let (idx, patched) =
        match assign_group_entry(&doc.projects, &doc.groups, &project_id, group_id.as_deref()) {
            Ok(v) => v,
            Err((code, msg)) => return err(code, msg),
        };
    let mut next = doc.projects.clone();
    next[idx] = patched.clone();
    match commit_projects(&app, &mut doc, next) {
        Ok(()) => ok(meta_of(&patched)),
        Err(msg) => err("INTERNAL", msg),
    }
}

/// The project's root, ready for a standards read/write.
fn root_for(
    state: &State<'_, ProjectRegistry>,
    project_id: &str,
) -> Result<String, (&'static str, &'static str)> {
    // Snapshot under the lock; root_of stats the root, so it runs outside it
    // (a dead UNC share must not stall the registry — see project_list).
    let snapshot = { state.doc.lock().unwrap().projects.clone() };
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
        let doc = state.doc.lock().unwrap();
        doc.projects.iter().find(|p| p.id == project_id).cloned()
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
