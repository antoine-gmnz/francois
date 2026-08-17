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

pub(crate) fn fixture(id: &str, name: &str) -> SessionProfile {
    SessionProfile {
        id: id.into(),
        name: name.into(),
        system_prompt: None,
        model_id: None,
        effort: None,
        permission_mode: None,
        extra_args_raw: None,
        extra_args: None,
        created_at: 1_000,
        updated_at: 1_000,
    }
}
