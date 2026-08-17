//! the francois:profiles:<verb> Tauri command surface (§5.2).
//!
//! Every handler is glue: it takes the registry lock, delegates to the pure
//! helpers in registry.rs/parse.rs, and maps their failures onto the
//! contract's error codes — the same shape `project::commands` follows.

use super::*;

use crate::ipc::{err, err_detail, ok, IpcResult};
use tauri::{AppHandle, State};

/// Snapshot the registry, mutate the clone, persist, and only then commit — a
/// profiles.json write failure must leave memory and disk agreeing (FR-1).
fn commit(
    app: &AppHandle,
    slot: &mut Vec<SessionProfile>,
    next: Vec<SessionProfile>,
) -> Result<(), String> {
    let previous = std::mem::replace(slot, next);
    match persist_registry(app, slot) {
        Ok(()) => Ok(()),
        Err(msg) => {
            *slot = previous;
            Err(msg)
        }
    }
}

fn into_ipc<T: serde::Serialize>(e: ProfileError) -> IpcResult<T> {
    match e {
        ProfileError::InvalidInput(msg) => err("INVALID_INPUT", msg),
        ProfileError::ArgDenied { flag, reason } => err_detail(
            "PROFILE_ARG_DENIED",
            format!("{flag} is not allowed in a profile's extra args: {reason}"),
            serde_json::json!({ "flag": flag, "reason": reason }),
        ),
    }
}

/// francois:profiles:list (FR-4). Never fails for registry reasons (FR-3) —
/// the registry is already in memory; present and `ok:true` (possibly empty)
/// on a first run with no profiles.json at all.
#[tauri::command(async)]
pub fn profiles_list(state: State<'_, ProfileRegistry>) -> IpcResult<Vec<SessionProfile>> {
    let snapshot = state.profiles.lock().unwrap().clone();
    ok(list_ordered(&snapshot))
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
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::session::now_ms();
    let profile = match build_profile(id, &name, system_prompt, extra_args_raw, now, now) {
        Ok(p) => p,
        Err(e) => return into_ipc(e),
    };
    let mut profiles = state.profiles.lock().unwrap();
    let mut next = profiles.clone();
    next.push(profile.clone());
    match commit(&app, &mut profiles, next) {
        Ok(()) => ok(profile),
        Err(msg) => err("INTERNAL", msg),
    }
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
    let mut profiles = state.profiles.lock().unwrap();
    let Some(idx) = find_index(&profiles, &id) else {
        return err("PROFILE_NOT_FOUND", NOT_FOUND_MSG);
    };
    let created_at = profiles[idx].created_at;
    let now = crate::session::now_ms();
    let patched = match build_profile(id, &name, system_prompt, extra_args_raw, created_at, now) {
        Ok(p) => p,
        Err(e) => return into_ipc(e),
    };
    let mut next = profiles.clone();
    next[idx] = patched.clone();
    match commit(&app, &mut profiles, next) {
        Ok(()) => ok(patched),
        Err(msg) => err("INTERNAL", msg),
    }
}

/// francois:profiles:remove. Sessions created from this profile keep working
/// and keep showing the snapshotted name (FR-22) — nothing else is touched.
#[tauri::command(async)]
pub fn profiles_remove(
    app: AppHandle,
    state: State<'_, ProfileRegistry>,
    id: String,
) -> IpcResult<Option<()>> {
    let mut profiles = state.profiles.lock().unwrap();
    if find_index(&profiles, &id).is_none() {
        return err("PROFILE_NOT_FOUND", NOT_FOUND_MSG);
    }
    let next: Vec<SessionProfile> = profiles.iter().filter(|p| p.id != id).cloned().collect();
    match commit(&app, &mut profiles, next) {
        Ok(()) => {
            // A deleted profile must not stay named as any project's default.
            // Best-effort and AFTER the removal committed — see
            // `project::clear_default_profile`. Sessions already created from the
            // profile are untouched: they snapshot it (FR-16) and keep showing
            // its name (FR-22).
            crate::project::clear_default_profile(&app, &id);
            ok(None)
        }
        Err(msg) => err("INTERNAL", msg),
    }
}
