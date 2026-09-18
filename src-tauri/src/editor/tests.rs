//! Unit tests for the open-in-vscode editor module (specs/open-in-vscode.md).
//! `super::*` pulls in the model, the FR-3 cache primitive, target
//! resolution, and the engine-facing command half.

use super::*;
use crate::ipc::ErrorCode;
use crate::ipc::IpcResult;

fn editor(id: EditorId, path: &str) -> EditorInfo {
    EditorInfo {
        id,
        label: "x".into(),
        path: path.into(),
    }
}

// ================= FR-5: wsl_folder_uri =================

#[test]
fn wsl_folder_uri_builds_the_remote_wsl_scheme() {
    assert_eq!(
        wsl_folder_uri("Ubuntu", "/home/u/api"),
        "vscode-remote://wsl+Ubuntu/home/u/api"
    );
}

#[test]
fn wsl_folder_uri_percent_encodes_spaces_hash_percent_and_non_ascii() {
    // Unreserved (A-Za-z0-9-._~) and `/` pass through; everything else is
    // %XX over its UTF-8 encoding (FR-5).
    assert_eq!(
        wsl_folder_uri("Ubuntu", "/repos/my project/#tag 100% café"),
        "vscode-remote://wsl+Ubuntu/repos/my%20project/%23tag%20100%25%20caf%C3%A9"
    );
}

#[test]
fn wsl_folder_uri_root_path_stays_a_single_slash() {
    assert_eq!(wsl_folder_uri("Ubuntu", "/"), "vscode-remote://wsl+Ubuntu/");
}

// ================= FR-4/5/6/7/8: launch_argv =================

#[test]
fn launch_argv_native_drive_path_is_editor_path_and_cwd_verbatim() {
    // FR-6, and FR-8's "argv array, never a shell string": exactly two
    // elements, cwd untouched.
    assert_eq!(
        launch_argv(
            "C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd",
            "D:\\acme-api"
        ),
        vec![
            "C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd".to_string(),
            "D:\\acme-api".to_string(),
        ]
    );
}

#[test]
fn launch_argv_wsl_unc_cwd_uses_folder_uri() {
    // FR-4/FR-5: story C — a WSL UNC cwd opens as a Remote-WSL window.
    assert_eq!(
        launch_argv("C:\\code.cmd", "\\\\wsl$\\Ubuntu\\home\\u\\api"),
        vec![
            "C:\\code.cmd".to_string(),
            "--folder-uri".to_string(),
            "vscode-remote://wsl+Ubuntu/home/u/api".to_string(),
        ]
    );
    // Both UNC spellings are recognized (wsl-filesystem FR-1/2).
    assert_eq!(
        launch_argv("C:\\code.cmd", "\\\\wsl.localhost\\Debian\\srv\\x"),
        vec![
            "C:\\code.cmd".to_string(),
            "--folder-uri".to_string(),
            "vscode-remote://wsl+Debian/srv/x".to_string(),
        ]
    );
}

#[test]
fn launch_argv_routes_purely_on_the_cwd_shape_never_a_runtime_flag() {
    // FR-4: "the launch target is decided by is_wsl_unc_path(session.cwd)
    // ALONE — the session's ClaudeRuntime is irrelevant". launch_argv doesn't
    // even take a runtime parameter, so this is structurally guaranteed —
    // pinned here against both directions of the mismatch story: a
    // drive-letter cwd on a hypothetical wsl-runtime session still opens
    // NATIVELY, and a WSL UNC cwd on a hypothetical native-runtime session
    // still opens REMOTELY.
    let native_argv = launch_argv("C:\\code.cmd", "D:\\acme-api");
    assert_eq!(native_argv.len(), 2, "drive cwd never gets --folder-uri");

    let remote_argv = launch_argv("C:\\code.cmd", "\\\\wsl$\\Ubuntu\\srv");
    assert!(remote_argv.contains(&"--folder-uri".to_string()));
}

#[test]
fn launch_argv_worktree_path_opens_verbatim_never_a_source_repo_root() {
    // FR-7: SessionMeta.cwd for a worktree session already IS the worktree
    // path (session-worktree FR-12) — no special-casing, no re-derivation
    // from worktree.sourceRepoRoot. Pinned so a future refactor cannot
    // silently start resolving the source repo instead.
    let worktree_cwd = "D:\\.francois-worktrees\\acme-api\\feat-auth";
    assert_eq!(
        launch_argv("C:\\code.cmd", worktree_cwd),
        vec!["C:\\code.cmd".to_string(), worktree_cwd.to_string()]
    );
}

#[test]
fn launch_argv_native_path_with_spaces_and_non_ascii_survives_intact() {
    let cwd = "D:\\repos\\my project (café)";
    assert_eq!(
        launch_argv("C:\\code.cmd", cwd),
        vec!["C:\\code.cmd".to_string(), cwd.to_string()]
    );
}

#[test]
fn launch_argv_never_produces_a_cmd_c_string() {
    // FR-8: no hand-rolled `cmd /c` invocation anywhere — argv only.
    let argv = launch_argv("C:\\code.cmd", "D:\\acme-api");
    assert!(!argv.iter().any(|a| a == "cmd" || a == "/c"));
}

// ================= FR-3: cache — successes only =================

#[test]
fn cached_or_probe_freezes_on_a_successful_probe() {
    let cache: Mutex<Option<Vec<EditorInfo>>> = Mutex::new(None);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let found = vec![editor(EditorId::Vscode, "C:\\code.cmd")];

    let first = cached_or_probe(&cache, || {
        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        found.clone()
    });
    assert_eq!(first, found);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

    // A second call must NOT re-probe — the success is frozen.
    let second = cached_or_probe(&cache, || {
        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        vec![editor(EditorId::Cursor, "C:\\cursor.cmd")]
    });
    assert_eq!(second, found, "cached success must not be replaced");
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[test]
fn cached_or_probe_retries_after_an_empty_probe() {
    let cache: Mutex<Option<Vec<EditorInfo>>> = Mutex::new(None);

    let first = cached_or_probe(&cache, Vec::new);
    assert!(first.is_empty());

    // An empty probe must NOT be frozen — a cold/unlucky probe (spec §7 /
    // wsl.rs's WSL_UNC_ROOTS policy) must not degrade the whole app run.
    let second_result = vec![editor(EditorId::Windsurf, "C:\\windsurf.cmd")];
    let second = cached_or_probe(&cache, || second_result.clone());
    assert_eq!(second, second_result);
}

// ================= command surface =================

#[test]
fn session_editor_list_resolves_ok_never_an_error() {
    // FR-1: app-scoped, "[] = none installed, NOT an error" — the command
    // never returns Err (only 'INTERNAL' is even declared as possible, and
    // this codepath cannot produce it).
    match session_editor_list() {
        IpcResult::Ok { ok, .. } => assert!(ok),
        IpcResult::Err { .. } => panic!("session_editor_list must never error"),
    }
}

#[test]
fn open_in_editor_impl_reports_editor_not_found_with_the_requested_id_in_detail() {
    // Only vscode is "installed" in this list — cursor is not.
    let editors = vec![editor(EditorId::Vscode, "C:\\code.cmd")];
    match open_in_editor_impl(&editors, "D:\\acme-api", EditorId::Cursor) {
        IpcResult::Err { error, .. } => {
            assert_eq!(error.code, ErrorCode::EditorNotFound);
            assert_eq!(error.detail.unwrap()["editorId"], "cursor");
        }
        IpcResult::Ok { .. } => panic!("expected EDITOR_NOT_FOUND"),
    }
}

#[test]
fn open_in_editor_impl_reports_launch_failed_for_an_uninstalled_since_startup_editor() {
    // spec §7: "Editor uninstalled while Francois runs — the stale item stays
    // listed; clicking it returns ... EDITOR_LAUNCH_FAILED" (FR-11). Here the
    // list still names it (as a real detected-at-startup probe would), but
    // its path no longer resolves to a spawnable binary. (No `.cmd`/`.bat`
    // extension here on purpose: those are special-cased by
    // `std::process::Command` to route through `cmd.exe`, whose own spawn
    // succeeds even for a target that does not exist — the failure would
    // only surface inside that detached child, invisible to `spawn()`'s
    // `Result`. A missing extensionless binary fails `spawn()` directly.)
    let bogus_path = "D:\\francois-test-does-not-exist\\code-editor-binary";
    let editors = vec![editor(EditorId::Vscode, bogus_path)];
    match open_in_editor_impl(&editors, "D:\\acme-api", EditorId::Vscode) {
        IpcResult::Err { error, .. } => {
            assert_eq!(error.code, ErrorCode::EditorLaunchFailed);
            assert_eq!(error.detail.unwrap()["path"], bogus_path);
        }
        IpcResult::Ok { .. } => panic!("expected EDITOR_LAUNCH_FAILED"),
    }
}
