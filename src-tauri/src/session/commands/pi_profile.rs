//! session/commands/pi_profile.rs — pi-migration-rollout FR-2/FR-3/FR-5: the
//! whole `piProfile`/`profileId` resolution decision for `session_create`,
//! pure so every branch is testable without an `AppHandle`/`State` — same
//! "decision here, glue at the call site" split
//! `lifecycle::resolve_profile_ref` (this domain's existing legacy
//! counterpart) already follows.
//!
//! `session/commands/lifecycle.rs` is already over CLAUDE.md's ~1000-line
//! cap (`scripts/quality/oversized-baseline.json`), so this decision lives
//! in its own new module rather than growing that file further.

use crate::profiles::{
    validate_pi_settings, PiProfileSettings, PiProfileSettingsInput, ProfileError, ProfileLookup,
    SessionProfileRef,
};

/// What `session_create`'s Pi branch resolved, ready to snapshot onto the
/// session (`Session.profile` / `Session.pi_profile_settings`). `settings:
/// None` means Pi launches with its own defaults, unrestricted by this
/// mechanism — that is a legitimate creation, not a placeholder for one.
#[derive(Debug, Clone, PartialEq)]
pub struct PiProfileResolution {
    pub profile_ref: Option<SessionProfileRef>,
    pub settings: Option<PiProfileSettings>,
}

/// The three named failure shapes this decision can produce — mapped to
/// `PROFILE_RUNTIME_MISMATCH` / `PROFILE_NOT_FOUND` / the validator's own
/// `INVALID_INPUT`/`PROFILE_ARG_DENIED` at the call site (`ProfileError`
/// already carries a `From<ProfileError> for AppError`, so `Invalid` needs
/// no mapping of its own).
#[derive(Debug)]
pub enum PiProfileError {
    RuntimeMismatch(&'static str),
    NotFound,
    Invalid(ProfileError),
}

/// FR-2/FR-3/FR-5: the decision.
///
/// - Not a Pi account: `piProfile` present is `RuntimeMismatch` (Claude argv
///   must never leak into a Pi launch, and the reverse — a Pi profile
///   selected for another runtime — must never leak either); otherwise this
///   branch does not apply at all (`Ok` with everything `None`) and the
///   caller's existing legacy resolution owns the session.
/// - A Pi account: a non-blank legacy `systemPrompt`, or any `extraArgs`, is
///   `RuntimeMismatch` — those are Claude Code's own passthrough, and a Pi
///   session must never carry them.
/// - `profile_id` given: resolved by `lookup` (`profiles::find_pi` at the
///   call site) — `WrongKind` (a legacy profile) is `RuntimeMismatch`,
///   `NotFound` is `NotFound`. The core snapshots the profile's OWN name,
///   never the caller's claim. `pi_profile_raw`, if ALSO given, is the
///   New Session form's edited creation override (validated the same way
///   as a save); if it is absent, the profile's OWN stored settings are
///   used verbatim (already validated at save time, so not re-validated).
/// - `profile_id` absent: `pi_profile_raw` alone is valid (validated the
///   same way) — `SessionMeta.profile` stays absent, matching a legacy
///   session created with no `profileId`.
pub fn resolve_pi_profile(
    is_pi_account: bool,
    profile_id: Option<&str>,
    pi_profile_raw: Option<PiProfileSettingsInput>,
    legacy_system_prompt_present: bool,
    legacy_extra_args: &[String],
    lookup: impl FnOnce(&str) -> ProfileLookup,
) -> Result<PiProfileResolution, PiProfileError> {
    if !is_pi_account {
        if pi_profile_raw.is_some() {
            return Err(PiProfileError::RuntimeMismatch(
                "piProfile is only valid for a Pi account",
            ));
        }
        return Ok(PiProfileResolution {
            profile_ref: None,
            settings: None,
        });
    }

    // FR-2/FR-4: Claude argv must never leak into a Pi launch.
    if legacy_system_prompt_present || !legacy_extra_args.is_empty() {
        return Err(PiProfileError::RuntimeMismatch(
            "systemPrompt and extraArgs are not valid for a Pi account",
        ));
    }

    let found_profile = match profile_id {
        Some(id) => match lookup(id) {
            ProfileLookup::Found(p) => Some(p),
            ProfileLookup::WrongKind => {
                return Err(PiProfileError::RuntimeMismatch(
                    "that profile is not a Pi profile",
                ))
            }
            ProfileLookup::NotFound => return Err(PiProfileError::NotFound),
        },
        None => None,
    };

    let settings = match pi_profile_raw {
        Some(raw) => Some(validate_pi_settings(raw).map_err(PiProfileError::Invalid)?),
        // With `profileId` and no override: the SAVED settings, already
        // validated once at save time. With neither: no Pi profile at all.
        None => found_profile.as_ref().map(|p| p.settings.clone()),
    };

    // FR-16-style identity snapshot: name comes from the CORE's own lookup,
    // never the caller. `replacesSystemPrompt` mirrors the legacy ref's own
    // meaning (`resolve_profile_ref`) for the property that plays the same
    // role in a Pi profile — whether the resolved settings actually replace
    // Pi's own prompt.
    let profile_ref = found_profile.map(|p| SessionProfileRef {
        id: p.id,
        name: p.name,
        replaces_system_prompt: settings
            .as_ref()
            .is_some_and(|s| s.system_prompt_mode == crate::profiles::PiSystemPromptMode::Replace),
    });

    Ok(PiProfileResolution {
        profile_ref,
        settings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{PiProjectResources, PiSessionProfile, PiSystemPromptMode};

    fn raw(mode: &str) -> PiProfileSettingsInput {
        PiProfileSettingsInput {
            system_prompt_mode: mode.into(),
            system_prompt: None,
            instruction_paths: Vec::new(),
            skill_paths: Vec::new(),
            tools: Vec::new(),
            project_resources: "ignore".into(),
        }
    }

    fn stored_pi_profile(id: &str, name: &str) -> PiSessionProfile {
        PiSessionProfile {
            id: id.into(),
            name: name.into(),
            settings: PiProfileSettings {
                system_prompt_mode: PiSystemPromptMode::Default,
                system_prompt: None,
                instruction_paths: Vec::new(),
                skill_paths: Vec::new(),
                tools: Vec::new(),
                project_resources: PiProjectResources::Ignore,
            },
            created_at: 0,
            updated_at: 0,
        }
    }

    fn no_lookup(_id: &str) -> ProfileLookup {
        panic!("lookup must not be called when no profileId was given")
    }

    #[test]
    fn a_non_pi_account_with_a_pi_profile_is_a_runtime_mismatch() {
        let err = resolve_pi_profile(false, None, Some(raw("default")), false, &[], no_lookup)
            .expect_err("mismatch");
        assert!(matches!(err, PiProfileError::RuntimeMismatch(_)));
    }

    #[test]
    fn a_non_pi_account_with_no_pi_profile_is_not_this_branchs_concern() {
        let out = resolve_pi_profile(false, None, None, true, &["--add-dir".into()], no_lookup)
            .expect("not applicable");
        assert_eq!(
            out,
            PiProfileResolution {
                profile_ref: None,
                settings: None
            }
        );
    }

    #[test]
    fn a_pi_account_with_a_legacy_system_prompt_is_a_runtime_mismatch() {
        let err = resolve_pi_profile(true, None, None, true, &[], no_lookup).expect_err("mismatch");
        assert!(matches!(err, PiProfileError::RuntimeMismatch(_)));
    }

    #[test]
    fn a_pi_account_with_legacy_extra_args_is_a_runtime_mismatch() {
        let err = resolve_pi_profile(true, None, None, false, &["--mcp-config".into()], no_lookup)
            .expect_err("mismatch");
        assert!(matches!(err, PiProfileError::RuntimeMismatch(_)));
    }

    #[test]
    fn without_a_profile_id_a_pi_profile_alone_is_valid_and_carries_no_ref() {
        let out = resolve_pi_profile(true, None, Some(raw("default")), false, &[], no_lookup)
            .expect("valid");
        assert!(out.profile_ref.is_none());
        assert!(out.settings.is_some());
    }

    #[test]
    fn without_a_profile_id_or_a_pi_profile_the_session_carries_neither() {
        let out =
            resolve_pi_profile(true, None, None, false, &[], no_lookup).expect("valid, no profile");
        assert_eq!(
            out,
            PiProfileResolution {
                profile_ref: None,
                settings: None
            }
        );
    }

    #[test]
    fn a_profile_id_resolving_to_a_legacy_profile_is_a_runtime_mismatch() {
        let err = resolve_pi_profile(true, Some("legacy-1"), None, false, &[], |_| {
            ProfileLookup::WrongKind
        })
        .expect_err("mismatch");
        assert!(matches!(err, PiProfileError::RuntimeMismatch(_)));
    }

    #[test]
    fn an_unresolvable_profile_id_is_not_found() {
        let err = resolve_pi_profile(true, Some("gone"), None, false, &[], |_| {
            ProfileLookup::NotFound
        })
        .expect_err("not found");
        assert!(matches!(err, PiProfileError::NotFound));
    }

    #[test]
    fn a_profile_id_with_no_override_uses_the_saved_settings_and_snapshots_the_core_name() {
        let stored = stored_pi_profile("pi-1", "reviewer");
        let out = resolve_pi_profile(true, Some("pi-1"), None, false, &[], |id| {
            assert_eq!(id, "pi-1");
            ProfileLookup::Found(stored.clone())
        })
        .expect("valid");
        let profile_ref = out.profile_ref.expect("ref");
        assert_eq!(profile_ref.id, "pi-1");
        assert_eq!(profile_ref.name, "reviewer");
        assert_eq!(out.settings, Some(stored.settings));
    }

    #[test]
    fn a_profile_id_with_an_override_validates_and_uses_the_override_not_the_saved_settings() {
        let stored = stored_pi_profile("pi-1", "reviewer");
        let mut override_raw = raw("replace");
        override_raw.system_prompt = Some("be terse".into());
        let out = resolve_pi_profile(true, Some("pi-1"), Some(override_raw), false, &[], |_| {
            ProfileLookup::Found(stored.clone())
        })
        .expect("valid");
        let settings = out.settings.expect("override settings");
        assert_eq!(settings.system_prompt_mode, PiSystemPromptMode::Replace);
        assert_eq!(settings.system_prompt.as_deref(), Some("be terse"));
        // The ref still snapshots the CORE's own name, never the caller's.
        assert_eq!(out.profile_ref.unwrap().name, "reviewer");
    }

    #[test]
    fn an_invalid_override_refuses_before_ever_touching_the_lookup_result() {
        let stored = stored_pi_profile("pi-1", "reviewer");
        let mut bad = raw("replace");
        bad.system_prompt = None; // replace mode requires a prompt
        let err = resolve_pi_profile(true, Some("pi-1"), Some(bad), false, &[], |_| {
            ProfileLookup::Found(stored.clone())
        })
        .expect_err("invalid override");
        assert!(matches!(err, PiProfileError::Invalid(_)));
    }

    #[test]
    fn replace_mode_marks_the_ref_as_replacing_the_system_prompt() {
        let stored = stored_pi_profile("pi-1", "reviewer");
        let mut override_raw = raw("replace");
        override_raw.system_prompt = Some("be terse".into());
        let out = resolve_pi_profile(true, Some("pi-1"), Some(override_raw), false, &[], |_| {
            ProfileLookup::Found(stored.clone())
        })
        .expect("valid");
        assert!(out.profile_ref.unwrap().replaces_system_prompt);
    }
}
