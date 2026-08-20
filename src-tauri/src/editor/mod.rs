// editor/ — open-in-vscode (specs/open-in-vscode.md).
//
// Detects installed VS Code family editors (FR-1..FR-3) and launches the one
// the user picked at a session's cwd, translating to a
// vscode-remote://wsl+<distro>/... folder URI when that cwd lives inside WSL
// (FR-4/5) — the editor follows the FILESYSTEM, never the session's
// ClaudeRuntime (mirrors wsl-filesystem FR-5's own rule). App-scoped
// detection; opening an editor performs no session mutation, emits no event,
// and writes nothing to disk (FR-12) — it is observable only as a running
// process.
//
// mod.rs owns the model (mirrors contract/open-in-vscode.ts EXACTLY), the
// FR-3 detection cache, target resolution (`launch_argv`/`wsl_folder_uri`),
// and both #[tauri::command]s; detect.rs owns the FR-2 PATH/fallback probe;
// tests.rs holds this module's cargo tests.

mod detect;

#[cfg(test)]
mod tests;

use crate::ipc::{err, err_detail, ok, IpcResult};
use crate::process_util::no_window;
use crate::session::Engine;
use crate::wsl::wsl_unc_to_linux;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::State;

// ---------- FR-1: model (mirrors contract/open-in-vscode.ts EXACTLY) ----------

/// Mirrors contract/open-in-vscode.ts::EditorId. `rename_all = "kebab-case"`
/// produces the exact same four wire strings (`Vscode` -> `"vscode"`,
/// `VscodeInsiders` -> `"vscode-insiders"`, `Cursor` -> `"cursor"`,
/// `Windsurf` -> `"windsurf"`).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum EditorId {
    Vscode,
    VscodeInsiders,
    Cursor,
    Windsurf,
}

/// Mirrors contract/open-in-vscode.ts::EditorInfo. `path` is the absolute
/// resolved launcher path (FR-2) — shown only in the item's title.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct EditorInfo {
    pub id: EditorId,
    pub label: String,
    pub path: String,
}

/// Mirrors contract/open-in-vscode.ts::EditorListData.
#[derive(Serialize, Clone, Debug)]
pub(crate) struct EditorListData {
    editors: Vec<EditorInfo>,
}

/// One row of the FR-1 detection table: id/label/menu order, the launcher
/// basename PATH is searched for (FR-2), and the per-OS fallback folder names
/// FR-2's table needs.
struct EditorSpec {
    id: EditorId,
    label: &'static str,
    launcher: &'static str,
    win_dir: &'static str,
    mac_app: &'static str,
}

/// FR-1: probe order == menu order. Fixed — no configuration, no settings.
const EDITOR_SPECS: [EditorSpec; 4] = [
    EditorSpec {
        id: EditorId::Vscode,
        label: "VS Code",
        launcher: "code",
        win_dir: "Microsoft VS Code",
        mac_app: "Visual Studio Code",
    },
    EditorSpec {
        id: EditorId::VscodeInsiders,
        label: "VS Code Insiders",
        launcher: "code-insiders",
        win_dir: "Microsoft VS Code Insiders",
        mac_app: "Visual Studio Code - Insiders",
    },
    EditorSpec {
        id: EditorId::Cursor,
        label: "Cursor",
        launcher: "cursor",
        win_dir: "cursor",
        mac_app: "Cursor",
    },
    EditorSpec {
        id: EditorId::Windsurf,
        label: "Windsurf",
        launcher: "windsurf",
        win_dir: "Windsurf",
        mac_app: "Windsurf",
    },
];

fn probe_editors() -> Vec<EditorInfo> {
    EDITOR_SPECS
        .iter()
        .filter_map(|spec| {
            detect::resolve_launcher(spec.launcher, spec.win_dir, spec.mac_app).map(|path| {
                EditorInfo {
                    id: spec.id,
                    label: spec.label.to_string(),
                    path: path.to_string_lossy().into_owned(),
                }
            })
        })
        .collect()
}

// ---------- FR-3: app-scoped detection cache ----------

/// Successes only (FR-3): a probe that found at least one editor is frozen
/// for the app run; a probe that found none is re-run on the next call — same
/// policy as `wsl.rs`'s `WSL_UNC_ROOTS`, and for the same reason: a cold or
/// unlucky probe must not degrade the whole app run. Pure w.r.t. the caching
/// DECISION (tested directly, below); `probe` is the impure part.
fn cached_or_probe(
    cache: &Mutex<Option<Vec<EditorInfo>>>,
    probe: impl FnOnce() -> Vec<EditorInfo>,
) -> Vec<EditorInfo> {
    let mut guard = cache.lock().unwrap();
    if let Some(editors) = guard.as_ref() {
        return editors.clone();
    }
    let probed = probe();
    if !probed.is_empty() {
        *guard = Some(probed.clone());
    }
    probed
}

static EDITOR_CACHE: OnceLock<Mutex<Option<Vec<EditorInfo>>>> = OnceLock::new();

fn cached_editors() -> Vec<EditorInfo> {
    cached_or_probe(EDITOR_CACHE.get_or_init(|| Mutex::new(None)), probe_editors)
}

// ---------- FR-4/5/6: target resolution — the editor follows the filesystem ----------

/// FR-5: percent-encode one URI segment — unreserved characters
/// (`A-Za-z0-9-._~`) and `/` pass through untouched, every other byte becomes
/// `%XX` over its UTF-8 encoding. Pure.
fn percent_encode_uri_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// FR-5: `(distro, linux_path)` -> `vscode-remote://wsl+<distro>/<path>`,
/// both percent-encoded (`linux_path` already carries its own leading `/`,
/// which the encoder passes through). Pure.
pub(crate) fn wsl_folder_uri(distro: &str, linux_path: &str) -> String {
    format!(
        "vscode-remote://wsl+{}{}",
        percent_encode_uri_path(distro),
        percent_encode_uri_path(linux_path)
    )
}

/// FR-4/5/6 in one place: the argv Francois spawns for `editor_path` at
/// `cwd`, optionally targeting one repo-relative `path` inside it
/// (diff-review FR-27/44 — `↗ editor` opens the exact file, not the session
/// directory). Routing is decided by whether `cwd` IS a WSL UNC path
/// (delegating to `wsl::wsl_unc_to_linux`, which is exactly
/// `is_wsl_unc_path`'s own check) ALONE — the session's `ClaudeRuntime` never
/// enters this decision (mirrors wsl-filesystem FR-5). A worktree session
/// needs no special handling (FR-7): `SessionMeta.cwd` already IS the
/// worktree path, so the plain FR-6 branch below opens it, never the source
/// repo. `path` is absent ⇒ today's behaviour exactly (FR-44). Pure.
pub(crate) fn launch_argv(editor_path: &str, cwd: &str, path: Option<&str>) -> Vec<String> {
    if let Some((distro, linux_path)) = wsl_unc_to_linux(cwd) {
        return match path {
            Some(p) => vec![
                editor_path.to_string(),
                "--file-uri".to_string(),
                wsl_folder_uri(
                    &distro,
                    &format!("{}/{p}", linux_path.trim_end_matches('/')),
                ),
            ],
            None => vec![
                editor_path.to_string(),
                "--folder-uri".to_string(),
                wsl_folder_uri(&distro, &linux_path),
            ],
        };
    }
    match path {
        // Plain string join, deliberately not `std::path::Path::join`: `cwd`'s own
        // separator convention (native path components) is left untouched and `/`
        // is appended before the contract's forward-slash-separated `path` — every
        // mainstream editor (and Windows itself) accepts `/` in an argv path, and
        // this keeps the result identical regardless of which OS builds/tests it,
        // where `Path::join`'s platform `MAIN_SEPARATOR` would not.
        Some(p) => {
            let joined = format!("{}/{p}", cwd.trim_end_matches(['/', '\\']));
            vec![editor_path.to_string(), joined]
        }
        None => vec![editor_path.to_string(), cwd.to_string()],
    }
}

// ---------- FR-8: spawn (argv array, never a shell string; not awaited) ----------

fn spawn_editor(argv: &[String]) -> std::io::Result<()> {
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);
    cmd.spawn().map(|_child| ())
}

// ---------- commands ----------

/// francois:session:editorList (FR-1). App-scoped — no session id, no cwd —
/// and a machine with none installed resolves `ok:true` with `editors: []`,
/// never an error.
#[tauri::command(async)]
pub fn session_editor_list() -> IpcResult<EditorListData> {
    ok(EditorListData {
        editors: cached_editors(),
    })
}

/// francois:session:openInEditor's editor-resolution half — `cwd` is already
/// resolved (SESSION_NOT_FOUND is the `#[tauri::command]` wrapper's job,
/// since only the session domain can look up a session's cwd; editor's tests
/// cannot construct a `Session` — its fields are private to the session
/// module tree per this codebase's ownership convention). Resolves
/// `editor_id` against the (caller-supplied) detected list, then spawns
/// (FR-8), optionally targeting `path` (diff-review FR-44). No session
/// mutation, no event, no disk write (FR-12).
pub(crate) fn open_in_editor_impl(
    editors: &[EditorInfo],
    cwd: &str,
    editor_id: EditorId,
    path: Option<&str>,
) -> IpcResult<Option<()>> {
    let Some(editor) = editors.iter().find(|e| e.id == editor_id) else {
        return err_detail(
            "EDITOR_NOT_FOUND",
            "that editor is not installed",
            json!({ "editorId": editor_id }),
        );
    };
    let argv = launch_argv(&editor.path, cwd, path);
    match spawn_editor(&argv) {
        Ok(()) => ok(None),
        Err(e) => err_detail(
            "EDITOR_LAUNCH_FAILED",
            format!("could not launch the editor: {e}"),
            json!({ "path": editor.path }),
        ),
    }
}

/// francois:session:openInEditor (FR-4..FR-12; `path` per diff-review FR-44).
#[tauri::command(async)]
pub fn session_open_in_editor(
    engine: State<'_, Engine>,
    session_id: String,
    editor_id: EditorId,
    path: Option<String>,
) -> IpcResult<Option<()>> {
    let Some(cwd) = engine.cwd_of(&session_id) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    open_in_editor_impl(&cached_editors(), &cwd, editor_id, path.as_deref())
}
