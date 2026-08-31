//! the francois:profiles:<verb> Tauri command surface (§5.2).
//!
//! Every handler is glue: it takes the registry lock, delegates to the pure
//! helpers in registry.rs/parse.rs, and maps their failures onto the
//! contract's error codes — the same shape `project::commands` follows.

use super::*;
use crate::ipc::{AppError, ErrorCode};

use crate::ipc::IpcResult;
use tauri::{AppHandle, State};

/// Snapshot the registry, mutate the clone, persist, and only then commit — a
/// profiles.json write failure must leave memory and disk agreeing (FR-1).
fn commit(
    app: &AppHandle,
    slot: &mut Vec<SessionProfile>,
    next: Vec<SessionProfile>,
) -> Result<(), AppError> {
    let previous = std::mem::replace(slot, next);
    // core-architecture-wave3 FR-6: the persist failure is INTERNAL at the
    // registry's own boundary, so the rollback and the code live together
    // instead of being re-decided at each of the three call sites.
    match persist_registry(app, slot) {
        Ok(()) => Ok(()),
        Err(e) => {
            *slot = previous;
            Err(AppError::new(ErrorCode::Internal, e.message))
        }
    }
}

/// francois:profiles:list (FR-4). Never fails for registry reasons (FR-3) —
/// the registry is already in memory; present and `ok:true` (possibly empty)
/// on a first run with no profiles.json at all.
#[tauri::command(async)]
pub fn profiles_list(state: State<'_, ProfileRegistry>) -> IpcResult<Vec<SessionProfile>> {
    let snapshot = state.profiles.lock().unwrap().clone();
    Ok(list_ordered(&snapshot)).into()
}

/// francois:profiles:create (FR-6/FR-7/FR-9).
#[tauri::command(async)]
pub fn profiles_create(
    app: AppHandle,
    state: State<'_, ProfileRegistry>,
    name: String,
    system_prompt: Option<String>,
    extra_args_raw: Option<String>,
) -> IpcResult<SessionProfile> {
    create(&app, &state, name, system_prompt, extra_args_raw).into()
}

fn create(
    app: &AppHandle,
    state: &ProfileRegistry,
    name: String,
    system_prompt: Option<String>,
    extra_args_raw: Option<String>,
) -> Result<SessionProfile, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::session::now_ms();
    let profile = build_profile(id, &name, system_prompt, extra_args_raw, now, now)?;
    let mut profiles = state.profiles.lock().unwrap();
    let mut next = profiles.clone();
    next.push(profile.clone());
    commit(app, &mut profiles, next)?;
    Ok(profile)
}

/// francois:profiles:update (FR-5): replaces every mutable field it is given
/// and refreshes `updatedAt`. `id`/`createdAt` are carried through unchanged.
#[tauri::command(async)]
pub fn profiles_update(
    app: AppHandle,
    state: State<'_, ProfileRegistry>,
    id: String,
    name: String,
    system_prompt: Option<String>,
    extra_args_raw: Option<String>,
) -> IpcResult<SessionProfile> {
    update(&app, &state, id, name, system_prompt, extra_args_raw).into()
}

fn update(
    app: &AppHandle,
    state: &ProfileRegistry,
    id: String,
    name: String,
    system_prompt: Option<String>,
    extra_args_raw: Option<String>,
) -> Result<SessionProfile, AppError> {
    let mut profiles = state.profiles.lock().unwrap();
    let Some(idx) = find_index(&profiles, &id) else {
        return Err(AppError::new(ErrorCode::ProfileNotFound, NOT_FOUND_MSG));
    };
    let created_at = profiles[idx].created_at;
    let now = crate::session::now_ms();
    let patched = build_profile(id, &name, system_prompt, extra_args_raw, created_at, now)?;
    let mut next = profiles.clone();
    next[idx] = patched.clone();
    commit(app, &mut profiles, next)?;
    Ok(patched)
}

/// francois:profiles:remove. Sessions created from this profile keep working
/// and keep showing the snapshotted name (FR-22) — nothing else is touched.
#[tauri::command(async)]
pub fn profiles_remove(
    app: AppHandle,
    state: State<'_, ProfileRegistry>,
    id: String,
) -> IpcResult<Option<()>> {
    remove(&app, &state, &id).into()
}

fn remove(app: &AppHandle, state: &ProfileRegistry, id: &str) -> Result<Option<()>, AppError> {
    let mut profiles = state.profiles.lock().unwrap();
    if find_index(&profiles, id).is_none() {
        return Err(AppError::new(ErrorCode::ProfileNotFound, NOT_FOUND_MSG));
    }
    let next: Vec<SessionProfile> = profiles.iter().filter(|p| p.id != id).cloned().collect();
    commit(app, &mut profiles, next)?;
    // A deleted profile must not stay named as any project's default.
    // Best-effort and AFTER the removal committed — see
    // `project::clear_default_profile`. Sessions already created from the
    // profile are untouched: they snapshot it (FR-16) and keep showing
    // its name (FR-22).
    crate::project::clear_default_profile(app, id);
    Ok(None)
}
