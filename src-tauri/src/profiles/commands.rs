//! the francois:profiles:<verb> Tauri command surface (§5.2), amended by
//! pi-migration-rollout for the runtime-tagged union and `profiles_copy_to_pi`.
//!
//! Every handler is glue: it takes the registry lock, delegates to the pure
//! helpers in registry.rs/parse.rs/pi_settings.rs, and maps their failures
//! onto the contract's error codes — the same shape `project::commands`
//! follows.

use super::*;
use crate::ipc::{AppError, ErrorCode};

use crate::ipc::IpcResult;
use tauri::{AppHandle, Manager, State};

/// FR-6: every `profiles_*` command refuses while the on-disk schema could
/// not be safely migrated — see `registry::load_profiles`.
fn ensure_writable(state: &ProfileRegistry) -> Result<(), AppError> {
    if is_writable(state) {
        Ok(())
    } else {
        Err(AppError::new(ErrorCode::Internal, REGISTRY_UNWRITABLE_MSG))
    }
}

/// pi-migration-rollout FR-2: an update may not change a stored profile's
/// kind. Pure so it is unit-testable without an AppHandle.
fn check_kind_match(existing_kind: &str, requested_kind: &str) -> Result<(), AppError> {
    if existing_kind == requested_kind {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::ProfileRuntimeMismatch,
            RUNTIME_MISMATCH_MSG,
        ))
    }
}

/// The whole create-shape decision for BOTH kinds, pure — `create`/`update`
/// (below) are the only callers, and this is what makes the branch
/// unit-testable without a registry lock or an AppHandle.
fn build_new_profile(
    id: String,
    kind: Option<&str>,
    name: String,
    system_prompt: Option<String>,
    extra_args_raw: Option<String>,
    settings: Option<PiProfileSettingsInput>,
    now: u64,
) -> Result<SessionProfile, AppError> {
    match kind {
        None | Some("legacy") => {
            let legacy = build_profile(id, &name, system_prompt, extra_args_raw, now, now)?;
            Ok(SessionProfile::Legacy(legacy))
        }
        Some("pi") => {
            let name = validate_name(&name).map_err(ProfileError::InvalidInput)?;
            let raw = settings.ok_or(ProfileError::InvalidInput(MISSING_PI_SETTINGS_MSG))?;
            let validated = validate_pi_settings(raw)?;
            Ok(SessionProfile::Pi(PiSessionProfile {
                id,
                name,
                settings: validated,
                created_at: now,
                updated_at: now,
            }))
        }
        Some(_unknown) => Err(AppError::new(
            ErrorCode::InvalidInput,
            "unknown profile kind",
        )),
    }
}

fn with_created_at(mut profile: SessionProfile, created_at: u64) -> SessionProfile {
    match &mut profile {
        SessionProfile::Legacy(l) => l.created_at = created_at,
        SessionProfile::Pi(p) => p.created_at = created_at,
    }
    profile
}

/// Snapshot the registry, mutate the clone, persist (carrying the untouched
/// `unknown` entries along, FR-6), and only then commit — a profiles.json
/// write failure must leave memory and disk agreeing (FR-1).
fn commit(
    app: &AppHandle,
    state: &ProfileRegistry,
    slot: &mut Vec<SessionProfile>,
    next: Vec<SessionProfile>,
) -> Result<(), AppError> {
    let previous = std::mem::replace(slot, next);
    let unknown = state.unknown.lock().unwrap().clone();
    // core-architecture-wave3 FR-6: the persist failure is INTERNAL at the
    // registry's own boundary, so the rollback and the code live together
    // instead of being re-decided at each of the four call sites.
    match persist_registry(app, slot, &unknown) {
        Ok(()) => Ok(()),
        Err(e) => {
            *slot = previous;
            Err(AppError::new(ErrorCode::Internal, e.message))
        }
    }
}

/// francois:profiles:list (FR-4). Never fails for registry reasons on a
/// writable registry (FR-3) — present and `ok:true` (possibly empty) on a
/// first run with no profiles.json at all. pi-migration-rollout FR-6: fails
/// INTERNAL while the registry could not be migrated — the "migration
/// status" the roadmap mentions has no IPC shape of its own (spec §5 is
/// silent), so a failed migration surfaces through this existing error path.
#[tauri::command(async)]
pub fn profiles_list(state: State<'_, ProfileRegistry>) -> IpcResult<Vec<SessionProfile>> {
    list(&state).into()
}

fn list(state: &ProfileRegistry) -> Result<Vec<SessionProfile>, AppError> {
    ensure_writable(state)?;
    let snapshot = state.profiles.lock().unwrap().clone();
    Ok(list_ordered(&snapshot))
}

/// francois:profiles:create (FR-6/FR-7/FR-9, pi-migration-rollout FR-2/FR-5
/// for `kind: 'pi'`). `kind` absent or `'legacy'` keeps today's shape exactly.
#[tauri::command(async)]
pub fn profiles_create(
    app: AppHandle,
    state: State<'_, ProfileRegistry>,
    kind: Option<String>,
    name: String,
    system_prompt: Option<String>,
    extra_args_raw: Option<String>,
    settings: Option<PiProfileSettingsInput>,
) -> IpcResult<SessionProfile> {
    create(
        &app,
        &state,
        kind,
        name,
        system_prompt,
        extra_args_raw,
        settings,
    )
    .into()
}

fn create(
    app: &AppHandle,
    state: &ProfileRegistry,
    kind: Option<String>,
    name: String,
    system_prompt: Option<String>,
    extra_args_raw: Option<String>,
    settings: Option<PiProfileSettingsInput>,
) -> Result<SessionProfile, AppError> {
    ensure_writable(state)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::session::now_ms();
    let profile = build_new_profile(
        id,
        kind.as_deref(),
        name,
        system_prompt,
        extra_args_raw,
        settings,
        now,
    )?;
    let mut profiles = state.profiles.lock().unwrap();
    let mut next = profiles.clone();
    next.push(profile.clone());
    commit(app, state, &mut profiles, next)?;
    Ok(profile)
}

/// francois:profiles:update (FR-5): replaces every mutable field it is given
/// and refreshes `updatedAt`. `id`/`createdAt` are carried through unchanged.
/// pi-migration-rollout FR-2: a kind change is refused with
/// PROFILE_RUNTIME_MISMATCH — a profile's runtime never changes in place.
#[tauri::command(async)]
pub fn profiles_update(
    app: AppHandle,
    state: State<'_, ProfileRegistry>,
    id: String,
    kind: Option<String>,
    name: String,
    system_prompt: Option<String>,
    extra_args_raw: Option<String>,
    settings: Option<PiProfileSettingsInput>,
) -> IpcResult<SessionProfile> {
    update(
        &app,
        &state,
        id,
        kind,
        name,
        system_prompt,
        extra_args_raw,
        settings,
    )
    .into()
}

#[allow(clippy::too_many_arguments)]
fn update(
    app: &AppHandle,
    state: &ProfileRegistry,
    id: String,
    kind: Option<String>,
    name: String,
    system_prompt: Option<String>,
    extra_args_raw: Option<String>,
    settings: Option<PiProfileSettingsInput>,
) -> Result<SessionProfile, AppError> {
    ensure_writable(state)?;
    let mut profiles = state.profiles.lock().unwrap();
    let Some(idx) = find_index(&profiles, &id) else {
        return Err(AppError::new(ErrorCode::ProfileNotFound, NOT_FOUND_MSG));
    };
    let requested_kind = kind.as_deref().unwrap_or("legacy");
    check_kind_match(profiles[idx].kind(), requested_kind)?;
    let created_at = match &profiles[idx] {
        SessionProfile::Legacy(l) => l.created_at,
        SessionProfile::Pi(p) => p.created_at,
    };
    let now = crate::session::now_ms();
    let patched = build_new_profile(
        id,
        kind.as_deref(),
        name,
        system_prompt,
        extra_args_raw,
        settings,
        now,
    )?;
    let patched = with_created_at(patched, created_at);
    let mut next = profiles.clone();
    next[idx] = patched.clone();
    commit(app, state, &mut profiles, next)?;
    Ok(patched)
}

/// francois:profiles:copyToPi → `profiles_copy_to_pi` (pi-migration-rollout
/// FR-4, NEW). The source must be `legacy` (a Pi source refuses with
/// PROFILE_RUNTIME_MISMATCH — it is already a Pi profile); the original is
/// always kept. Only `name`/`settings` as reviewed by the caller carry over —
/// `extraArgs` are never translated (no `--mcp-config`, no `--allowedTools`).
#[tauri::command(async)]
pub fn profiles_copy_to_pi(
    app: AppHandle,
    state: State<'_, ProfileRegistry>,
    id: String,
    name: String,
    settings: PiProfileSettingsInput,
) -> IpcResult<PiSessionProfile> {
    copy_to_pi(&app, &state, id, name, settings).into()
}

fn copy_to_pi(
    app: &AppHandle,
    state: &ProfileRegistry,
    id: String,
    name: String,
    settings: PiProfileSettingsInput,
) -> Result<PiSessionProfile, AppError> {
    ensure_writable(state)?;
    let mut profiles = state.profiles.lock().unwrap();
    let Some(source) = profiles.iter().find(|p| p.id() == id) else {
        return Err(AppError::new(ErrorCode::ProfileNotFound, NOT_FOUND_MSG));
    };
    if source.kind() != "legacy" {
        return Err(AppError::new(
            ErrorCode::ProfileRuntimeMismatch,
            "the source profile is already a pi profile",
        ));
    }
    let name = validate_name(&name).map_err(ProfileError::InvalidInput)?;
    let validated = validate_pi_settings(settings)?;
    let now = crate::session::now_ms();
    let copy = PiSessionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        settings: validated,
        created_at: now,
        updated_at: now,
    };
    let mut next = profiles.clone();
    next.push(SessionProfile::Pi(copy.clone()));
    commit(app, state, &mut profiles, next)?;
    Ok(copy)
}

/// francois:profiles:remove. Sessions created from this profile keep working
/// and keep showing the snapshotted name (FR-22) — nothing else is touched.
/// pi-migration-rollout FR-7: project defaults naming this profile are
/// cleared exactly as before (kind-agnostic, `project::clear_default_profile`)
/// and any session still referencing it is logged for visibility.
#[tauri::command(async)]
pub fn profiles_remove(
    app: AppHandle,
    state: State<'_, ProfileRegistry>,
    id: String,
) -> IpcResult<Option<()>> {
    remove(&app, &state, &id).into()
}

fn remove(app: &AppHandle, state: &ProfileRegistry, id: &str) -> Result<Option<()>, AppError> {
    ensure_writable(state)?;
    let mut profiles = state.profiles.lock().unwrap();
    if find_index(&profiles, id).is_none() {
        return Err(AppError::new(ErrorCode::ProfileNotFound, NOT_FOUND_MSG));
    }
    let next: Vec<SessionProfile> = profiles.iter().filter(|p| p.id() != id).cloned().collect();
    commit(app, state, &mut profiles, next)?;
    // A deleted profile must not stay named as any project's default.
    // Best-effort and AFTER the removal committed — see
    // `project::clear_default_profile`. Sessions already created from the
    // profile are untouched: they snapshot it (FR-16) and keep showing
    // its name (FR-22).
    crate::project::clear_default_profile(app, id);
    report_affected_sessions(app, id);
    Ok(None)
}

/// pi-migration-rollout FR-7's "and reports affected sessions" half.
/// Read-only, straight off sessions.json's own on-disk shape (never the live
/// Engine — that belongs to `session`, out of this wave's scope). Diagnostic
/// only: a referencing session's OWN snapshot (FR-16/FR-22) is unaffected
/// either way, so nothing here changes behaviour.
fn report_affected_sessions(app: &AppHandle, profile_id: &str) {
    let affected = sessions_referencing(app, profile_id);
    if !affected.is_empty() {
        eprintln!(
            "profiles: removed profile {profile_id} — {} session(s) still reference it: {}",
            affected.len(),
            affected.join(", ")
        );
    }
}

fn sessions_referencing(app: &AppHandle, profile_id: &str) -> Vec<String> {
    let Some(dir) = app.path().app_data_dir().ok() else {
        return Vec::new();
    };
    let Ok(bytes) = std::fs::read(dir.join("sessions.json")) else {
        return Vec::new();
    };
    let Ok(list) = serde_json::from_slice::<Vec<serde_json::Value>>(&bytes) else {
        return Vec::new();
    };
    sessions_referencing_in(&list, profile_id)
}

/// Pure half of `sessions_referencing`, split out purely so this is
/// unit-testable without an AppHandle.
fn sessions_referencing_in(list: &[serde_json::Value], profile_id: &str) -> Vec<String> {
    list.iter()
        .filter(|rec| {
            rec.get("profile")
                .and_then(|p| p.get("id"))
                .and_then(|v| v.as_str())
                == Some(profile_id)
        })
        .filter_map(|rec| rec.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn registry(writable: bool) -> ProfileRegistry {
        ProfileRegistry {
            profiles: std::sync::Mutex::new(Vec::new()),
            unknown: std::sync::Mutex::new(Vec::new()),
            writable: std::sync::Mutex::new(writable),
        }
    }

    // ---------- FR-6: writable gate ----------

    #[test]
    fn ensure_writable_refuses_while_the_registry_is_unwritable() {
        let unwritable = registry(false);
        let err = ensure_writable(&unwritable).expect_err("must refuse");
        assert_eq!(err.code, ErrorCode::Internal);

        let writable = registry(true);
        assert!(ensure_writable(&writable).is_ok());
    }

    // ---------- pi-migration-rollout FR-2: kind-change guard ----------

    #[test]
    fn check_kind_match_allows_the_same_kind_and_refuses_a_change() {
        assert!(check_kind_match("legacy", "legacy").is_ok());
        assert!(check_kind_match("pi", "pi").is_ok());
        let err = check_kind_match("legacy", "pi").expect_err("mismatch");
        assert_eq!(err.code, ErrorCode::ProfileRuntimeMismatch);
        let err = check_kind_match("pi", "legacy").expect_err("mismatch");
        assert_eq!(err.code, ErrorCode::ProfileRuntimeMismatch);
    }

    // ---------- build_new_profile ----------

    #[test]
    fn build_new_profile_none_kind_builds_legacy() {
        let profile =
            build_new_profile("id1".into(), None, "role".into(), None, None, None, 0).unwrap();
        assert_eq!(profile.kind(), "legacy");
    }

    #[test]
    fn build_new_profile_explicit_legacy_kind_builds_legacy() {
        let profile = build_new_profile(
            "id1".into(),
            Some("legacy"),
            "role".into(),
            None,
            None,
            None,
            0,
        )
        .unwrap();
        assert_eq!(profile.kind(), "legacy");
    }

    #[test]
    fn build_new_profile_pi_kind_requires_settings() {
        let err = build_new_profile("id1".into(), Some("pi"), "role".into(), None, None, None, 0)
            .expect_err("missing settings");
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn build_new_profile_pi_kind_builds_a_pi_profile() {
        let settings = PiProfileSettingsInput {
            system_prompt_mode: "default".into(),
            system_prompt: None,
            instruction_paths: Vec::new(),
            skill_paths: Vec::new(),
            tools: Vec::new(),
            project_resources: "ignore".into(),
        };
        let profile = build_new_profile(
            "id1".into(),
            Some("pi"),
            "reviewer".into(),
            None,
            None,
            Some(settings),
            0,
        )
        .unwrap();
        assert_eq!(profile.kind(), "pi");
        assert_eq!(profile.name(), "reviewer");
    }

    #[test]
    fn build_new_profile_rejects_an_unknown_kind() {
        let err = build_new_profile(
            "id1".into(),
            Some("codex"),
            "role".into(),
            None,
            None,
            None,
            0,
        )
        .expect_err("unknown kind");
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    // ---------- with_created_at ----------

    #[test]
    fn with_created_at_overwrites_only_created_at() {
        let legacy =
            build_new_profile("id1".into(), None, "role".into(), None, None, None, 99).unwrap();
        let patched = with_created_at(legacy, 1);
        match patched {
            SessionProfile::Legacy(l) => assert_eq!(l.created_at, 1),
            _ => panic!("expected legacy"),
        }
    }

    // ---------- FR-7: affected-sessions report ----------

    #[test]
    fn sessions_referencing_in_finds_only_matching_sessions() {
        let list = vec![
            json!({ "id": "s1", "profile": { "id": "p1", "name": "role-a" } }),
            json!({ "id": "s2", "profile": { "id": "p2", "name": "role-b" } }),
            json!({ "id": "s3" }),
        ];
        assert_eq!(sessions_referencing_in(&list, "p1"), vec!["s1".to_string()]);
        assert!(sessions_referencing_in(&list, "unknown").is_empty());
    }
}
