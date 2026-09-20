//! Shared fixtures for the profiles module's unit tests.

use super::*;

use std::path::PathBuf;

/// A throwaway directory that really exists on disk, for profiles.json I/O tests.
pub(crate) fn tmp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "francois-profiles-{tag}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub(crate) fn legacy_fixture(id: &str, name: &str) -> SessionProfile {
    SessionProfile::Legacy(LegacySessionProfile {
        id: id.into(),
        name: name.into(),
        system_prompt: None,
        extra_args_raw: None,
        extra_args: None,
        created_at: 1_000,
        updated_at: 1_000,
    })
}

pub(crate) fn pi_fixture(id: &str, name: &str) -> SessionProfile {
    SessionProfile::Pi(PiSessionProfile {
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
        created_at: 1_000,
        updated_at: 1_000,
    })
}
