// lsp/trust.rs — code-editor-lsp FR-4: which root directories may run
// language servers. Persisted in `~/.francois/lsp-trust.json` as
// `{ "roots": ["D:/repo", "//wsl.localhost/Ubuntu/home/u/api"] }` — each root
// in the `fs_util::norm_path` form, written atomically. Loaded lazily, once,
// then memory-authoritative (Francois is the file's only writer).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct TrustFile {
    #[serde(default)]
    roots: BTreeSet<String>,
}

pub(crate) struct TrustStore {
    path: Option<PathBuf>,
    roots: Option<BTreeSet<String>>,
}

impl TrustStore {
    /// `path` = the JSON file; `None` (no home directory) keeps trust in memory only.
    pub(crate) fn new(path: Option<PathBuf>) -> Self {
        Self { path, roots: None }
    }

    /// The production location, `~/.francois/lsp-trust.json`.
    pub(crate) fn default_path() -> Option<PathBuf> {
        crate::fs_util::francois_home_dir().map(|h| h.join("lsp-trust.json"))
    }

    fn loaded(&mut self) -> &mut BTreeSet<String> {
        let path = self.path.clone();
        self.roots.get_or_insert_with(|| {
            path.and_then(|p| std::fs::read(p).ok())
                .and_then(|b| serde_json::from_slice::<TrustFile>(&b).ok())
                .map(|f| f.roots)
                .unwrap_or_default()
        })
    }

    pub(crate) fn is_trusted(&mut self, root_dir: &str) -> bool {
        let key = key_of(root_dir);
        self.loaded().iter().any(|r| key_of(r) == key)
    }

    /// Set and persist. The in-memory answer changes even when the write fails
    /// (the error is returned so the command can report it).
    pub(crate) fn set(&mut self, root_dir: &str, trusted: bool) -> std::io::Result<()> {
        let norm = crate::fs_util::norm_path(root_dir);
        let key = key_of(&norm);
        let roots = self.loaded();
        roots.retain(|r| key_of(r) != key);
        if trusted {
            roots.insert(norm);
        }
        let file = TrustFile {
            roots: roots.clone(),
        };
        match &self.path {
            Some(p) => write_atomic(p, &serde_json::to_vec_pretty(&file)?),
            None => Ok(()),
        }
    }
}

/// Windows paths (drive or UNC) compare case-insensitively; POSIX ones exactly.
use super::dir_key as key_of;

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    if let Some(dir) = path.parent() {
        crate::fs_util::ensure_dir_0700(dir)?;
    }
    let tmp = crate::fs_util::unique_temp_path(path, "json");
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    let result = written.and_then(|()| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::testutil::TempDir;

    #[test]
    fn trust_persists_and_reloads() {
        let tmp = TempDir::new();
        let file = tmp.path().join("nested").join("lsp-trust.json");
        let mut s = TrustStore::new(Some(file.clone()));
        assert!(!s.is_trusted(r"D:\repo"));
        s.set(r"d:\repo\", true).unwrap();
        assert!(s.is_trusted("D:/repo"));
        assert!(
            s.is_trusted("d:/REPO"),
            "windows paths compare case-insensitively"
        );

        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(raw["roots"], serde_json::json!(["D:/repo"]));

        let mut fresh = TrustStore::new(Some(file.clone()));
        assert!(fresh.is_trusted(r"D:\repo"));
        fresh.set("D:/Repo", false).unwrap();
        assert!(!fresh.is_trusted("D:/repo"));
        let mut again = TrustStore::new(Some(file));
        assert!(!again.is_trusted("D:/repo"));
    }

    #[test]
    fn posix_roots_are_case_sensitive_and_corrupt_files_read_as_empty() {
        let tmp = TempDir::new();
        let file = tmp.path().join("lsp-trust.json");
        std::fs::write(&file, b"{not json").unwrap();
        let mut s = TrustStore::new(Some(file));
        assert!(!s.is_trusted("/home/u/api"));
        s.set("/home/u/api", true).unwrap();
        assert!(s.is_trusted("/home/u/api/"));
        assert!(!s.is_trusted("/home/u/API"));
    }

    #[test]
    fn no_home_keeps_trust_in_memory() {
        let mut s = TrustStore::new(None);
        s.set("/r", true).unwrap();
        assert!(s.is_trusted("/r"));
    }
}
