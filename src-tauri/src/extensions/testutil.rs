//! Shared fixtures for the extensions module's unit tests.

use std::path::PathBuf;

/// A throwaway directory that really exists on disk — the detection predicates
/// and the FR-39 containment check both stat the filesystem, so the fixtures
/// must too. Unique per call: no test shares state with another.
pub(crate) fn tmp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "francois-ext-{tag}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
