//! External targets from transcript links; only HTTP(S) and existing files.
use super::{cached_editors, spawn_editor, wsl_folder_uri};
use crate::ipc::{err, ok, ErrorCode, IpcResult};
use crate::session::Engine;
use crate::wsl::wsl_unc_to_linux;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTargetRequest {
    session_id: Option<String>,
    target: String,
}

fn is_windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

pub(super) fn resolve_file_target(
    cwd: &str,
    target: &str,
) -> Result<(String, Option<String>), String> {
    let (mut path, mut position) = (target.to_string(), None);
    if let Some((base, line)) = target.rsplit_once("#L") {
        if !line.is_empty() && line.bytes().all(|b| b.is_ascii_digit()) {
            path = base.into();
            position = Some(line.into());
        }
    }
    if position.is_none() {
        let mut numbers = Vec::new();
        for _ in 0..2 {
            let Some((base, number)) = path.rsplit_once(':') else {
                break;
            };
            if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
                break;
            }
            numbers.insert(0, number.to_string());
            path = base.to_string();
        }
        if !numbers.is_empty() {
            position = Some(numbers.join(":"));
        }
    }
    let file = if path.starts_with("file:") {
        url::Url::parse(&path)
            .map_err(|_| "invalid file URL")?
            .to_file_path()
            .map_err(|_| "invalid file URL")?
    } else {
        if path.contains("://") || (url::Url::parse(&path).is_ok() && !is_windows_absolute(&path)) {
            return Err("unsupported URL scheme".into());
        }
        #[cfg(target_os = "windows")]
        if path.starts_with('/') {
            if let Some((distro, _)) = wsl_unc_to_linux(cwd) {
                path = crate::wsl::linux_to_wsl_unc(Some(&distro), &path)
                    .ok_or("could not resolve WSL path")?;
            }
        }
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            PathBuf::from(cwd).join(path)
        }
    };
    if !file.exists() {
        return Err("file does not exist".into());
    }
    Ok((file.to_string_lossy().into_owned(), position))
}

pub(super) fn file_launch_argv(editor: &str, path: &str, position: Option<&str>) -> Vec<String> {
    if let Some((distro, linux_path)) = wsl_unc_to_linux(path) {
        let mut target = wsl_folder_uri(&distro, &linux_path);
        if let Some(pos) = position {
            target.push_str(&format!(":{}", pos));
        }
        let mut argv = vec![editor.into(), "--file-uri".into(), target];
        if position.is_some() {
            argv.insert(1, "--goto".into());
        }
        return argv;
    }
    match position {
        Some(pos) => vec![editor.into(), "--goto".into(), format!("{path}:{pos}")],
        None => vec![editor.into(), path.into()],
    }
}

fn open_browser(target: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    let command = crate::process_util::spawn("rundll32.exe").arg("url.dll,FileProtocolHandler");
    #[cfg(target_os = "macos")]
    let command = crate::process_util::spawn("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let command = crate::process_util::spawn("xdg-open");
    command.arg(target).start().map(|_| ())
}

#[tauri::command(async)]
pub fn editor_open_target(
    engine: State<'_, Engine>,
    req: OpenTargetRequest,
) -> IpcResult<Option<()>> {
    let cwd = req.session_id.as_deref().and_then(|id| engine.cwd_of(id));
    dispatch_target(
        &req.target,
        cwd.as_deref(),
        cached_editors,
        open_browser,
        spawn_editor,
    )
}

fn dispatch_target(
    target: &str,
    cwd: Option<&str>,
    editors: impl FnOnce() -> Vec<super::EditorInfo>,
    launch_browser: impl FnOnce(&str) -> std::io::Result<()>,
    launch_editor: impl FnOnce(&[String]) -> std::io::Result<()>,
) -> IpcResult<Option<()>> {
    let target = target.trim();
    if let Ok(url) = url::Url::parse(target) {
        if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
            return match launch_browser(url.as_str()) {
                Ok(()) => ok(None),
                Err(e) => err(ErrorCode::Internal, format!("could not open browser: {e}")),
            };
        }
    }
    let Some(cwd) = cwd else {
        return err(
            ErrorCode::SessionNotFound,
            "a session is required to open a file",
        );
    };
    let (path, position) = match resolve_file_target(cwd, target) {
        Ok(file) => file,
        Err(message) => return err(ErrorCode::InvalidInput, message),
    };
    let editors = editors();
    let Some(editor) = editors.first() else {
        return err(ErrorCode::EditorNotFound, "no supported IDE is installed");
    };
    let argv = if std::path::Path::new(&path).is_dir() {
        super::launch_argv(&editor.path, &path)
    } else {
        file_launch_argv(&editor.path, &path, position.as_deref())
    };
    match launch_editor(&argv) {
        Ok(()) => ok(None),
        Err(e) => err(
            ErrorCode::EditorLaunchFailed,
            format!("could not launch IDE: {e}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_roundtrip_matches_the_contract() {
        for value in [
            json!({ "target": "https://example.com", "sessionId": null }),
            json!({ "target": "a.ts:2", "sessionId": "s1" }),
        ] {
            let req: OpenTargetRequest = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(req).unwrap(), value);
        }
        assert!(serde_json::from_value::<OpenTargetRequest>(
            json!({ "target": "https://example.com" })
        )
        .is_ok());
    }

    #[test]
    fn browser_dispatch_needs_no_session_or_editor_and_returns_launch_errors() {
        let result = dispatch_target(
            " https://example.com ",
            None,
            || panic!("must not probe editors"),
            |url| {
                assert_eq!(url, "https://example.com/");
                Ok(())
            },
            |_| panic!("must not launch editor"),
        );
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({ "ok": true, "data": null })
        );
        let result = dispatch_target(
            "https://example.com",
            None,
            Vec::new,
            |_| Err(std::io::Error::other("offline")),
            |_| Ok(()),
        );
        assert_eq!(
            serde_json::to_value(result).unwrap()["error"]["code"],
            "INTERNAL"
        );
        let result = dispatch_target(
            "a.ts",
            None,
            Vec::new,
            |_| panic!("must not open browser"),
            |_| Ok(()),
        );
        assert_eq!(
            serde_json::to_value(result).unwrap()["error"]["code"],
            "SESSION_NOT_FOUND"
        );
    }

    #[test]
    fn file_dispatch_reports_missing_files_editors_and_launch_failures() {
        let root = std::env::temp_dir().join(format!("francois-dispatch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.ts"), "test").unwrap();
        let cwd = root.to_str().unwrap();
        let result = dispatch_target(
            "missing.ts",
            Some(cwd),
            || panic!("must not probe editors"),
            |_| Ok(()),
            |_| Ok(()),
        );
        assert_eq!(
            serde_json::to_value(result).unwrap()["error"]["code"],
            "INVALID_INPUT"
        );
        let result = dispatch_target(
            "a.ts",
            Some(cwd),
            Vec::new,
            |_| panic!("must not open browser"),
            |_| Ok(()),
        );
        assert_eq!(
            serde_json::to_value(result).unwrap()["error"]["code"],
            "EDITOR_NOT_FOUND"
        );
        let editors = || {
            vec![super::super::EditorInfo {
                id: super::super::EditorId::Vscode,
                label: "VS Code".into(),
                path: "code".into(),
            }]
        };
        let result = dispatch_target(
            "a.ts:2:3",
            Some(cwd),
            editors,
            |_| panic!("must not open browser"),
            |argv| {
                assert_eq!(
                    argv,
                    &[
                        "code".to_string(),
                        "--goto".to_string(),
                        format!("{}:2:3", root.join("a.ts").display())
                    ]
                );
                Ok(())
            },
        );
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({ "ok": true, "data": null })
        );
        let result = dispatch_target(
            "a.ts",
            Some(cwd),
            editors,
            |_| Ok(()),
            |_| Err(std::io::Error::other("missing launcher")),
        );
        assert_eq!(
            serde_json::to_value(result).unwrap()["error"]["code"],
            "EDITOR_LAUNCH_FAILED"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
