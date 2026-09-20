//! pi-migration-rollout FR-5: `PiProfileSettings` validation — the
//! mode/prompt rule, path shape/bounds, and the certified built-in tool
//! allowlist. Kept pure of Tauri (no `AppHandle`/`State`) so it is
//! unit-testable the same way `registry::build_profile` is.
//!
//! Inputs arrive from the frontend as plain strings (never a pre-parsed
//! enum) — the same reason every OTHER command in this crate takes raw
//! `String`/`Option<String>` args rather than a struct matching the
//! contract's union member: a bad enum spelling must resolve to a named
//! `INVALID_INPUT`, not an opaque Tauri deserialization failure that never
//! reaches this domain's `Result<T, AppError>` path at all.

use super::{
    PiBuiltinTool, PiProfileSettings, PiProjectResources, PiSystemPromptMode, ProfileError,
    MAX_PI_INSTRUCTION_PATHS, MAX_PI_SKILL_PATHS, MAX_SYSTEM_PROMPT,
};
use serde::Deserialize;
use std::path::Path;

pub const BAD_PI_MODE_MSG: &str = "systemPromptMode must be default, append or replace";
pub const BAD_PI_PROMPT_REQUIRED_MSG: &str =
    "a system prompt is required for append or replace mode";
pub const BAD_PI_PROMPT_FOR_DEFAULT_MSG: &str = "a system prompt is not allowed in default mode";
pub const BAD_PI_INSTRUCTION_COUNT_MSG: &str = "at most 20 instruction paths are allowed";
pub const BAD_PI_INSTRUCTION_PATH_MSG: &str = "instruction paths must be absolute";
pub const MISSING_PI_INSTRUCTION_PATH_MSG: &str = "an instruction path does not exist as a file";
pub const BAD_PI_SKILL_COUNT_MSG: &str = "at most 50 skill paths are allowed";
pub const BAD_PI_SKILL_PATH_MSG: &str = "skill paths must be absolute";
pub const BAD_PI_TOOL_MSG: &str = "an unknown tool name was given";
pub const BAD_PI_RESOURCES_MSG: &str = "projectResources must be ignore or allow";
pub const MISSING_PI_SETTINGS_MSG: &str = "settings are required for a pi profile";

/// The wire shape of `PiProfileSettings` as it arrives from the frontend —
/// every field a raw `String`/`Vec<String>` so an unrecognized value gets
/// OUR named `INVALID_INPUT`, never a generic Tauri deserialize error.
/// Mirrors `contract/session-profiles.ts`'s `PiProfileSettings` field names.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct PiProfileSettingsInput {
    #[serde(rename = "systemPromptMode", default)]
    pub system_prompt_mode: String,
    #[serde(rename = "systemPrompt", default)]
    pub system_prompt: Option<String>,
    #[serde(rename = "instructionPaths", default)]
    pub instruction_paths: Vec<String>,
    #[serde(rename = "skillPaths", default)]
    pub skill_paths: Vec<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(rename = "projectResources", default)]
    pub project_resources: String,
}

/// FR-5/edge case §7: the whole Pi settings validation, from raw wire
/// strings to the stored, typed `PiProfileSettings`. Does real filesystem
/// I/O for `instructionPaths` ONLY — "existing absolute text file paths"
/// (contract comment) means a missing one refuses AT SUBMIT ("Missing file
/// path at submit: INVALID_INPUT, retain editor contents", §7). `skillPaths`
/// are checked for shape/bounds only here — the contract defers their
/// existence check to spawn time ("validate before spawn").
pub fn validate_pi_settings(
    raw: PiProfileSettingsInput,
) -> Result<PiProfileSettings, ProfileError> {
    let (system_prompt_mode, system_prompt) =
        validate_mode_and_prompt(&raw.system_prompt_mode, raw.system_prompt)?;

    if raw.instruction_paths.len() > MAX_PI_INSTRUCTION_PATHS {
        return Err(ProfileError::InvalidInput(BAD_PI_INSTRUCTION_COUNT_MSG));
    }
    for path in &raw.instruction_paths {
        if !Path::new(path).is_absolute() {
            return Err(ProfileError::InvalidInput(BAD_PI_INSTRUCTION_PATH_MSG));
        }
        let exists_as_file = std::fs::metadata(path)
            .map(|m| m.is_file())
            .unwrap_or(false);
        if !exists_as_file {
            return Err(ProfileError::InvalidInput(MISSING_PI_INSTRUCTION_PATH_MSG));
        }
    }

    if raw.skill_paths.len() > MAX_PI_SKILL_PATHS {
        return Err(ProfileError::InvalidInput(BAD_PI_SKILL_COUNT_MSG));
    }
    for path in &raw.skill_paths {
        if !Path::new(path).is_absolute() {
            return Err(ProfileError::InvalidInput(BAD_PI_SKILL_PATH_MSG));
        }
    }

    // FR-5: an unknown tool name REJECTS rather than broadening to defaults;
    // an empty list is preserved as-is (explicitly "no built-in tools").
    let tools = raw
        .tools
        .iter()
        .map(|t| PiBuiltinTool::parse(t).ok_or(ProfileError::InvalidInput(BAD_PI_TOOL_MSG)))
        .collect::<Result<Vec<_>, _>>()?;

    let project_resources = match raw.project_resources.as_str() {
        "ignore" => PiProjectResources::Ignore,
        "allow" => PiProjectResources::Allow,
        _ => return Err(ProfileError::InvalidInput(BAD_PI_RESOURCES_MSG)),
    };

    Ok(PiProfileSettings {
        system_prompt_mode,
        system_prompt,
        instruction_paths: raw.instruction_paths,
        skill_paths: raw.skill_paths,
        tools,
        project_resources,
    })
}

/// FR-5: "systemPromptMode is default/append/replace ... systemPrompt
/// [is] required for append/replace; absent for default."
fn validate_mode_and_prompt(
    mode: &str,
    system_prompt: Option<String>,
) -> Result<(PiSystemPromptMode, Option<String>), ProfileError> {
    match mode {
        "default" => {
            if system_prompt
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty())
            {
                return Err(ProfileError::InvalidInput(BAD_PI_PROMPT_FOR_DEFAULT_MSG));
            }
            Ok((PiSystemPromptMode::Default, None))
        }
        "append" | "replace" => {
            let text = system_prompt
                .filter(|s| !s.trim().is_empty())
                .ok_or(ProfileError::InvalidInput(BAD_PI_PROMPT_REQUIRED_MSG))?;
            if text.chars().count() > MAX_SYSTEM_PROMPT {
                return Err(ProfileError::InvalidInput(super::BAD_PROMPT_MSG));
            }
            let parsed_mode = if mode == "append" {
                PiSystemPromptMode::Append
            } else {
                PiSystemPromptMode::Replace
            };
            Ok((parsed_mode, Some(text)))
        }
        _ => Err(ProfileError::InvalidInput(BAD_PI_MODE_MSG)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_input() -> PiProfileSettingsInput {
        PiProfileSettingsInput {
            system_prompt_mode: "default".into(),
            system_prompt: None,
            instruction_paths: Vec::new(),
            skill_paths: Vec::new(),
            tools: Vec::new(),
            project_resources: "ignore".into(),
        }
    }

    #[test]
    fn default_mode_with_no_prompt_is_valid() {
        let settings = validate_pi_settings(base_input()).unwrap();
        assert_eq!(settings.system_prompt_mode, PiSystemPromptMode::Default);
        assert_eq!(settings.system_prompt, None);
    }

    #[test]
    fn default_mode_with_a_prompt_is_rejected() {
        let mut input = base_input();
        input.system_prompt = Some("be terse".into());
        let err = validate_pi_settings(input).expect_err("rejected");
        assert!(matches!(
            err,
            ProfileError::InvalidInput(BAD_PI_PROMPT_FOR_DEFAULT_MSG)
        ));
    }

    #[test]
    fn replace_mode_requires_a_non_empty_prompt() {
        let mut input = base_input();
        input.system_prompt_mode = "replace".into();
        let err = validate_pi_settings(input.clone()).expect_err("missing");
        assert!(matches!(
            err,
            ProfileError::InvalidInput(BAD_PI_PROMPT_REQUIRED_MSG)
        ));

        input.system_prompt = Some("   ".into());
        let err = validate_pi_settings(input).expect_err("whitespace-only");
        assert!(matches!(
            err,
            ProfileError::InvalidInput(BAD_PI_PROMPT_REQUIRED_MSG)
        ));
    }

    #[test]
    fn append_mode_accepts_a_prompt_and_stores_the_mode() {
        let mut input = base_input();
        input.system_prompt_mode = "append".into();
        input.system_prompt = Some("stay terse".into());
        let settings = validate_pi_settings(input).unwrap();
        assert_eq!(settings.system_prompt_mode, PiSystemPromptMode::Append);
        assert_eq!(settings.system_prompt.as_deref(), Some("stay terse"));
    }

    #[test]
    fn an_over_cap_prompt_is_rejected() {
        let mut input = base_input();
        input.system_prompt_mode = "replace".into();
        input.system_prompt = Some("x".repeat(MAX_SYSTEM_PROMPT + 1));
        assert!(validate_pi_settings(input).is_err());
    }

    #[test]
    fn an_unknown_mode_is_rejected() {
        let mut input = base_input();
        input.system_prompt_mode = "prepend".into();
        let err = validate_pi_settings(input).expect_err("unknown mode");
        assert!(matches!(err, ProfileError::InvalidInput(BAD_PI_MODE_MSG)));
    }

    #[test]
    fn instruction_paths_must_be_absolute() {
        let mut input = base_input();
        input.instruction_paths = vec!["relative/path.md".into()];
        let err = validate_pi_settings(input).expect_err("relative");
        assert!(matches!(
            err,
            ProfileError::InvalidInput(BAD_PI_INSTRUCTION_PATH_MSG)
        ));
    }

    #[test]
    fn a_missing_instruction_path_is_rejected() {
        let dir = std::env::temp_dir().join(format!(
            "francois-pi-settings-missing-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let missing = dir.join("nope.md");
        let mut input = base_input();
        input.instruction_paths = vec![missing.to_string_lossy().to_string()];
        let err = validate_pi_settings(input).expect_err("missing file");
        assert!(matches!(
            err,
            ProfileError::InvalidInput(MISSING_PI_INSTRUCTION_PATH_MSG)
        ));
    }

    #[test]
    fn an_existing_instruction_path_is_accepted() {
        let dir = std::env::temp_dir().join(format!(
            "francois-pi-settings-ok-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("AGENTS.md");
        std::fs::write(&path, "be terse").unwrap();
        let mut input = base_input();
        input.instruction_paths = vec![path.to_string_lossy().to_string()];
        let settings = validate_pi_settings(input).unwrap();
        assert_eq!(settings.instruction_paths.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn too_many_instruction_paths_is_rejected() {
        // A hard-coded POSIX-style string like "/tmp/x" is NOT absolute on
        // Windows (no drive/UNC prefix) — build every fixture path off
        // `std::env::temp_dir()` so this test means the same thing on
        // Windows, macOS and Linux (all three run this in CI).
        let base = std::env::temp_dir();
        let mut input = base_input();
        input.instruction_paths = (0..=MAX_PI_INSTRUCTION_PATHS)
            .map(|i| {
                base.join(format!("does-not-matter-{i}.md"))
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        let err = validate_pi_settings(input).expect_err("too many");
        assert!(matches!(
            err,
            ProfileError::InvalidInput(BAD_PI_INSTRUCTION_COUNT_MSG)
        ));
    }

    #[test]
    fn skill_paths_are_not_existence_checked_at_save_time() {
        // §5: "max 50 absolute paths; validate before spawn" — save time
        // only enforces the shape/bound, never the filesystem. The path must
        // still be genuinely ABSOLUTE on whatever OS runs this test — a
        // literal "/does/not/exist" is not absolute on Windows.
        let missing = std::env::temp_dir().join("francois-pi-settings-missing-skill.md");
        let missing_str = missing.to_string_lossy().to_string();
        let mut input = base_input();
        input.skill_paths = vec![missing_str.clone()];
        let settings = validate_pi_settings(input).unwrap();
        assert_eq!(settings.skill_paths, vec![missing_str]);
    }

    #[test]
    fn a_relative_skill_path_is_rejected() {
        let mut input = base_input();
        input.skill_paths = vec!["relative/skill.md".into()];
        let err = validate_pi_settings(input).expect_err("relative");
        assert!(matches!(
            err,
            ProfileError::InvalidInput(BAD_PI_SKILL_PATH_MSG)
        ));
    }

    #[test]
    fn too_many_skill_paths_is_rejected() {
        let base = std::env::temp_dir();
        let mut input = base_input();
        input.skill_paths = (0..=MAX_PI_SKILL_PATHS)
            .map(|i| {
                base.join(format!("skill-{i}.md"))
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        let err = validate_pi_settings(input).expect_err("too many");
        assert!(matches!(
            err,
            ProfileError::InvalidInput(BAD_PI_SKILL_COUNT_MSG)
        ));
    }

    #[test]
    fn an_empty_tools_list_means_no_built_ins_not_defaults() {
        let settings = validate_pi_settings(base_input()).unwrap();
        assert!(settings.tools.is_empty());
    }

    #[test]
    fn every_certified_tool_name_is_accepted() {
        let mut input = base_input();
        input.tools = super::super::PI_BUILTIN_TOOLS
            .iter()
            .map(|s| s.to_string())
            .collect();
        let settings = validate_pi_settings(input).unwrap();
        assert_eq!(settings.tools.len(), super::super::PI_BUILTIN_TOOLS.len());
    }

    #[test]
    fn an_unknown_tool_name_rejects_rather_than_broadening_to_defaults() {
        let mut input = base_input();
        input.tools = vec!["exec".into()];
        let err = validate_pi_settings(input).expect_err("unknown tool");
        assert!(matches!(err, ProfileError::InvalidInput(BAD_PI_TOOL_MSG)));
    }

    #[test]
    fn project_resources_must_be_ignore_or_allow() {
        let mut input = base_input();
        input.project_resources = "always".into();
        let err = validate_pi_settings(input).expect_err("unknown resources value");
        assert!(matches!(
            err,
            ProfileError::InvalidInput(BAD_PI_RESOURCES_MSG)
        ));

        let mut input = base_input();
        input.project_resources = "allow".into();
        let settings = validate_pi_settings(input).unwrap();
        assert_eq!(settings.project_resources, PiProjectResources::Allow);
    }
}
