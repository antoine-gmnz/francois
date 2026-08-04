// editor/detect.rs — FR-2: locate an editor's launcher, PATH first, then a
// per-OS fallback table of default install locations. `candidate_paths` is the
// pure half (the `<dir>/<name><ext>` arithmetic — FR-2's tested table);
// `resolve_launcher` is the impure caller that composes it with the real
// PATH/PATHEXT environment and existence-checks the result against the
// filesystem (executable bit on unix).

use std::path::{Path, PathBuf};

/// Every `<dir>/<name><ext>` combination, `dirs` outer / `exts` inner, in
/// order. Pure — FR-2's tested half; existence checking is the impure
/// caller's job (`resolve_launcher`, below).
pub(crate) fn candidate_paths(dirs: &[String], exts: &[&str], name: &str) -> Vec<PathBuf> {
    dirs.iter()
        .flat_map(|dir| {
            exts.iter()
                .map(move |ext| Path::new(dir).join(format!("{name}{ext}")))
        })
        .collect()
}

#[cfg(windows)]
fn path_exts() -> Vec<String> {
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}
#[cfg(not(windows))]
fn path_exts() -> Vec<String> {
    vec![String::new()]
}

fn path_dirs() -> Vec<String> {
    std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .map(|d| d.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(unix)]
fn is_launchable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}
#[cfg(not(unix))]
fn is_launchable(p: &Path) -> bool {
    p.is_file()
}

fn first_existing(paths: Vec<PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|p| is_launchable(p))
}

/// FR-2's fallback table, as directories `resolve_launcher` joins with `name`
/// + `fallback_exts()` the same way `path_dirs()`/`path_exts()` are:
/// `%LOCALAPPDATA%\Programs\<win_dir>\bin` on Windows,
/// `/Applications/<mac_app>.app/Contents/Resources/app/bin` on macOS,
/// `/usr/bin` · `/usr/local/bin` · `/snap/bin` on Linux.
#[cfg(target_os = "windows")]
fn fallback_dirs(win_dir: &str, _mac_app: &str) -> Vec<String> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    vec![format!("{local}\\Programs\\{win_dir}\\bin")]
}
#[cfg(target_os = "macos")]
fn fallback_dirs(_win_dir: &str, mac_app: &str) -> Vec<String> {
    vec![format!(
        "/Applications/{mac_app}.app/Contents/Resources/app/bin"
    )]
}
#[cfg(all(unix, not(target_os = "macos")))]
fn fallback_dirs(_win_dir: &str, _mac_app: &str) -> Vec<String> {
    vec![
        "/usr/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/snap/bin".to_string(),
    ]
}

#[cfg(target_os = "windows")]
fn fallback_exts() -> Vec<&'static str> {
    vec![".cmd"]
}
#[cfg(not(target_os = "windows"))]
fn fallback_exts() -> Vec<&'static str> {
    vec![""]
}

/// FR-2: `name`'s absolute path — PATH first (each `PATH` entry x each
/// `PATHEXT` extension on Windows, the executable bit on unix), then the
/// fallback table. First hit wins. `None` if neither finds an executable.
/// Impure (env vars + the real filesystem); `candidate_paths` above is the
/// pure half this composes twice.
pub(crate) fn resolve_launcher(name: &str, win_dir: &str, mac_app: &str) -> Option<PathBuf> {
    let dirs = path_dirs();
    let exts = path_exts();
    let ext_refs: Vec<&str> = exts.iter().map(String::as_str).collect();
    if let Some(found) = first_existing(candidate_paths(&dirs, &ext_refs, name)) {
        return Some(found);
    }
    let fb_dirs = fallback_dirs(win_dir, mac_app);
    first_existing(candidate_paths(&fb_dirs, &fallback_exts(), name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_paths_is_dirs_times_exts_in_order() {
        let dirs = vec!["C:\\a".to_string(), "C:\\b".to_string()];
        let exts = vec![".EXE", ".CMD"];
        let got = candidate_paths(&dirs, &exts, "code");
        assert_eq!(
            got,
            vec![
                Path::new("C:\\a").join("code.EXE"),
                Path::new("C:\\a").join("code.CMD"),
                Path::new("C:\\b").join("code.EXE"),
                Path::new("C:\\b").join("code.CMD"),
            ]
        );
    }

    #[test]
    fn candidate_paths_unix_style_single_empty_ext() {
        let dirs = vec!["/usr/bin".to_string(), "/usr/local/bin".to_string()];
        let got = candidate_paths(&dirs, &[""], "code");
        assert_eq!(
            got,
            vec![
                Path::new("/usr/bin").join("code"),
                Path::new("/usr/local/bin").join("code"),
            ]
        );
    }

    #[test]
    fn candidate_paths_empty_dirs_yields_nothing() {
        assert!(candidate_paths(&[], &[".EXE"], "code").is_empty());
    }

    #[test]
    fn candidate_paths_empty_exts_yields_nothing() {
        assert!(candidate_paths(&["C:\\a".to_string()], &[], "code").is_empty());
    }
}
