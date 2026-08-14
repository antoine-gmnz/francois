//! FR-1..FR-4, FR-13 — the manifest DIRECTORY registry.
//!
//! `scan_dir` is pure filesystem traversal + `manifest::load_one` per
//! subdirectory: no compiled definition is declared anywhere in this crate
//! any more (that array is what `extension-install` deletes). The only mutable
//! input to the WHOLE extension system remains `toggles::Toggles` — this
//! module never writes anything.

use super::{LoadedExtension, PanelDefinition};
use std::path::Path;

/// FR-1: every IMMEDIATE subdirectory of `dir` carrying a readable
/// `extension.json`. Order is lexicographic by directory name (FR-2), which is
/// what the tab strip renders.
pub(crate) fn scan_dir(dir: &Path) -> Vec<LoadedExtension> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<std::path::PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.path())
        .collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|p| super::manifest::load_one(&p))
        .collect()
}

/// The `(extension, panel)` a `panelId` names. `None` ⇒ `EXT_PANEL_NOT_FOUND`.
pub(crate) fn panel<'a>(
    registry: &'a [LoadedExtension],
    panel_id: &str,
) -> Option<(&'a LoadedExtension, &'a PanelDefinition)> {
    registry
        .iter()
        .find_map(|ext| ext.panel(panel_id).map(|p| (ext, p)))
}

pub(crate) fn extension<'a>(
    registry: &'a [LoadedExtension],
    id: &str,
) -> Option<&'a LoadedExtension> {
    registry.iter().find(|e| e.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::testutil::tmp_root;

    fn write(dir: &Path, name: &str, json: &str) {
        let sub = dir.join(name);
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("extension.json"), json).unwrap();
    }

    const OK_GIT: &str = r#"{
        "manifest": 1,
        "detect": { "kind": "pathExists", "path": ".git" },
        "panels": []
    }"#;

    // FR-1: only immediate subdirectories with a readable extension.json.
    #[test]
    fn scan_dir_finds_only_immediate_subdirectories_with_a_manifest() {
        let root = tmp_root("registry-scan");
        write(&root, "git", OK_GIT);
        // FR-4: a subdirectory with NO extension.json is ignored silently.
        std::fs::create_dir_all(root.join("not-a-plugin")).unwrap();
        // A stray FILE at the top level (e.g. a README) is not a directory.
        std::fs::write(root.join("README.md"), b"hi").unwrap();

        let found = scan_dir(&root);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "git");
    }

    // FR-2: lexicographic by directory name — the tab order.
    #[test]
    fn scan_dir_orders_extensions_lexicographically() {
        let root = tmp_root("registry-order");
        write(&root, "zeta", OK_GIT);
        write(&root, "alpha", OK_GIT);
        let found = scan_dir(&root);
        assert_eq!(
            found.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["alpha", "zeta"]
        );
    }

    // A directory that fails the id pattern is STILL listed (with an error),
    // never silently dropped — that is what distinguishes FR-3 from FR-4.
    #[test]
    fn an_invalid_directory_name_is_listed_with_an_error() {
        let root = tmp_root("registry-invalid-name");
        write(&root, "Bad_Name", OK_GIT);
        let found = scan_dir(&root);
        assert_eq!(found.len(), 1);
        assert!(found[0].manifest_error.is_some());
    }

    #[test]
    fn a_missing_registry_directory_yields_an_empty_list() {
        let root = tmp_root("registry-missing");
        assert!(scan_dir(&root.join("does-not-exist")).is_empty());
    }
}
