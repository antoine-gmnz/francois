//! FR-1..FR-8: profiles.json, validation, ordering, cross-domain lookups.
//! pi-migration-rollout FR-2/FR-6 amends this for the runtime-tagged union
//! and the versioned migration (`migration.rs`).

use super::*;

use crate::ipc::{AppError, ErrorCode};

use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// ---------- FR-3/FR-6: validation ----------

/// FR-3: `name` is trimmed, 1..=MAX_PROFILE_NAME chars — counted as Unicode
/// scalar values, never bytes (a 60-emoji name is 60 characters).
pub fn validate_name(raw: &str) -> Result<String, &'static str> {
    let name = raw.trim().to_string();
    if name.is_empty() || name.chars().count() > MAX_PROFILE_NAME {
        return Err(BAD_NAME_MSG);
    }
    Ok(name)
}

/// Edge case §7: a `systemPrompt` present but whitespace-only is treated as
/// absent — no `--system-prompt`, `replacesSystemPrompt: false`. Bounds are
/// checked against the ORIGINAL text (FR-6), so an over-cap prompt of only
/// whitespace still refuses rather than silently vanishing.
pub fn normalize_prompt(raw: Option<String>) -> Result<Option<String>, &'static str> {
    let Some(text) = raw else {
        return Ok(None);
    };
    if text.chars().count() > MAX_SYSTEM_PROMPT {
        return Err(BAD_PROMPT_MSG);
    }
    if text.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(text))
}

/// FR-6: `extraArgsRaw` bound check, kept as a separate step so `build_profile`
/// can validate BEFORE parsing (an over-cap string need never be tokenized).
/// A whitespace-only raw string normalizes to "nothing typed" (None), the same
/// convention as `normalize_prompt`.
fn normalize_extra_args_raw(raw: Option<String>) -> Result<Option<String>, &'static str> {
    let Some(text) = raw else {
        return Ok(None);
    };
    if text.chars().count() > MAX_EXTRA_ARGS_RAW {
        return Err(BAD_EXTRA_ARGS_MSG);
    }
    if text.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(text))
}

/// What a validation failure looks like at the command layer: an
/// `INVALID_INPUT` (bounds, unterminated quote, a Pi settings rule) or a
/// `PROFILE_ARG_DENIED` carrying the named `{ flag, reason }` (FR-9).
#[derive(Debug)]
pub enum ProfileError {
    InvalidInput(&'static str),
    ArgDenied { flag: String, reason: &'static str },
}

// core-architecture-wave3 FR-6: the typed domain error carries its own codes
// (and, for ArgDenied, the contract's `{ flag, reason }` detail) into the one
// error type every command body converts from. The command surface no longer
// needs a hand-written mapper.
impl From<ProfileError> for AppError {
    fn from(e: ProfileError) -> Self {
        match e {
            ProfileError::InvalidInput(msg) => AppError::new(ErrorCode::InvalidInput, msg),
            ProfileError::ArgDenied { flag, reason } => AppError::with_detail(
                ErrorCode::ProfileArgDenied,
                format!("{flag} is not allowed in a profile's extra args: {reason}"),
                serde_json::json!({ "flag": flag, "reason": reason }),
            ),
        }
    }
}

/// FR-6/FR-7/FR-9: the whole create/update decision — validate, parse
/// `extraArgsRaw`, re-check the denylist — kept pure so it is unit-testable
/// without a Tauri AppHandle. `id`/`created_at` are carried through unchanged
/// by `:update` (FR-5); `:create` mints fresh ones at the call site.
pub fn build_profile(
    id: String,
    name: &str,
    system_prompt: Option<String>,
    extra_args_raw: Option<String>,
    created_at: u64,
    updated_at: u64,
) -> Result<LegacySessionProfile, ProfileError> {
    let name = validate_name(name).map_err(ProfileError::InvalidInput)?;
    let system_prompt = normalize_prompt(system_prompt).map_err(ProfileError::InvalidInput)?;
    let extra_args_raw =
        normalize_extra_args_raw(extra_args_raw).map_err(ProfileError::InvalidInput)?;
    let extra_args = match &extra_args_raw {
        Some(raw) => {
            let tokens = parse_extra_args(raw)
                .map_err(|_| ProfileError::InvalidInput(UNTERMINATED_QUOTE_MSG))?;
            if let Some((flag, reason)) = check_denied(&tokens) {
                return Err(ProfileError::ArgDenied { flag, reason });
            }
            if tokens.is_empty() {
                None
            } else {
                Some(tokens)
            }
        }
        None => None,
    };
    Ok(LegacySessionProfile {
        id,
        name,
        system_prompt,
        extra_args_raw,
        extra_args,
        created_at,
        updated_at,
    })
}

// ---------- FR-4: listing ----------

/// FR-4: `name` ascending, case-insensitive, ties broken by `id` for
/// stability.
pub fn list_ordered(profiles: &[SessionProfile]) -> Vec<SessionProfile> {
    let mut out = profiles.to_vec();
    out.sort_by(|a, b| {
        a.name()
            .to_lowercase()
            .cmp(&b.name().to_lowercase())
            .then_with(|| a.id().cmp(b.id()))
    });
    out
}

// ---------- FR-5: update ----------

pub fn find_index(profiles: &[SessionProfile], id: &str) -> Option<usize> {
    profiles.iter().position(|p| p.id() == id)
}

// ---------- FR-1: persistence ----------

pub fn profiles_json_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("profiles.json"))
}

/// The result of reading profiles.json: the entries this build understands,
/// PLUS every entry it does not (pi-migration-rollout FR-6) — preserved
/// verbatim so a later `save_to` can write them straight back out.
#[derive(Default, Clone, Debug, PartialEq)]
pub struct ParsedRegistry {
    pub profiles: Vec<SessionProfile>,
    pub unknown: Vec<Value>,
}

/// An entry is only ever placed in `unknown` when it EXPLICITLY carries a
/// `kind` this build does not recognize — a missing `kind` still means
/// `legacy` (FR-2), and a genuinely malformed entry (no `id`, not even an
/// object) is skipped exactly as before this feature: it is not recoverable
/// data, so there is nothing to preserve.
pub fn parse_registry(bytes: &[u8]) -> ParsedRegistry {
    let Ok(doc) = serde_json::from_slice::<Value>(bytes) else {
        return ParsedRegistry::default();
    };
    let Some(list) = doc.get("profiles").and_then(|v| v.as_array()) else {
        return ParsedRegistry::default();
    };

    let mut profiles = Vec::new();
    let mut unknown = Vec::new();
    for entry in list {
        let kind = entry.get("kind").and_then(Value::as_str);
        match kind {
            None | Some("legacy") | Some("pi") => {
                let normalized = normalize_entry_kind_for_parse(entry.clone());
                if let Ok(p) = serde_json::from_value::<SessionProfile>(normalized) {
                    profiles.push(p);
                }
                // else: a recognized (or absent) kind but genuinely
                // undeserializable entry — skipped, matching the pre-existing
                // "one bad entry does not sink the registry" tolerance.
            }
            Some(_unrecognized) => unknown.push(entry.clone()),
        }
    }
    ParsedRegistry { profiles, unknown }
}

/// `serde`'s internally tagged `SessionProfile` requires the `kind` field to
/// be PRESENT to pick a variant — an entry saved before this feature has
/// none at all, so a missing `kind` is defaulted to `"legacy"` here, at read
/// time, exactly mirroring what `migration.rs` writes back to disk (FR-2).
fn normalize_entry_kind_for_parse(mut entry: Value) -> Value {
    if let Value::Object(map) = &mut entry {
        map.entry("kind".to_string())
            .or_insert_with(|| Value::String("legacy".to_string()));
    }
    entry
}

pub fn load_from(path: &Path) -> ParsedRegistry {
    std::fs::read(path)
        .map(|b| parse_registry(&b))
        .unwrap_or_default()
}

/// FR-1: `{ "version": PROFILE_SCHEMA_VERSION, "profiles": […known, …unknown] }`,
/// written atomically through the same helper permission-guardrails/project
/// use — a write failure must never leave memory and disk disagreeing. Every
/// `unknown` entry rides along UNTOUCHED (FR-6): this is the only place a
/// mutation ever reaches the file, so an entry this build cannot interpret
/// must survive every one of them.
pub fn save_to(
    path: &Path,
    profiles: &[SessionProfile],
    unknown: &[Value],
) -> Result<(), AppError> {
    let mut entries: Vec<Value> = profiles
        .iter()
        .map(|p| serde_json::to_value(p).unwrap_or(Value::Null))
        .collect();
    entries.extend(unknown.iter().cloned());
    let doc = serde_json::json!({ "version": PROFILE_SCHEMA_VERSION, "profiles": entries });
    crate::permissions::write_json_atomic(path, &doc)
}

pub fn persist_registry(
    app: &AppHandle,
    profiles: &[SessionProfile],
    unknown: &[Value],
) -> Result<(), AppError> {
    let path = profiles_json_path(app).ok_or_else(|| {
        AppError::new(
            ErrorCode::Internal,
            "could not resolve the app data directory",
        )
    })?;
    save_to(&path, profiles, unknown)
}

/// Load the registry once, at startup. pi-migration-rollout FR-6: runs the
/// versioned migration FIRST — a schema this build cannot safely rewrite
/// (`MigrationOutcome::FutureSchema`/`Failed`) leaves the in-memory registry
/// EMPTY and unwritable rather than guessing at a partial read, so every
/// `profiles_*` command refuses cleanly instead of risking a later write that
/// would drop what it could not parse.
pub fn load_profiles(app: &AppHandle) {
    let Some(path) = profiles_json_path(app) else {
        return;
    };
    let outcome = migrate_registry(&path);
    let Some(state) = app.try_state::<ProfileRegistry>() else {
        return;
    };
    if !outcome.is_writable() {
        *state.profiles.lock().unwrap() = Vec::new();
        *state.unknown.lock().unwrap() = Vec::new();
        *state.writable.lock().unwrap() = false;
        match &outcome {
            MigrationOutcome::Failed(msg) => {
                eprintln!("profiles: migration failed, profiles.json left untouched: {msg}");
            }
            MigrationOutcome::FutureSchema(v) => {
                eprintln!(
                    "profiles: profiles.json is schema v{v}, newer than this build (v{PROFILE_SCHEMA_VERSION}) supports — left untouched"
                );
            }
            _ => unreachable!(),
        }
        return;
    }
    let parsed = load_from(&path);
    *state.profiles.lock().unwrap() = parsed.profiles;
    *state.unknown.lock().unwrap() = parsed.unknown;
    *state.writable.lock().unwrap() = true;
}

/// Every profile id currently in the registry, of ANY kind. Mirrors
/// `account::known_ids`. An EMPTY set is ambiguous — `parse_registry` also
/// yields nothing for a corrupt or unreadable profiles.json — so callers
/// that use this to invalidate references must treat empty as "unknown",
/// never as "none exist".
pub fn known_ids(app: &AppHandle) -> std::collections::HashSet<String> {
    app.try_state::<ProfileRegistry>()
        .map(|s| {
            s.profiles
                .lock()
                .unwrap()
                .iter()
                .map(|p| p.id().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether the registry is currently safe to mutate/list (FR-6) — `false`
/// only while a migration could not be trusted; see `load_profiles`.
pub(crate) fn is_writable(state: &ProfileRegistry) -> bool {
    *state.writable.lock().unwrap()
}

// ---------- FR-15: session-create snapshot lookup ----------

/// The LEGACY profile a `session_create` `profileId` names, or `None` when it
/// does not resolve OR resolves to a non-legacy entry. `session_create`'s
/// pre-piProfile path only ever spawns Claude Code, so (until wave 2 wires
/// `PROFILE_RUNTIME_MISMATCH` into that resolution) a Pi-kind id reads
/// exactly like an unknown one here — see `find_pi` for the Pi counterpart.
pub fn find(app: &AppHandle, id: &str) -> Option<LegacySessionProfile> {
    let state = app.try_state::<ProfileRegistry>()?;
    let profiles = state.profiles.lock().ok()?;
    profiles.iter().find_map(|p| match p {
        SessionProfile::Legacy(l) if l.id == id => Some(l.clone()),
        _ => None,
    })
}

/// pi-migration-rollout: resolve `id` to a stored PI profile, distinguishing
/// "not in the registry at all" from "in the registry but the wrong kind" —
/// the two contract errors differ (PROFILE_NOT_FOUND vs.
/// PROFILE_RUNTIME_MISMATCH, §5/§7). `session_create`'s `piProfile`
/// resolution (`session::commands::pi_profile::resolve_pi_profile`) maps
/// each arm directly.
pub fn find_pi(app: &AppHandle, id: &str) -> ProfileLookup {
    let Some(state) = app.try_state::<ProfileRegistry>() else {
        return ProfileLookup::NotFound;
    };
    let Ok(profiles) = state.profiles.lock() else {
        return ProfileLookup::NotFound;
    };
    match profiles.iter().find(|p| p.id() == id) {
        None => ProfileLookup::NotFound,
        Some(SessionProfile::Pi(p)) => ProfileLookup::Found(p.clone()),
        Some(SessionProfile::Legacy(_)) => ProfileLookup::WrongKind,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProfileLookup {
    NotFound,
    WrongKind,
    Found(PiSessionProfile),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::testutil::*;
    use serde_json::json;

    // ---------- FR-3: name validation ----------

    #[test]
    fn name_is_trimmed_and_bounded() {
        assert_eq!(
            validate_name("  agent-architect  ").unwrap(),
            "agent-architect"
        );
        assert!(validate_name("   ").is_err());
        assert!(validate_name(&"x".repeat(60)).is_ok());
        assert!(validate_name(&"x".repeat(61)).is_err());
    }

    // ---------- edge case §7: whitespace-only prompt ----------

    #[test]
    fn a_whitespace_only_prompt_normalizes_to_absent() {
        assert_eq!(normalize_prompt(None).unwrap(), None);
        assert_eq!(normalize_prompt(Some("   \n\t ".into())).unwrap(), None);
        assert_eq!(
            normalize_prompt(Some("  be terse  ".into())).unwrap(),
            Some("  be terse  ".to_string())
        );
    }

    #[test]
    fn an_over_cap_prompt_is_rejected_even_if_whitespace_only() {
        let over = " ".repeat(MAX_SYSTEM_PROMPT + 1);
        assert_eq!(normalize_prompt(Some(over)), Err(BAD_PROMPT_MSG));
        assert!(normalize_prompt(Some("x".repeat(MAX_SYSTEM_PROMPT))).is_ok());
        assert!(normalize_prompt(Some("x".repeat(MAX_SYSTEM_PROMPT + 1))).is_err());
    }

    // ---------- FR-6/FR-7/FR-9: build_profile ----------

    #[test]
    fn build_profile_denies_a_flag_and_writes_nothing() {
        // §9 acceptance: refused inline, naming the flag and the reason.
        let err = build_profile(
            "id1".into(),
            "role",
            None,
            Some("--model opus".into()),
            0,
            0,
        )
        .expect_err("denied");
        match err {
            ProfileError::ArgDenied { flag, reason } => {
                assert_eq!(flag, "--model");
                assert!(!reason.is_empty());
            }
            _ => panic!("expected ArgDenied"),
        }
    }

    #[test]
    fn build_profile_accepts_an_unmodelled_flag() {
        // §9 acceptance: --add-dir /tmp succeeds.
        let p = build_profile(
            "id1".into(),
            "role",
            None,
            Some("--add-dir /tmp".into()),
            0,
            0,
        )
        .expect("accepted");
        assert_eq!(
            p.extra_args.as_deref(),
            Some(&["--add-dir".to_string(), "/tmp".to_string()][..])
        );
        assert_eq!(p.extra_args_raw.as_deref(), Some("--add-dir /tmp"));
    }

    #[test]
    fn extra_args_raw_round_trips_and_resolves_to_three_tokens() {
        // §9 acceptance verbatim.
        let p = build_profile(
            "id1".into(),
            "role",
            None,
            Some(r#"--add-dir "/a b" --foo"#.into()),
            0,
            0,
        )
        .expect("accepted");
        assert_eq!(
            p.extra_args_raw.as_deref(),
            Some(r#"--add-dir "/a b" --foo"#)
        );
        assert_eq!(p.extra_args.unwrap().len(), 3);
    }

    #[test]
    fn build_profile_rejects_an_unterminated_quote() {
        let err = build_profile(
            "id1".into(),
            "role",
            None,
            Some(r#"--add-dir "/a b"#.into()),
            0,
            0,
        )
        .expect_err("invalid");
        assert!(matches!(err, ProfileError::InvalidInput(_)));
    }

    #[test]
    fn build_profile_rejects_bad_bounds_and_writes_nothing() {
        assert!(matches!(
            build_profile("id1".into(), "   ", None, None, 0, 0).err(),
            Some(ProfileError::InvalidInput(_))
        ));
    }

    // ---------- FR-4: ordering ----------

    #[test]
    fn listing_orders_by_name_case_insensitive_then_id() {
        let profiles = vec![
            legacy_fixture("z1", "Zulu"),
            legacy_fixture("a2", "alpha"),
            legacy_fixture("a1", "Alpha"), // ties with a2 on name, breaks on id
            legacy_fixture("m1", "mike"),
        ];
        let ordered = list_ordered(&profiles);
        assert_eq!(
            ordered.iter().map(|p| p.id()).collect::<Vec<_>>(),
            vec!["a1", "a2", "m1", "z1"]
        );
    }

    #[test]
    fn ordering_mixes_legacy_and_pi_by_name_alone() {
        let profiles = vec![legacy_fixture("l1", "zulu"), pi_fixture("p1", "alpha")];
        let ordered = list_ordered(&profiles);
        assert_eq!(
            ordered.iter().map(|p| p.id()).collect::<Vec<_>>(),
            vec!["p1", "l1"]
        );
    }

    // ---------- FR-1/FR-3: persistence tolerance ----------

    #[test]
    fn a_missing_empty_or_corrupt_registry_loads_as_empty() {
        let dir = tmp_root("tolerant");
        assert!(load_from(&dir.join("nope.json")).profiles.is_empty());
        assert!(parse_registry(b"").profiles.is_empty());
        assert!(parse_registry(b"{ not json").profiles.is_empty());
        assert!(
            parse_registry(b"[]").profiles.is_empty(),
            "the array shape is not ours"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_undeserializable_entry_is_skipped_not_fatal() {
        let doc = json!({
            "version": 1,
            "profiles": [
                { "id": "p1", "name": "keep", "createdAt": 1, "updatedAt": 2 },
                { "name": "no id at all" },
                "not even an object",
            ]
        });
        let parsed = parse_registry(doc.to_string().as_bytes());
        assert_eq!(
            parsed.profiles.iter().map(|p| p.id()).collect::<Vec<_>>(),
            vec!["p1"]
        );
        assert!(parsed.unknown.is_empty());
    }

    #[test]
    fn a_missing_kind_loads_as_legacy_with_its_fields_unchanged() {
        // FR-2: a pre-feature entry (no `kind` at all) must load as legacy.
        let doc = json!({
            "version": 1,
            "profiles": [
                { "id": "p1", "name": "role-a", "systemPrompt": "be terse", "createdAt": 1, "updatedAt": 2 },
            ]
        });
        let parsed = parse_registry(doc.to_string().as_bytes());
        assert_eq!(parsed.profiles.len(), 1);
        match &parsed.profiles[0] {
            SessionProfile::Legacy(l) => {
                assert_eq!(l.id, "p1");
                assert_eq!(l.system_prompt.as_deref(), Some("be terse"));
            }
            other => panic!("expected Legacy, got {other:?}"),
        }
    }

    #[test]
    fn an_unrecognized_kind_is_preserved_and_omitted_from_the_typed_list() {
        let doc = json!({
            "version": 2,
            "profiles": [
                { "id": "p1", "name": "keep", "kind": "legacy", "createdAt": 1, "updatedAt": 2 },
                { "id": "p2", "name": "future", "kind": "grok", "someField": true },
            ]
        });
        let parsed = parse_registry(doc.to_string().as_bytes());
        assert_eq!(
            parsed.profiles.iter().map(|p| p.id()).collect::<Vec<_>>(),
            vec!["p1"]
        );
        assert_eq!(parsed.unknown.len(), 1);
        assert_eq!(parsed.unknown[0]["id"], "p2");
        assert_eq!(parsed.unknown[0]["someField"], true);
    }

    #[test]
    fn the_registry_round_trips_and_omits_absent_fields() {
        let dir = tmp_root("roundtrip");
        let path = dir.join("profiles.json");
        let profiles = vec![
            legacy_fixture("p1", "role-a"),
            legacy_fixture("p2", "role-b"),
        ];
        save_to(&path, &profiles, &[]).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let doc: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(doc["version"], PROFILE_SCHEMA_VERSION);
        assert!(
            !raw.contains("systemPrompt"),
            "an unset field is omitted, never null"
        );
        assert_eq!(load_from(&path).profiles, profiles);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_pi_profile_round_trips_with_its_kind_tag() {
        let dir = tmp_root("pi-roundtrip");
        let path = dir.join("profiles.json");
        let profiles = vec![pi_fixture("pi1", "reviewer")];
        save_to(&path, &profiles, &[]).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"kind\": \"pi\""));
        assert_eq!(load_from(&path).profiles, profiles);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_to_carries_unknown_entries_through_untouched() {
        let dir = tmp_root("unknown-roundtrip");
        let path = dir.join("profiles.json");
        let unknown = vec![json!({ "id": "p2", "kind": "grok", "someField": 42 })];
        save_to(&path, &[legacy_fixture("p1", "role-a")], &unknown).unwrap();

        let parsed = load_from(&path);
        assert_eq!(parsed.profiles.len(), 1);
        assert_eq!(parsed.unknown, unknown);
        std::fs::remove_dir_all(&dir).ok();
    }
}
