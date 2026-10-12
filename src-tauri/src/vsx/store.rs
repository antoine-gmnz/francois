// vsx/store.rs — `~/.francois/vsx/installed.json`: `{ "extensions": [VsxInstalled…] }`,
// written atomically, every read-modify-write under one process-wide lock so
// two commands cannot interleave and drop a record. Never hits the network.

use super::{install_dir, internal, ExtId, VsxInstalled, VsxResult};
use crate::ipc::{AppError, ErrorCode};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

#[derive(Serialize, Deserialize, Default)]
struct InstalledFile {
    #[serde(default)]
    extensions: Vec<VsxInstalled>,
}

static LOCK: Mutex<()> = Mutex::new(());

/// Held across any change to installed.json or an install directory.
pub(crate) fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn file(root: &Path) -> PathBuf {
    root.join("installed.json")
}

/// Missing = nothing installed. Unreadable = nothing installed (logged): the
/// directories survive, and a reinstall rewrites the record.
pub(crate) fn load(root: &Path) -> Vec<VsxInstalled> {
    match std::fs::read(file(root)) {
        Ok(b) => match serde_json::from_slice::<InstalledFile>(&b) {
            Ok(f) => f.extensions,
            Err(e) => {
                eprintln!("[vsx] installed.json is unreadable, treating as empty: {e}");
                Vec::new()
            }
        },
        Err(_) => Vec::new(),
    }
}

pub(crate) fn save(root: &Path, extensions: &[VsxInstalled]) -> VsxResult<()> {
    crate::fs_util::ensure_dir_0700(root)
        .map_err(|e| internal("could not create the vsx directory", e))?;
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({ "extensions": extensions }))
        .map_err(|e| internal("could not encode installed.json", e))?;
    crate::fs_util::write_atomic(&file(root), &bytes)
        .map_err(|e| internal("could not write installed.json", e))
}

/// `vsx_list`: display-name order, case-insensitive.
pub(crate) fn list(root: &Path) -> Vec<VsxInstalled> {
    let mut all = load(root);
    all.sort_by_key(|e| (e.display_name.to_lowercase(), e.id.clone()));
    all
}

fn not_installed(id: &str) -> AppError {
    AppError::new(ErrorCode::VsxNotFound, format!("{id} is not installed."))
}

pub(crate) fn set_enabled(root: &Path, id: &str, enabled: bool) -> VsxResult<VsxInstalled> {
    let id = ExtId::parse(id)?.id();
    let _g = lock();
    let mut all = load(root);
    let rec = all
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| not_installed(&id))?;
    rec.enabled = enabled;
    let out = rec.clone();
    save(root, &all)?;
    Ok(out)
}

pub(crate) fn uninstall(root: &Path, id: &str) -> VsxResult<()> {
    let id = ExtId::parse(id)?.id();
    let _g = lock();
    let mut all = load(root);
    let pos = all
        .iter()
        .position(|e| e.id == id)
        .ok_or_else(|| not_installed(&id))?;
    let rec = all.remove(pos);
    let dir = install_dir(root, &rec.id, &rec.version);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| internal("could not remove the extension", e))?;
    }
    save(root, &all)
}

/// Replace (or add) the record for `rec.id`. Caller holds `lock()`.
pub(crate) fn upsert_locked(root: &Path, rec: VsxInstalled) -> VsxResult<()> {
    let mut all = load(root);
    all.retain(|e| e.id != rec.id);
    all.push(rec);
    save(root, &all)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::testutil::TempDir;
    use crate::vsx::{VsxContributionCounts, VsxSupport};

    pub(crate) fn rec(id: &str, name: &str, version: &str) -> VsxInstalled {
        VsxInstalled {
            id: id.into(),
            display_name: name.into(),
            publisher: "p".into(),
            description: String::new(),
            version: version.into(),
            icon: None,
            support: VsxSupport::Full,
            contributions: VsxContributionCounts::default(),
            language_ids: vec![],
            enabled: true,
            installed_at: 1,
        }
    }

    #[test]
    fn records_persist_and_list_in_display_name_order() {
        let tmp = TempDir::new();
        let root = tmp.path().join("vsx");
        assert!(list(&root).is_empty());
        upsert_locked(&root, rec("a.zeta", "zeta", "1.0.0")).unwrap();
        upsert_locked(&root, rec("b.alpha", "Alpha", "1.0.0")).unwrap();
        upsert_locked(&root, rec("a.zeta", "Zeta", "2.0.0")).unwrap();
        let all = list(&root);
        assert_eq!(
            all.iter()
                .map(|e| (e.id.as_str(), e.version.as_str()))
                .collect::<Vec<_>>(),
            vec![("b.alpha", "1.0.0"), ("a.zeta", "2.0.0")]
        );
    }

    #[test]
    fn enable_disable_persists_and_unknown_ids_are_not_found() {
        let tmp = TempDir::new();
        let root = tmp.path().to_path_buf();
        upsert_locked(&root, rec("a.b", "B", "1.0.0")).unwrap();
        let r = set_enabled(&root, "A.B", false).unwrap();
        assert!(!r.enabled);
        assert!(!load(&root)[0].enabled);
        assert!(set_enabled(&root, "a.b", true).unwrap().enabled);
        assert_eq!(
            set_enabled(&root, "x.y", true).unwrap_err().code,
            ErrorCode::VsxNotFound
        );
        assert_eq!(
            set_enabled(&root, "../x", true).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    #[test]
    fn uninstall_removes_directory_and_record() {
        let tmp = TempDir::new();
        let root = tmp.path().to_path_buf();
        upsert_locked(&root, rec("a.b", "B", "1.0.0")).unwrap();
        upsert_locked(&root, rec("c.d", "D", "1.0.0")).unwrap();
        let dir = install_dir(&root, "a.b", "1.0.0");
        std::fs::create_dir_all(dir.join("syntaxes")).unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        uninstall(&root, "a.b").unwrap();
        assert!(!dir.exists());
        assert_eq!(load(&root).len(), 1);
        assert_eq!(
            uninstall(&root, "a.b").unwrap_err().code,
            ErrorCode::VsxNotFound
        );
    }

    #[test]
    fn corrupt_installed_json_reads_as_empty() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path().join("installed.json"), "{nope").unwrap();
        assert!(load(tmp.path()).is_empty());
    }
}
