//! FR-5 — is this copy of Francois npm-managed, and where does npm think its
//! executable is?
//!
//! Deriving the package root from the executable path does not work on macOS,
//! where the postinstall moves the bundle out to `~/Applications`; `npm root -g`
//! is the only anchor that holds on all three platforms.

use super::PACKAGE;
use std::path::{Path, PathBuf};

/// The macOS bundle marker. Matched as a plain string rather than by walking
/// ancestors so the logic is identical — and testable — on every platform.
const BUNDLE_MARKER: &str = ".app/Contents/MacOS/";

/// FR-5 #1: `npm root -g`, when it exits 0 and names an existing directory.
/// `None` also covers "npm is not on PATH at all" (FR-18).
pub fn npm_root_global() -> Option<PathBuf> {
    // npm ships as npm.cmd on Windows, which CreateProcess will not run directly.
    let cmd = if cfg!(windows) {
        crate::process_util::spawn("cmd").args(["/c", "npm", "root", "-g"])
    } else {
        crate::process_util::spawn("npm").args(["root", "-g"])
    };
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let root = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    root.is_dir().then_some(root)
}

/// The `.app` bundle containing `p`, or `None` for a plain binary path.
pub fn bundle_of(p: &Path) -> Option<PathBuf> {
    let s = p.to_string_lossy().replace('\\', "/");
    let at = s.find(BUNDLE_MARKER)?;
    Some(PathBuf::from(&s[..at + ".app".len()]))
}

fn canon(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// FR-5 #3: is the recorded executable the copy that is running? Equal paths, or
/// — on macOS, where the postinstall moves the bundle and the inner binary is
/// named by the bundler — the same `.app` bundle.
pub fn same_install(recorded: &Path, current: &Path) -> bool {
    if canon(recorded) == canon(current) {
        return true;
    }
    match (bundle_of(recorded), bundle_of(current)) {
        (Some(a), Some(b)) => canon(&a) == canon(&b),
        _ => false,
    }
}

/// FR-5 #2 + #3: the `executable` the npm postinstall recorded under `npm_root`,
/// but ONLY when it names this running copy. `None` ⇒ `method: 'manual'`.
pub fn npm_install_executable(npm_root: &Path, current_exe: &Path) -> Option<PathBuf> {
    let record = npm_root.join(PACKAGE).join("vendor").join("install.json");
    let body = std::fs::read_to_string(record).ok()?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    let recorded = PathBuf::from(json.get("executable")?.as_str()?);
    same_install(&recorded, current_exe).then(|| canon(&recorded))
}

/// FR-5 as a whole: the update method for this copy, and — for `npm` — the
/// executable path npm recorded, which the helper relaunches when the
/// post-install record is unreadable (FR-17).
pub fn detect_install() -> (&'static str, Option<PathBuf>) {
    let Ok(current_exe) = std::env::current_exe() else {
        return (super::METHOD_MANUAL, None);
    };
    let Some(root) = npm_root_global() else {
        return (super::METHOD_MANUAL, None);
    };
    match npm_install_executable(&root, &current_exe) {
        Some(exe) => (super::METHOD_NPM, Some(exe)),
        None => (super::METHOD_MANUAL, None),
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use std::path::{Path, PathBuf};

    /// A throwaway directory that really exists — the FR-5 check canonicalizes
    /// paths, so the fixtures must be on disk.
    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "francois-update-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A fake `npm root -g` tree: `<root>/francois/vendor/install.json` naming
    /// `executable`, plus that executable as a real file.
    fn npm_tree(tag: &str, record: Option<&str>) -> (PathBuf, PathBuf) {
        let root = tmp_root(tag);
        let vendor = root.join("francois").join("vendor");
        std::fs::create_dir_all(&vendor).unwrap();
        let exe = vendor.join("francois.exe");
        std::fs::write(&exe, b"binary").unwrap();
        if let Some(body) = record {
            let body = body.replace("__EXE__", &exe.to_string_lossy().replace('\\', "\\\\"));
            std::fs::write(vendor.join("install.json"), body).unwrap();
        }
        (root, exe)
    }

    #[test]
    fn recognizes_an_npm_install_whose_record_names_this_executable() {
        let (root, exe) = npm_tree("match", Some(r#"{"executable": "__EXE__"}"#));
        assert_eq!(
            npm_install_executable(&root, &exe),
            Some(exe.canonicalize().unwrap_or(exe))
        );
        std::fs::remove_dir_all(&root).ok();
    }

    // FR-5 #3: a record naming some OTHER copy is not this install.
    #[test]
    fn rejects_a_record_naming_a_different_executable() {
        let (root, _) = npm_tree("other", Some(r#"{"executable": "__EXE__"}"#));
        let elsewhere_root = tmp_root("elsewhere");
        let elsewhere = elsewhere_root.join("francois.exe");
        std::fs::write(&elsewhere, b"binary").unwrap();
        assert_eq!(npm_install_executable(&root, &elsewhere), None);
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&elsewhere_root).ok();
    }

    // FR-5 #2: no record ⇒ not an npm install (built from source, .msi, .dmg).
    #[test]
    fn rejects_a_tree_with_no_install_record() {
        let (root, exe) = npm_tree("norecord", None);
        assert_eq!(npm_install_executable(&root, &exe), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_an_unparseable_install_record() {
        let (root, exe) = npm_tree("broken", Some("{ not json"));
        assert_eq!(npm_install_executable(&root, &exe), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_a_record_with_no_executable_field() {
        let (root, exe) = npm_tree("noexe", Some(r#"{"productName": "Francois"}"#));
        assert_eq!(npm_install_executable(&root, &exe), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_a_root_that_has_no_francois_package() {
        let root = tmp_root("empty");
        assert_eq!(npm_install_executable(&root, Path::new("/nope")), None);
        std::fs::remove_dir_all(&root).ok();
    }

    // FR-5 #3, macOS: the record and the running exe can be the same INSTALL
    // while differing in path — matching the containing .app bundle covers it.
    #[test]
    fn matches_by_app_bundle_when_the_inner_binary_differs() {
        let recorded = Path::new("/Users/x/Applications/Francois.app/Contents/MacOS/francois");
        let running = Path::new("/Users/x/Applications/Francois.app/Contents/MacOS/Francois");
        assert!(same_install(recorded, running));
        assert_eq!(
            bundle_of(recorded),
            Some(PathBuf::from("/Users/x/Applications/Francois.app"))
        );
    }

    #[test]
    fn different_bundles_are_different_installs() {
        assert!(!same_install(
            Path::new("/Users/x/Applications/Francois.app/Contents/MacOS/francois"),
            Path::new("/Applications/Francois.app/Contents/MacOS/francois"),
        ));
    }

    #[test]
    fn a_plain_binary_path_has_no_bundle() {
        assert_eq!(bundle_of(Path::new("/usr/local/bin/francois")), None);
    }
}
