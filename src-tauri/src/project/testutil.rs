//! Shared fixtures for the project module's unit tests.

use super::*;

use std::path::PathBuf;

/// A throwaway directory that really exists on disk — `rootExists` (FR-2) and the
/// CLAUDE.md wrapper both stat the filesystem, so the fixtures must too.
pub(crate) fn tmp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "francois-proj-{tag}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A path that is absolute and syntactically valid but does NOT exist (§7 #3).
pub(crate) fn missing_root(tag: &str) -> String {
    std::env::temp_dir()
        .join(format!("francois-proj-gone-{tag}"))
        .to_string_lossy()
        .into_owned()
}

pub(crate) fn project_fixture(id: &str, name: &str, root: &str, last_used: u64) -> Project {
    Project {
        id: id.into(),
        name: name.into(),
        root: normalize_root(root),
        defaults: ProjectDefaults::default(),
        created_at: 1_000,
        last_used_at: last_used,
        group_id: None,
    }
}

pub(crate) fn group_fixture(id: &str, name: &str, created_at: u64) -> ProjectGroup {
    ProjectGroup {
        id: id.into(),
        name: name.into(),
        created_at,
    }
}

pub(crate) fn standards_of(notes: &str, rules: &[&str]) -> ProjectStandards {
    ProjectStandards {
        notes: notes.into(),
        rules: rules.iter().map(|r| (*r).to_string()).collect(),
    }
}

/// Write `<root>/CLAUDE.md` verbatim.
pub(crate) fn write_claude_md(root: &std::path::Path, content: &str) {
    std::fs::write(root.join("CLAUDE.md"), content).unwrap();
}

pub(crate) fn read_claude_md(root: &std::path::Path) -> String {
    std::fs::read_to_string(root.join("CLAUDE.md")).unwrap()
}
