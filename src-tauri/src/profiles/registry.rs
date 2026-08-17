//! FR-1..FR-8: profiles.json, validation, ordering, cross-domain lookups.

use super::*;

use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// ---------- FR-3/FR-6: validation ----------

/// FR-3: `name` is trimmed, 1..=MAX_PROFILE_NAME chars — counted as Unicode
/// scalar values, never bytes (a 60-emoji name is 60 characters).
pub(crate) fn validate_name(raw: &str) -> Result<String, &'static str> {
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
pub(crate) fn normalize_prompt(raw: Option<String>) -> Result<Option<String>, &'static str> {
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
/// `INVALID_INPUT` (bounds, unterminated quote) or a `PROFILE_ARG_DENIED`
/// carrying the named `{ flag, reason }` (FR-9).
pub(crate) enum ProfileError {
    InvalidInput(&'static str),
    ArgDenied { flag: String, reason: &'static str },
}

/// FR-6/FR-7/FR-9: the whole create/update decision — validate, parse
/// `extraArgsRaw`, re-check the denylist — kept pure so it is unit-testable
/// without a Tauri AppHandle. `id`/`created_at` are carried through unchanged
/// by `:update` (FR-5); `:create` mints fresh ones at the call site.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_profile(
    id: String,
    name: &str,
    system_prompt: Option<String>,
    model_id: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    extra_args_raw: Option<String>,
    created_at: u64,
    updated_at: u64,
) -> Result<SessionProfile, ProfileError> {
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
    Ok(SessionProfile {
        id,
        name,
        system_prompt,
        model_id: model_id.filter(|m| !m.trim().is_empty()),
        effort: effort.filter(|e| !e.trim().is_empty()),
        permission_mode: permission_mode.filter(|m| !m.trim().is_empty()),
        extra_args_raw,
        extra_args,
        created_at,
        updated_at,
    })
}

// ---------- FR-4: listing ----------

/// FR-4: `name` ascending, case-insensitive, ties broken by `id` for
/// stability.
pub(crate) fn list_ordered(profiles: &[SessionProfile]) -> Vec<SessionProfile> {
    let mut out = profiles.to_vec();
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

// ---------- FR-5: update ----------

pub(crate) fn find_index(profiles: &[SessionProfile], id: &str) -> Option<usize> {
    profiles.iter().position(|p| p.id == id)
}

// ---------- FR-1: persistence ----------

pub(crate) fn profiles_json_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("profiles.json"))
}

/// A missing, empty or unparseable document yields an EMPTY registry (FR-4);
/// a single undeserializable entry is skipped, not fatal — the same tolerance
/// `project::parse_registry` applies.
pub(crate) fn parse_registry(bytes: &[u8]) -> Vec<SessionProfile> {
    let Ok(doc) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    let Some(list) = doc.get("profiles").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|entry| serde_json::from_value::<SessionProfile>(entry.clone()).ok())
        .collect()
}

pub(crate) fn load_from(path: &Path) -> Vec<SessionProfile> {
    std::fs::read(path)
        .map(|b| parse_registry(&b))
        .unwrap_or_default()
}

/// FR-1: `{ "version": 1, "profiles": [ … ] }`, written atomically through the
/// same helper permission-guardrails/project use — a write failure must never
/// leave memory and disk disagreeing.
pub(crate) fn save_to(path: &Path, profiles: &[SessionProfile]) -> Result<(), String> {
    let doc = serde_json::json!({ "version": 1, "profiles": profiles });
    crate::permissions::write_json_atomic(path, &doc)
}

pub(crate) fn persist_registry(app: &AppHandle, profiles: &[SessionProfile]) -> Result<(), String> {
    let path = profiles_json_path(app)
        .ok_or_else(|| "could not resolve the app data directory".to_string())?;
    save_to(&path, profiles)
}

/// Load the registry once, at startup.
pub fn load_profiles(app: &AppHandle) {
    let Some(path) = profiles_json_path(app) else {
        return;
    };
    let loaded = load_from(&path);
    if let Some(state) = app.try_state::<ProfileRegistry>() {
        *state.profiles.lock().unwrap() = loaded;
    }
}

// ---------- FR-15: session-create snapshot lookup ----------

/// The profile a `session_create` `profileId` names, or `None` when it does
/// not resolve (`PROFILE_NOT_FOUND` at the call site).
pub fn find(app: &AppHandle, id: &str) -> Option<SessionProfile> {
    let state = app.try_state::<ProfileRegistry>()?;
    let profiles = state.profiles.lock().ok()?;
    profiles.iter().find(|p| p.id == id).cloned()
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
            None,
            None,
            None,
            Some("--model opus".into()),
            0,
            0,
        )
        .err()
        .expect("denied");
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
            None,
            None,
            None,
            Some("--add-dir /tmp".into()),
            0,
            0,
        )
        .ok()
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
            None,
            None,
            None,
            Some(r#"--add-dir "/a b" --foo"#.into()),
            0,
            0,
        )
        .ok()
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
            None,
            None,
            None,
            Some(r#"--add-dir "/a b"#.into()),
            0,
            0,
        )
        .err()
        .expect("invalid");
        assert!(matches!(err, ProfileError::InvalidInput(_)));
    }

    #[test]
    fn build_profile_rejects_bad_bounds_and_writes_nothing() {
        assert!(matches!(
            build_profile("id1".into(), "   ", None, None, None, None, None, 0, 0).err(),
            Some(ProfileError::InvalidInput(_))
        ));
    }

    // ---------- FR-4: ordering ----------

    #[test]
    fn listing_orders_by_name_case_insensitive_then_id() {
        let profiles = vec![
            fixture("z1", "Zulu"),
            fixture("a2", "alpha"),
            fixture("a1", "Alpha"), // ties with a2 on name, breaks on id
            fixture("m1", "mike"),
        ];
        let ordered = list_ordered(&profiles);
        assert_eq!(
            ordered.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["a1", "a2", "m1", "z1"]
        );
    }

    // ---------- FR-1/FR-3: persistence tolerance ----------

    #[test]
    fn a_missing_empty_or_corrupt_registry_loads_as_empty() {
        let dir = tmp_root("tolerant");
        assert!(load_from(&dir.join("nope.json")).is_empty());
        assert!(parse_registry(b"").is_empty());
        assert!(parse_registry(b"{ not json").is_empty());
        assert!(
            parse_registry(b"[]").is_empty(),
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
        let loaded = parse_registry(doc.to_string().as_bytes());
        assert_eq!(
            loaded.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["p1"]
        );
    }

    #[test]
    fn the_registry_round_trips_and_omits_absent_fields() {
        let dir = tmp_root("roundtrip");
        let path = dir.join("profiles.json");
        let profiles = vec![fixture("p1", "role-a"), fixture("p2", "role-b")];
        save_to(&path, &profiles).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let doc: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(doc["version"], 1);
        assert!(
            !raw.contains("systemPrompt"),
            "an unset field is omitted, never null"
        );
        assert_eq!(load_from(&path), profiles);
        std::fs::remove_dir_all(&dir).ok();
    }
}
