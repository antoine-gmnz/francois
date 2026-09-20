//! pi-migration-rollout FR-5: `PiProfileSettings` → (argv tokens, core-owned
//! launch-prompt snapshot). PURE FUNCTIONS + TESTS — wired into
//! `process.rs`'s `spawn` (the ONE call site) whenever a session carries a
//! resolved Pi profile settings snapshot; `None` (no profile at all, or no
//! override) means Pi launches with its own defaults, unrestricted by this
//! mechanism.
//!
//! **pi-migration-rollout FR-3 (read-once fix).** This module is split into
//! two halves with two very different lifetimes, because they answer two
//! different questions:
//!   - [`resolve_launch_prompt`] READS `instructionPaths` off disk and folds
//!     their content into the core-owned prompt text. Called EXACTLY ONCE —
//!     at session creation (`session_create`'s Pi branch), or, for a session
//!     persisted by a build before this fix, lazily once on its next connect
//!     (`adapter::pi::recovery`) — and the `PiLaunchPrompt` it returns is
//!     then stored on the session (`Session.pi_launch_prompt`,
//!     core-private, never in `SessionMeta`) and threaded through every
//!     later `RuntimeConnectContext`. This is what makes the contract's
//!     "read ONCE into the core-owned launch prompt snapshot" true: a file
//!     edited or deleted on disk after that one read can never change an
//!     already-created session's turns, and a reconnect never re-reads it.
//!   - [`build_pi_profile_args`] is the pure argv builder every spawn calls
//!     (initial connect, reconnect, new-from) — it takes the ALREADY-
//!     RESOLVED snapshot and performs NO filesystem read of its own, so it
//!     is exactly as cheap and exactly as safe to call on every connect as
//!     the baseline `pi_args` it rides alongside.
//!
//! `skillPaths` are a deliberately different contract rule ("validated
//! before spawn", contract doc on `PiProfileSettings.skillPaths`) — they are
//! NOT part of the read-once snapshot, and [`validate_skill_paths`] re-checks
//! them on every connect so a skill removed after creation refuses clearly
//! rather than launching Pi with a dangling `--skill` flag. That check is
//! kept OUT of the pure argv builder for the same reason the instruction
//! read moved out of it: a spawn-time function that touches the filesystem
//! is not the function this fix needs to be pure.
//!
//! **Provenance.** Every Pi CLI flag this module emits is PROVISIONAL and
//! docs-derived, not yet certified against a real Pi binary
//! (pi-runtime-distribution task 02 certifies before production enablement,
//! same caveat `process::pi_args` already carries for `--mode`/`--provider`/
//! `--model`/`--no-extensions`/`--no-approve`/`--resume`). Kept in ONE
//! function (`build_pi_profile_args`) so a later correction against a real
//! Pi touches exactly one place:
//!   - `--system-prompt <text>` (replace) / `--append-system-prompt <text>`
//!     (append) — no flag at all for `default` UNLESS `instructionPaths` is
//!     non-empty, in which case their content alone rides on
//!     `--append-system-prompt` (instructions are a distinct concern from the
//!     mode/systemPrompt pair, and still apply in default mode).
//!   - `--skill <path>` (repeated), one per `skillPath`.
//!   - `--allow-tool <name>` (repeated), or `--no-tools` when the list is
//!     empty — an empty list explicitly means no built-ins, never Pi's own
//!     defaults (FR-5).
//!
//! **Why text, not paths, for instructions.** The contract says instruction
//! paths are "read ONCE into the core-owned launch prompt snapshot" —
//! `resolve_launch_prompt` reads each file's content HERE, at resolve time,
//! and folds it into the text it hands Pi, rather than handing Pi the path
//! to re-read itself. That is what makes the returned `PiLaunchPrompt` an
//! immutable snapshot: a file edited on disk after it was resolved can never
//! change an already-running (or later reconnected) turn's context.

use crate::profiles::{PiProfileSettings, PiSystemPromptMode, ProfileError};
use serde::{Deserialize, Serialize};

pub(crate) const MISSING_INSTRUCTION_PATH_MSG: &str =
    "an instruction path no longer exists — it changed since the profile was saved";
pub(crate) const MISSING_SKILL_PATH_MSG: &str =
    "a skill path no longer exists — it changed since the profile was saved";

/// The core-owned prompt text actually sent to Pi, if any — `None` when
/// neither a systemPrompt override nor any instruction content applies
/// (`default` mode with no `instructionPaths`), in which case Pi's own
/// default prompt is left completely alone. Persisted verbatim alongside
/// `Session.pi_profile_settings` (`persistence.rs`'s `piLaunchPrompt` key) —
/// CORE-PRIVATE, never serialized into `SessionMeta` or any IPC payload.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub(crate) struct PiLaunchPrompt {
    pub(crate) text: Option<String>,
}

/// pi-migration-rollout FR-3/FR-5: resolve the core-owned launch-prompt
/// snapshot for an already-VALIDATED `PiProfileSettings` (validation
/// happened once, at save time, in `profiles::pi_settings::validate_pi_settings`
/// — this function trusts the mode/prompt/tool invariants that produced its
/// input and only re-checks what could have changed SINCE: whether the
/// referenced instruction files still exist and are readable).
///
/// Call this EXACTLY ONCE per session — at creation, or lazily once for a
/// session persisted before this fix (`adapter::pi::recovery`) — and store
/// its result rather than calling it again. A missing/unreadable instruction
/// path is `INVALID_INPUT`, which at session creation means creation fails
/// and the New Session form / profile editor keeps its contents.
pub(crate) fn resolve_launch_prompt(
    settings: &PiProfileSettings,
) -> Result<PiLaunchPrompt, ProfileError> {
    let mut instructions = String::new();
    for path in &settings.instruction_paths {
        let text = std::fs::read_to_string(path)
            .map_err(|_| ProfileError::InvalidInput(MISSING_INSTRUCTION_PATH_MSG))?;
        if !instructions.is_empty() {
            instructions.push_str("\n\n");
        }
        instructions.push_str(text.trim_end());
    }

    let text = match settings.system_prompt_mode {
        PiSystemPromptMode::Replace | PiSystemPromptMode::Append => {
            Some(combine(settings.system_prompt.as_deref(), &instructions))
        }
        PiSystemPromptMode::Default => {
            if instructions.is_empty() {
                None
            } else {
                Some(instructions)
            }
        }
    };

    Ok(PiLaunchPrompt { text })
}

/// Contract `PiProfileSettings.skillPaths`: "validated before spawn" — unlike
/// `instructionPaths` (read once into the snapshot above), this re-checks on
/// EVERY connect. Kept separate from the pure argv builder below so that
/// function performs no filesystem access at all.
pub(crate) fn validate_skill_paths(settings: &PiProfileSettings) -> Result<(), ProfileError> {
    for path in &settings.skill_paths {
        let is_file = std::fs::metadata(path)
            .map(|m| m.is_file())
            .unwrap_or(false);
        if !is_file {
            return Err(ProfileError::InvalidInput(MISSING_SKILL_PATH_MSG));
        }
    }
    Ok(())
}

/// pi-migration-rollout FR-5 (pi-migration-rollout FR-3 read-once fix): build
/// the Pi launch argv from `settings` and its ALREADY-RESOLVED `prompt`
/// snapshot. Pure — performs NO filesystem read, so it is safe and cheap to
/// call on every connect (initial, reconnect, new-from) without ever
/// touching the instruction files again.
pub(crate) fn build_pi_profile_args(
    settings: &PiProfileSettings,
    prompt: &PiLaunchPrompt,
) -> Vec<String> {
    let mut args = Vec::new();

    for path in &settings.skill_paths {
        args.push("--skill".into());
        args.push(path.clone());
    }

    if let Some(text) = &prompt.text {
        let flag = match settings.system_prompt_mode {
            PiSystemPromptMode::Replace => "--system-prompt",
            // Append, or Default with non-empty instructions (the only way
            // `prompt.text` is `Some` in Default mode) — both ride on
            // `--append-system-prompt`.
            PiSystemPromptMode::Append | PiSystemPromptMode::Default => "--append-system-prompt",
        };
        args.push(flag.into());
        args.push(text.clone());
    }

    if settings.tools.is_empty() {
        args.push("--no-tools".into());
    } else {
        for tool in &settings.tools {
            args.push("--allow-tool".into());
            args.push(tool.as_str().to_string());
        }
    }

    args
}

fn combine(prompt: Option<&str>, instructions: &str) -> String {
    let mut text = prompt.unwrap_or_default().to_string();
    if !instructions.is_empty() {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(instructions);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{PiBuiltinTool, PiProjectResources};

    fn base_settings() -> PiProfileSettings {
        PiProfileSettings {
            system_prompt_mode: PiSystemPromptMode::Default,
            system_prompt: None,
            instruction_paths: Vec::new(),
            skill_paths: Vec::new(),
            tools: Vec::new(),
            project_resources: PiProjectResources::Ignore,
        }
    }

    fn tmp_instruction_file(tag: &str, contents: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "francois-profile-args-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("AGENTS.md");
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn default_mode_with_no_instructions_resolves_no_prompt_and_emits_no_flag() {
        let mut settings = base_settings();
        settings.tools = vec![];
        let prompt = resolve_launch_prompt(&settings).unwrap();
        assert_eq!(prompt.text, None);
        let args = build_pi_profile_args(&settings, &prompt);
        assert!(!args.iter().any(|a| a.contains("system-prompt")));
        assert!(args.contains(&"--no-tools".to_string()));
    }

    #[test]
    fn default_mode_with_instructions_appends_them() {
        let path = tmp_instruction_file("default-instructions", "be terse");
        let mut settings = base_settings();
        settings.instruction_paths = vec![path.to_string_lossy().to_string()];
        let prompt = resolve_launch_prompt(&settings).unwrap();
        assert_eq!(prompt.text.as_deref(), Some("be terse"));
        let args = build_pi_profile_args(&settings, &prompt);
        assert_eq!(
            args.windows(2).find(|w| w[0] == "--append-system-prompt"),
            Some(&["--append-system-prompt".to_string(), "be terse".to_string()][..])
        );
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn replace_mode_combines_prompt_and_instructions() {
        let path = tmp_instruction_file("replace", "extra context");
        let mut settings = base_settings();
        settings.system_prompt_mode = PiSystemPromptMode::Replace;
        settings.system_prompt = Some("be a reviewer".into());
        settings.instruction_paths = vec![path.to_string_lossy().to_string()];
        let prompt = resolve_launch_prompt(&settings).unwrap();
        assert_eq!(
            prompt.text.as_deref(),
            Some("be a reviewer\n\nextra context")
        );
        let args = build_pi_profile_args(&settings, &prompt);
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--system-prompt" && w[1] == "be a reviewer\n\nextra context"));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn append_mode_without_instructions_uses_only_the_prompt() {
        let mut settings = base_settings();
        settings.system_prompt_mode = PiSystemPromptMode::Append;
        settings.system_prompt = Some("stay terse".into());
        let prompt = resolve_launch_prompt(&settings).unwrap();
        assert_eq!(prompt.text.as_deref(), Some("stay terse"));
        let args = build_pi_profile_args(&settings, &prompt);
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--append-system-prompt" && w[1] == "stay terse"));
    }

    #[test]
    fn resolving_a_missing_instruction_path_is_invalid_input() {
        // A path need not be "absolute" to exercise this — `read_to_string`
        // just has to fail — but build it off `temp_dir()` anyway (never a
        // hard-coded POSIX-style literal) for the same portability reason
        // every other path fixture in this crate does.
        let missing = std::env::temp_dir().join("francois-profile-args-missing-instruction.md");
        let mut settings = base_settings();
        settings.instruction_paths = vec![missing.to_string_lossy().to_string()];
        let err = resolve_launch_prompt(&settings).expect_err("missing");
        assert!(matches!(
            err,
            ProfileError::InvalidInput(MISSING_INSTRUCTION_PATH_MSG)
        ));
    }

    /// pi-migration-rollout FR-3 (the read-once fix, point a): once resolved,
    /// the snapshot's TEXT is what the argv builder uses — mutating the
    /// instruction file on disk afterward must never change it.
    #[test]
    fn the_argv_builder_never_reflects_a_later_edit_to_the_instruction_file() {
        let path = tmp_instruction_file("mutated", "original text");
        let mut settings = base_settings();
        settings.instruction_paths = vec![path.to_string_lossy().to_string()];
        let prompt = resolve_launch_prompt(&settings).unwrap();
        assert_eq!(prompt.text.as_deref(), Some("original text"));

        // Simulate an edit made after the session (and its snapshot) exist.
        std::fs::write(&path, "mutated text").unwrap();

        let args = build_pi_profile_args(&settings, &prompt);
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--append-system-prompt" && w[1] == "original text"));
        assert!(!args.iter().any(|a| a == "mutated text"));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    /// pi-migration-rollout FR-3 (the read-once fix, point b): once resolved,
    /// a reconnect's argv build must succeed even if the instruction file was
    /// deleted afterward — the snapshot carries the text, not the path.
    #[test]
    fn the_argv_builder_succeeds_after_the_instruction_file_is_deleted() {
        let path = tmp_instruction_file("deleted", "keep this text");
        let mut settings = base_settings();
        settings.instruction_paths = vec![path.to_string_lossy().to_string()];
        let prompt = resolve_launch_prompt(&settings).unwrap();

        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();

        let args = build_pi_profile_args(&settings, &prompt);
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--append-system-prompt" && w[1] == "keep this text"));
    }

    /// pi-migration-rollout FR-3 (the read-once fix, point c): the argv
    /// builder itself touches no filesystem at all — it succeeds even when
    /// handed a snapshot built from paths that never existed in the first
    /// place, as long as the snapshot itself is in hand.
    #[test]
    fn the_argv_builder_is_pure_and_never_touches_the_filesystem() {
        let missing = std::env::temp_dir().join("francois-profile-args-never-existed.md");
        let mut settings = base_settings();
        settings.instruction_paths = vec![missing.to_string_lossy().to_string()];
        let prompt = PiLaunchPrompt {
            text: Some("hand-built snapshot".into()),
        };
        let args = build_pi_profile_args(&settings, &prompt);
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--append-system-prompt" && w[1] == "hand-built snapshot"));
    }

    #[test]
    fn a_missing_skill_path_is_invalid_input_at_validate_time() {
        let missing = std::env::temp_dir().join("francois-profile-args-missing-skill.md");
        let mut settings = base_settings();
        settings.skill_paths = vec![missing.to_string_lossy().to_string()];
        let err = validate_skill_paths(&settings).expect_err("missing");
        assert!(matches!(
            err,
            ProfileError::InvalidInput(MISSING_SKILL_PATH_MSG)
        ));
    }

    #[test]
    fn an_empty_tools_list_emits_no_tools_never_a_default_set() {
        let settings = base_settings();
        let prompt = PiLaunchPrompt::default();
        let args = build_pi_profile_args(&settings, &prompt);
        assert_eq!(args.iter().filter(|a| *a == "--no-tools").count(), 1);
        assert!(!args.contains(&"--allow-tool".to_string()));
    }

    #[test]
    fn every_selected_tool_gets_its_own_allow_tool_flag() {
        let mut settings = base_settings();
        settings.tools = vec![PiBuiltinTool::Read, PiBuiltinTool::Bash];
        let prompt = PiLaunchPrompt::default();
        let args = build_pi_profile_args(&settings, &prompt);
        let allow_tools: Vec<&str> = args
            .windows(2)
            .filter(|w| w[0] == "--allow-tool")
            .map(|w| w[1].as_str())
            .collect();
        assert_eq!(allow_tools, vec!["read", "bash"]);
        assert!(!args.contains(&"--no-tools".to_string()));
    }

    #[test]
    fn skill_paths_become_repeated_skill_flags_with_no_existence_check() {
        // The argv builder never checks existence — that is
        // `validate_skill_paths`'s job, run separately at spawn time.
        let missing = std::env::temp_dir().join("francois-profile-args-skill-flag.md");
        let mut settings = base_settings();
        settings.skill_paths = vec![missing.to_string_lossy().to_string()];
        let prompt = PiLaunchPrompt::default();
        let args = build_pi_profile_args(&settings, &prompt);
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--skill" && w[1] == missing.to_string_lossy()));
    }
}
