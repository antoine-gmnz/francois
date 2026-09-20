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

/// FR-6: every MUTATING `profiles_*` command refuses while the on-disk schema
/// could not be safely migrated — see `registry::load_profiles`. Listing is
/// deliberately not gated on it (FR-10: "rollback is read-only access").
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

/// francois:profiles:list (FR-4). Never fails for registry reasons (FR-3) —
/// present and `ok:true` (possibly empty) on a first run with no profiles.json
/// at all, AND on a registry that could not be migrated: pi-migration-rollout
/// FR-10 makes that state read-only access, not no access, so the user can
/// still see what they have while every mutating command refuses. The
/// "migration status" the roadmap mentions has no IPC shape of its own (spec
/// §5 is silent) — the refusal a user meets is the one on the edit they try.
#[tauri::command(async)]
pub fn profiles_list(state: State<'_, ProfileRegistry>) -> IpcResult<Vec<SessionProfile>> {
    list(&state).into()
}

fn list(state: &ProfileRegistry) -> Result<Vec<SessionProfile>, AppError> {
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
    let now = crate::ids::now_ms();
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
    let now = crate::ids::now_ms();
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
///
/// Answers with the tagged `SessionProfile`, never the bare `PiSessionProfile`:
/// the contract's `PiSessionProfile.kind: 'pi'` is the wrapping enum's serde
/// tag, not a field of the struct, so the bare struct would reach the webview
/// with no discriminant for the modal's `kind` switch.
#[tauri::command(async)]
pub fn profiles_copy_to_pi(
    app: AppHandle,
    state: State<'_, ProfileRegistry>,
    id: String,
    name: String,
    settings: PiProfileSettingsInput,
) -> IpcResult<SessionProfile> {
    copy_to_pi(&app, &state, id, name, settings).into()
}

fn copy_to_pi(
    app: &AppHandle,
    state: &ProfileRegistry,
    id: String,
    name: String,
    settings: PiProfileSettingsInput,
) -> Result<SessionProfile, AppError> {
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
    let now = crate::ids::now_ms();
    let copy = SessionProfile::Pi(PiSessionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        settings: validated,
        created_at: now,
        updated_at: now,
    });
    let mut next = profiles.clone();
    next.push(copy.clone());
    commit(app, state, &mut profiles, next)?;
    Ok(copy)
}

/// francois:profiles:remove. Sessions created from this profile keep working
/// and keep showing the snapshotted name (FR-22) — nothing else is touched.
/// pi-migration-rollout FR-7: project defaults naming this profile are
/// cleared exactly as before (kind-agnostic) and any session still
/// referencing it is logged for visibility.
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
    // FR-7's report is read BEFORE anything is committed, and it FAILS CLOSED
    // (pr-142 §6): a sessions.json this build cannot read says nothing about
    // whether the profile is in use, and "no references" is the one answer it
    // must not be allowed to imply. Refusing leaves the profile, the file and
    // every project default exactly as they were.
    let affected = sessions_referencing(app, id)?;
    let next: Vec<SessionProfile> = profiles.iter().filter(|p| p.id() != id).cloned().collect();
    commit(app, state, &mut profiles, next)?;
    // A deleted profile must not stay named as any project's default.
    // Best-effort and AFTER the removal committed, through the observer seam
    // (`ProfileRemovalObserver`) rather than a direct call into `project` —
    // and with this registry's lock released first, because the observer takes
    // another domain's. Sessions already created from the profile are
    // untouched: they snapshot it (FR-16) and keep showing its name (FR-22).
    drop(profiles);
    notify_profile_removed(app, id);
    if !affected.is_empty() {
        eprintln!(
            "profiles: removed profile {id} — {} session(s) still reference it: {}",
            affected.len(),
            affected.join(", ")
        );
    }
    Ok(None)
}

/// pi-migration-rollout FR-7's "and reports affected sessions" half.
/// Read-only, straight off sessions.json (never the live Engine — that
/// belongs to `session`, and reaching for it would close the `profiles ↔
/// session` cycle this PR just removed).
fn sessions_referencing(app: &AppHandle, profile_id: &str) -> Result<Vec<String>, AppError> {
    let Ok(dir) = app.path().app_data_dir() else {
        return Err(AppError::new(ErrorCode::Internal, UNREADABLE_SESSIONS_MSG));
    };
    match std::fs::read(dir.join("sessions.json")) {
        Ok(bytes) => sessions_referencing_in(&bytes, profile_id),
        // No file at all is not a failed read: a fleet that has never been
        // persisted genuinely has no session referencing anything.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(AppError::new(
            ErrorCode::Internal,
            format!("{UNREADABLE_SESSIONS_MSG}: {e}"),
        )),
    }
}

/// The record shape this domain needs out of sessions.json, and nothing more.
/// TYPED rather than a raw `Value` walk (pr-142 §6): a walk answers "no
/// references" to every question it cannot understand, so a change to the
/// persisted shape would silently re-permit deleting a profile that is in
/// use. `SessionProfileRef` is this domain's own contract type (see mod.rs),
/// so reading it here needs no import from `session`.
#[derive(serde::Deserialize)]
struct SessionRecordRef {
    id: String,
    #[serde(default)]
    profile: Option<SessionProfileRef>,
}

/// Pure half of `sessions_referencing`, split out so the fail-closed rule is
/// unit-testable without an AppHandle.
fn sessions_referencing_in(bytes: &[u8], profile_id: &str) -> Result<Vec<String>, AppError> {
    let records: Vec<SessionRecordRef> = serde_json::from_slice(bytes).map_err(|e| {
        AppError::new(
            ErrorCode::Internal,
            format!("{UNREADABLE_SESSIONS_MSG}: {e}"),
        )
    })?;
    Ok(records
        .into_iter()
        .filter(|rec| rec.profile.as_ref().is_some_and(|p| p.id == profile_id))
        .map(|rec| rec.id)
        .collect())
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

    /// pr-142 §6 / FR-10: an unmigratable registry is READ-ONLY, not
    /// unreadable — listing keeps working (that is the whole of "rollback is
    /// read-only access"), and only the mutating commands refuse.
    #[test]
    fn listing_still_works_while_the_registry_is_read_only() {
        let state = registry(false);
        state
            .profiles
            .lock()
            .unwrap()
            .push(testutil::legacy_fixture("p1", "role-a"));
        let listed = list(&state).expect("a read-only registry must still list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id(), "p1");
    }

    // ---------- FR-4: copyToPi's wire shape ----------

    /// contract/session-profiles.ts: `PiSessionProfile.kind: 'pi'` is REQUIRED
    /// — it is the discriminant of the `SessionProfile` union the Profiles
    /// modal switches on. `kind` is the wrapping enum's serde tag, not a field
    /// of the struct, so a bare `PiSessionProfile` reaches the webview with no
    /// `kind` at all. `copy_to_pi` needs an `AppHandle`, which this crate has
    /// no test harness for, so the pin is in two halves: the first line fails
    /// to COMPILE if the command ever answers with the bare struct again, and
    /// the assertions record why that matters on the wire.
    #[test]
    fn copy_to_pi_answers_with_the_tagged_union_so_kind_reaches_the_webview() {
        let _returns_the_tagged_union: fn(
            &AppHandle,
            &ProfileRegistry,
            String,
            String,
            PiProfileSettingsInput,
        ) -> Result<SessionProfile, AppError> = copy_to_pi;

        let tagged = testutil::pi_fixture("p1", "pi-role");
        assert_eq!(serde_json::to_value(&tagged).unwrap()["kind"], "pi");
        let SessionProfile::Pi(bare) = tagged else {
            panic!("pi_fixture must build a Pi profile");
        };
        assert!(
            serde_json::to_value(&bare).unwrap().get("kind").is_none(),
            "the bare struct carries no discriminant — which is why it must never be the wire type"
        );
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

    fn sessions_json(records: serde_json::Value) -> Vec<u8> {
        records.to_string().into_bytes()
    }

    #[test]
    fn sessions_referencing_in_finds_only_matching_sessions() {
        let bytes = sessions_json(json!([
            { "id": "s1", "profile": { "id": "p1", "name": "role-a", "replacesSystemPrompt": false } },
            { "id": "s2", "profile": { "id": "p2", "name": "role-b", "replacesSystemPrompt": true } },
            { "id": "s3" },
        ]));
        assert_eq!(
            sessions_referencing_in(&bytes, "p1").unwrap(),
            vec!["s1".to_string()]
        );
        assert!(sessions_referencing_in(&bytes, "unknown")
            .unwrap()
            .is_empty());
        assert!(sessions_referencing_in(&sessions_json(json!([])), "p1")
            .unwrap()
            .is_empty());
    }

    /// pr-142 §6: the whole point of the typed read. A file this build cannot
    /// parse — corrupt, or written in a shape it does not know — must not
    /// answer "nothing references this profile", because that answer is what
    /// lets a profile still in use be deleted.
    #[test]
    fn sessions_referencing_in_fails_closed_on_anything_it_cannot_read() {
        for (tag, bytes) in [
            ("corrupt", b"{ not json".to_vec()),
            ("not an array", sessions_json(json!({ "sessions": [] }))),
            // the record shape changed: `id` is no longer a plain string
            (
                "record reshaped",
                sessions_json(json!([{ "id": { "value": "s1" } }])),
            ),
            // the profile ref shape changed: a present-but-malformed object is
            // an error, where `Option` alone would only have excused an
            // absent key
            (
                "profile ref reshaped",
                sessions_json(json!([{ "id": "s1", "profile": { "profileId": "p1" } }])),
            ),
        ] {
            let outcome = sessions_referencing_in(&bytes, "p1");
            assert!(outcome.is_err(), "{tag}: must fail closed, got {outcome:?}");
            assert_eq!(outcome.unwrap_err().code, ErrorCode::Internal, "{tag}");
        }
    }
}
