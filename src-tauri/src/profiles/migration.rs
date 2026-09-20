//! pi-migration-rollout FR-6/FR-10: the profiles.json schema-version
//! migration. Versioned (`"version"` at the document root), idempotent (a
//! file already at `PROFILE_SCHEMA_VERSION` is a no-op), atomic (temp file +
//! rename, via the same helper `permissions::write_json_atomic` uses), and
//! backed up EXACTLY ONCE before the first write a migration ever makes.
//!
//! This is JSON, not a DB migration (§6): there is no journal table, no
//! transaction log — "resume idempotently" falls out of two properties that
//! are each individually simple: the backup step is skip-if-exists, and the
//! rewrite step is atomic (so it never leaves a half-written file for the
//! next run to find). A build that does not recognize the file's version as
//! current OR as anything it knows how to upgrade FROM (a schema newer than
//! this build) never writes at all — "a future unknown schema is not
//! rewritten with dropped fields" (§6/§7).

use serde_json::Value;
use std::path::{Path, PathBuf};

/// The current profiles.json schema version this build writes. v1 was the
/// pre-pi-migration-rollout format (no per-entry `kind`); v2 is this
/// feature's format (every entry normalized to carry an explicit `kind`,
/// defaulting a missing one to `"legacy"` — FR-2).
pub const PROFILE_SCHEMA_VERSION: u64 = 2;

/// What a migration attempt found/did. `is_writable` is what `load_profiles`
/// gates every subsequent `profiles_*` command on.
#[derive(Debug, Clone, PartialEq)]
pub enum MigrationOutcome {
    /// No file yet, or already at `PROFILE_SCHEMA_VERSION` — nothing to do.
    UpToDate,
    /// A v1 (or otherwise older) file was normalized and rewritten, with a
    /// backup created first.
    Migrated,
    /// The file's `"version"` is NEWER than this build understands. Left
    /// completely untouched — never rewritten, never reinterpreted.
    FutureSchema(u64),
    /// The file exists but is not valid JSON, or the backup/rewrite step
    /// failed. The original is untouched either way.
    Failed(String),
}

impl MigrationOutcome {
    /// Whether `profiles_*` commands may safely read AND write the registry
    /// this outcome describes.
    pub fn is_writable(&self) -> bool {
        matches!(
            self,
            MigrationOutcome::UpToDate | MigrationOutcome::Migrated
        )
    }
}

/// Injected failure points, for the "failure injection between every file
/// write" acceptance criterion (§9) — production code only ever calls
/// `migrate_registry`, which passes `FailPoint::None`. `AfterBackup` is
/// constructed only by the test below (`migrate_registry_with_fail_point` is
/// itself `#[cfg(test)]`), so a non-test build never constructs it — the same
/// `cfg_attr(not(test), allow(dead_code))` shape `project::registry`'s
/// `clear_profile_from`/`clear_account_from` already use for a test-only path.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum FailPoint {
    None,
    /// Simulate a crash after the backup was written but before the
    /// migrated document replaces the original.
    AfterBackup,
}

/// The production entry point: migrate `path` in place if (and only if) it
/// needs it. Called once, from `registry::load_profiles`, before anything is
/// read into memory.
pub fn migrate_registry(path: &Path) -> MigrationOutcome {
    migrate_registry_inner(path, FailPoint::None)
}

#[cfg(test)]
pub(crate) fn migrate_registry_with_fail_point(path: &Path, fp: FailPoint) -> MigrationOutcome {
    migrate_registry_inner(path, fp)
}

fn migrate_registry_inner(path: &Path, fp: FailPoint) -> MigrationOutcome {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        // No file at all — a fresh install has nothing to migrate; it starts
        // at the current version the moment something is first saved.
        Err(_) => return MigrationOutcome::UpToDate,
    };
    let Ok(doc) = serde_json::from_slice::<Value>(&bytes) else {
        return MigrationOutcome::Failed(format!("{} is not valid JSON", path.display()));
    };
    let version = doc.get("version").and_then(Value::as_u64).unwrap_or(1);
    if version == PROFILE_SCHEMA_VERSION {
        return MigrationOutcome::UpToDate;
    }
    if version > PROFILE_SCHEMA_VERSION {
        return MigrationOutcome::FutureSchema(version);
    }

    let backup_path = backup_path_for(path, version);
    if !backup_path.exists() {
        if let Err(e) = copy_atomic(&backup_path, &bytes) {
            return MigrationOutcome::Failed(format!(
                "could not back up {} to {}: {e}",
                path.display(),
                backup_path.display()
            ));
        }
    }

    if fp == FailPoint::AfterBackup {
        return MigrationOutcome::Failed("injected failure after backup".into());
    }

    let entries = doc
        .get("profiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let normalized: Vec<Value> = entries.into_iter().map(normalize_entry_kind).collect();
    let migrated = serde_json::json!({ "version": PROFILE_SCHEMA_VERSION, "profiles": normalized });
    match crate::permissions::write_json_atomic(path, &migrated) {
        Ok(()) => MigrationOutcome::Migrated,
        Err(e) => MigrationOutcome::Failed(e.message),
    }
}

/// `profiles.json` → `profiles.v<oldVersion>.bak.json`, next to the original.
fn backup_path_for(path: &Path, version: u64) -> PathBuf {
    path.with_extension(format!("v{version}.bak.json"))
}

/// A byte-for-byte copy of the ORIGINAL file, written atomically (temp file +
/// rename) so an interrupted backup can never look like a completed one —
/// the `!backup_path.exists()` check above is what makes "create the backup
/// ONCE" idempotent across a resumed migration.
fn copy_atomic(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = crate::fs_util::unique_temp_path(dest, "json");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, dest)
}

/// FR-2/FR-6: every entry keeps every field it already had — this only ADDS
/// an explicit `"kind": "legacy"` to an entry that has none. An entry that
/// already carries SOME `kind` (recognized or not) is returned unchanged, so
/// an unrecognized discriminator is never reinterpreted or dropped.
fn normalize_entry_kind(mut entry: Value) -> Value {
    if let Value::Object(map) = &mut entry {
        map.entry("kind".to_string())
            .or_insert_with(|| Value::String("legacy".to_string()));
    }
    entry
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "francois-profiles-migration-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("profiles.json")
    }

    #[test]
    fn a_missing_file_is_up_to_date_and_writes_nothing() {
        let path = tmp_path("missing");
        assert_eq!(migrate_registry(&path), MigrationOutcome::UpToDate);
        assert!(!path.exists());
    }

    #[test]
    fn a_current_version_file_is_a_no_op() {
        let path = tmp_path("current");
        std::fs::write(
            &path,
            serde_json::json!({ "version": PROFILE_SCHEMA_VERSION, "profiles": [] }).to_string(),
        )
        .unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        assert_eq!(migrate_registry(&path), MigrationOutcome::UpToDate);
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(before, after, "an up-to-date file must not be rewritten");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn a_v1_file_migrates_and_normalizes_missing_kinds() {
        let path = tmp_path("v1");
        std::fs::write(
            &path,
            serde_json::json!({
                "version": 1,
                "profiles": [
                    { "id": "p1", "name": "role-a", "createdAt": 1, "updatedAt": 1 },
                    { "id": "p2", "name": "role-b", "kind": "legacy", "createdAt": 2, "updatedAt": 2 },
                ]
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(migrate_registry(&path), MigrationOutcome::Migrated);

        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["version"], PROFILE_SCHEMA_VERSION);
        let entries = doc["profiles"].as_array().unwrap();
        assert_eq!(entries[0]["kind"], "legacy");
        assert_eq!(entries[1]["kind"], "legacy");

        let backup = backup_path_for(&path, 1);
        assert!(backup.exists(), "a versioned backup must exist");
        let backup_doc: Value =
            serde_json::from_str(&std::fs::read_to_string(&backup).unwrap()).unwrap();
        assert!(
            backup_doc["profiles"][0].get("kind").is_none(),
            "the backup preserves the ORIGINAL bytes, unmigrated"
        );

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn re_running_migration_is_a_no_op() {
        let path = tmp_path("idempotent");
        std::fs::write(
            &path,
            serde_json::json!({ "version": 1, "profiles": [] }).to_string(),
        )
        .unwrap();
        assert_eq!(migrate_registry(&path), MigrationOutcome::Migrated);
        let after_first = std::fs::read_to_string(&path).unwrap();
        assert_eq!(migrate_registry(&path), MigrationOutcome::UpToDate);
        let after_second = std::fs::read_to_string(&path).unwrap();
        assert_eq!(after_first, after_second);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn an_unrecognized_kind_survives_migration_untouched() {
        let path = tmp_path("unknown-kind");
        std::fs::write(
            &path,
            serde_json::json!({
                "version": 1,
                "profiles": [
                    { "id": "p1", "name": "future", "kind": "grok", "someFutureField": 42 },
                ]
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(migrate_registry(&path), MigrationOutcome::Migrated);
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let entry = &doc["profiles"][0];
        assert_eq!(entry["kind"], "grok");
        assert_eq!(entry["someFutureField"], 42);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn a_future_schema_version_is_never_rewritten() {
        let path = tmp_path("future");
        let original = serde_json::json!({ "version": 99, "profiles": [] }).to_string();
        std::fs::write(&path, &original).unwrap();
        assert_eq!(migrate_registry(&path), MigrationOutcome::FutureSchema(99));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(
            !backup_path_for(&path, 99).exists(),
            "a schema we cannot understand is never even backed up — nothing was written"
        );
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn invalid_json_fails_without_touching_the_file() {
        let path = tmp_path("corrupt");
        std::fs::write(&path, b"{ not json").unwrap();
        match migrate_registry(&path) {
            MigrationOutcome::Failed(_) => {}
            other => panic!("expected Failed, got {other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn a_failure_injected_after_the_backup_leaves_the_original_readable_and_resumable() {
        let path = tmp_path("inject");
        let original = serde_json::json!({
            "version": 1,
            "profiles": [{ "id": "p1", "name": "role-a", "createdAt": 1, "updatedAt": 1 }],
        })
        .to_string();
        std::fs::write(&path, &original).unwrap();

        let outcome = migrate_registry_with_fail_point(&path, FailPoint::AfterBackup);
        assert!(matches!(outcome, MigrationOutcome::Failed(_)));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            original,
            "the original must be untouched by an interrupted migration"
        );
        assert!(
            backup_path_for(&path, 1).exists(),
            "the backup step itself had already completed and must not be undone"
        );

        // Resuming (no injected failure this time) must succeed and must not
        // try to recreate the backup that already exists.
        let backup_mtime_before = std::fs::metadata(backup_path_for(&path, 1))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(migrate_registry(&path), MigrationOutcome::Migrated);
        let backup_mtime_after = std::fs::metadata(backup_path_for(&path, 1))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(
            backup_mtime_before, backup_mtime_after,
            "the backup is created ONCE, never recreated on resume"
        );

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }
}
