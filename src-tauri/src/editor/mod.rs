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
//
// code-editor (specs/code-editor.md) adds the file-editing concern: this file
// also owns its model (mirrors contract/code-editor.ts EXACTLY) and the five
// `editor_*` commands; root.rs resolves an EditorRoot to a directory; files.rs
// owns path safety, decode and atomic save; listing.rs owns the explorer list,
// branch and git status; watch.rs owns the per-file debounced watches.

mod detect;
mod files;
mod listing;
mod root;
mod watch;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod edit_tests;

pub use watch::EditorState;

use crate::ipc::ErrorCode;
use crate::ipc::{err, err_detail, ok, IpcResult};
use crate::session::Engine;
use crate::wsl::wsl_unc_to_linux;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};

// ---------- FR-1: model (mirrors contract/open-in-vscode.ts EXACTLY) ----------

/// Mirrors contract/open-in-vscode.ts::EditorId. `rename_all = "kebab-case"`
/// produces the exact same four wire strings (`Vscode` -> `"vscode"`,
/// `VscodeInsiders` -> `"vscode-insiders"`, `Cursor` -> `"cursor"`,
/// `Windsurf` -> `"windsurf"`).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum EditorId {
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
pub struct EditorListData {
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
/// `cwd`. Routing is decided by whether `cwd` IS a WSL UNC path (delegating
/// to `wsl::wsl_unc_to_linux`, which is exactly `is_wsl_unc_path`'s own
/// check) ALONE — the session's `ClaudeRuntime` never enters this decision
/// (mirrors wsl-filesystem FR-5). A worktree session needs no special
/// handling (FR-7): `SessionMeta.cwd` already IS the worktree path, so the
/// plain FR-6 branch below opens it, never the source repo. Pure.
#[cfg(test)]
pub(crate) fn launch_argv(editor_path: &str, cwd: &str) -> Vec<String> {
    launch_argv_at(editor_path, cwd, None)
}

/// code-editor FR-15: `launch_argv` plus an optional `(rel_file, line)` target,
/// opened with `-g <file>[:<line>]` next to the folder. Pure.
pub(crate) fn launch_argv_at(
    editor_path: &str,
    cwd: &str,
    target: Option<(&str, Option<u32>)>,
) -> Vec<String> {
    let goto = |file: String, line: Option<u32>| match line {
        Some(l) => format!("{file}:{l}"),
        None => file,
    };
    if let Some((rel, line)) = target {
        if let Some((distro, linux_path)) = wsl_unc_to_linux(cwd) {
            let file = format!("{}/{rel}", linux_path.trim_end_matches('/'));
            return vec![
                editor_path.to_string(),
                "--remote".to_string(),
                format!("wsl+{distro}"),
                linux_path,
                "-g".to_string(),
                goto(file, line),
            ];
        }
        let file = std::path::Path::new(cwd).join(rel);
        return vec![
            editor_path.to_string(),
            cwd.to_string(),
            "-g".to_string(),
            goto(file.to_string_lossy().into_owned(), line),
        ];
    }
    if let Some((distro, linux_path)) = wsl_unc_to_linux(cwd) {
        return vec![
            editor_path.to_string(),
            "--folder-uri".to_string(),
            wsl_folder_uri(&distro, &linux_path),
        ];
    }
    vec![editor_path.to_string(), cwd.to_string()]
}

// ---------- FR-8: spawn (argv array, never a shell string; not awaited) ----------

fn spawn_editor(argv: &[String]) -> std::io::Result<()> {
    crate::process_util::spawn(&argv[0])
        .args(&argv[1..])
        .start()
        .map(|_child| ())
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
/// (FR-8). No session mutation, no event, no disk write (FR-12).
#[cfg(test)]
pub(crate) fn open_in_editor_impl(
    editors: &[EditorInfo],
    cwd: &str,
    editor_id: EditorId,
) -> IpcResult<Option<()>> {
    open_in_editor_at_impl(editors, cwd, editor_id, None)
}

pub(crate) fn open_in_editor_at_impl(
    editors: &[EditorInfo],
    cwd: &str,
    editor_id: EditorId,
    target: Option<(&str, Option<u32>)>,
) -> IpcResult<Option<()>> {
    let Some(editor) = editors.iter().find(|e| e.id == editor_id) else {
        return err_detail(
            ErrorCode::EditorNotFound,
            "that editor is not installed",
            json!({ "editorId": editor_id }),
        );
    };
    let argv = launch_argv_at(&editor.path, cwd, target);
    match spawn_editor(&argv) {
        Ok(()) => ok(None),
        Err(e) => err_detail(
            ErrorCode::EditorLaunchFailed,
            format!("could not launch the editor: {e}"),
            json!({ "path": editor.path }),
        ),
    }
}

/// code-editor FR-15: launch `editor_id` at `dir`, optionally on `file` (relative
/// to `dir`, through the same path safety as the editor) at a 1-based `line`.
/// Shared by `session_open_in_editor` and `editor_open_external`.
pub(crate) fn open_external_impl(
    editors: &[EditorInfo],
    dir: &str,
    editor_id: EditorId,
    file: Option<&str>,
    line: Option<u32>,
) -> IpcResult<Option<()>> {
    let rel = match file {
        Some(f) => match files::resolve(dir, f) {
            Ok(r) => Some(r.rel),
            Err(e) => return e.into(),
        },
        None => None,
    };
    let target = rel.as_deref().map(|r| (r, line));
    open_in_editor_at_impl(editors, dir, editor_id, target)
}

/// francois:session:openInEditor (FR-4..FR-12; code-editor FR-15 adds `file`/`line`).
#[tauri::command(async)]
pub fn session_open_in_editor(
    engine: State<'_, Engine>,
    session_id: String,
    editor_id: EditorId,
    file: Option<String>,
    line: Option<u32>,
) -> IpcResult<Option<()>> {
    if let Err(e) = engine.ensure_available(&session_id) {
        return e.into();
    }
    let Some(cwd) = engine.cwd_of(&session_id) else {
        return err(ErrorCode::SessionNotFound, "no such session");
    };
    open_external_impl(&cached_editors(), &cwd, editor_id, file.as_deref(), line)
}

// ---------- code-editor: model (mirrors contract/code-editor.ts EXACTLY) ----------

pub(crate) const EDITOR_EDIT_CAP_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const EDITOR_OPEN_CAP_BYTES: u64 = 10 * 1024 * 1024;
pub(crate) const EDITOR_BINARY_SNIFF_BYTES: usize = 8 * 1024;
pub(crate) const EDITOR_FILES_CAP: usize = 20_000;
pub(crate) const EDITOR_WATCH_DEBOUNCE_MS: u64 = 150;

/// FR-3: a root is always named, never a raw path.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Hash, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EditorRoot {
    #[serde(rename_all = "camelCase")]
    Project { project_id: String },
    #[serde(rename_all = "camelCase")]
    Session { session_id: String },
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    Lf,
    Crlf,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum ReadOnlyReason {
    TooLarge,
    Permission,
}

/// FR-5: `M` modified, `A` added or untracked.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum GitChange {
    M,
    A,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorFile {
    pub root: EditorRoot,
    pub path: String,
    pub text: String,
    pub version: String,
    pub line_ending: LineEnding,
    pub bom: bool,
    pub trailing_newline: bool,
    pub read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only_reason: Option<ReadOnlyReason>,
    pub head_text: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EditorSaveData {
    pub version: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorFilesData {
    pub root_label: String,
    pub branch: Option<String>,
    pub paths: Vec<String>,
    pub truncated: bool,
    pub changes: BTreeMap<String, GitChange>,
}

/// `francois://editor/event`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type")]
pub enum EditorEvent {
    #[serde(rename = "editor.changed")]
    Changed {
        root: EditorRoot,
        path: String,
        version: String,
    },
    #[serde(rename = "editor.deleted")]
    Deleted { root: EditorRoot, path: String },
}

// ---------- code-editor: commands ----------

type CoreResult<T> = Result<T, crate::ipc::AppError>;

fn to_ipc<T: Serialize>(r: CoreResult<T>) -> IpcResult<T> {
    match r {
        Ok(v) => ok(v),
        Err(e) => e.into(),
    }
}

/// FR-3 against the live engine + project registry.
fn live_root(app: &AppHandle, engine: &Engine, root: &EditorRoot) -> CoreResult<root::RootDir> {
    root::resolve_root(root, engine, |id| crate::project::name_and_root(app, id))
}

fn event_emitter(app: &AppHandle) -> watch::Emitter {
    let app = app.clone();
    Arc::new(move |ev| {
        let _ = app.emit("francois://editor/event", &ev);
    })
}

/// francois:editor:files (FR-4/FR-5).
pub(crate) fn files_impl(dir: &root::RootDir) -> CoreResult<EditorFilesData> {
    if !std::path::Path::new(&dir.dir).is_dir() {
        return Err(crate::ipc::AppError::new(
            ErrorCode::Internal,
            "the root directory no longer exists",
        ));
    }
    let l = listing::list(&dir.dir);
    Ok(EditorFilesData {
        root_label: dir.label.clone(),
        branch: l.branch,
        paths: l.paths,
        truncated: l.truncated,
        changes: l.changes,
    })
}

/// francois:editor:open — idempotent: re-reads disk, keeps exactly one watch.
pub(crate) fn open_impl(
    dir: &str,
    state: &EditorState,
    emit: watch::Emitter,
    root: &EditorRoot,
    path: &str,
) -> CoreResult<EditorFile> {
    let resolved = files::resolve(dir, path)?;
    let file = files::open_file(dir, root, &resolved)?;
    state.watch(
        root,
        &resolved.rel,
        &resolved.abs,
        Some(file.version.clone()),
        emit,
    );
    Ok(file)
}

/// francois:editor:save.
pub(crate) struct SaveInput<'a> {
    pub text: &'a str,
    pub base_version: &'a str,
    pub line_ending: LineEnding,
    pub bom: bool,
}

pub(crate) fn save_impl(
    dir: &str,
    state: &EditorState,
    root: &EditorRoot,
    path: &str,
    input: SaveInput<'_>,
) -> CoreResult<EditorSaveData> {
    let resolved = files::resolve(dir, path)?;
    let version = files::save_file(
        &resolved.abs,
        input.text,
        input.base_version,
        input.line_ending,
        input.bom,
    )?;
    state.record(root, &resolved.rel, &version);
    Ok(EditorSaveData { version })
}

/// francois:editor:close — stops the watch; an unwatched (or unresolvable) path is ok.
pub(crate) fn close_impl(dir: &str, state: &EditorState, root: &EditorRoot, path: &str) {
    let rel = match files::resolve(dir, path) {
        Ok(r) => r.rel,
        // The root vanished: fall back to the textual form open() would have produced.
        Err(_) => path.replace('\\', "/").trim_start_matches("./").to_string(),
    };
    state.unwatch(root, &rel);
}

#[tauri::command(async)]
pub fn editor_files(
    app: AppHandle,
    engine: State<'_, Engine>,
    root: EditorRoot,
) -> IpcResult<EditorFilesData> {
    to_ipc(live_root(&app, &engine, &root).and_then(|d| files_impl(&d)))
}

#[tauri::command(async)]
pub fn editor_open(
    app: AppHandle,
    engine: State<'_, Engine>,
    state: State<'_, EditorState>,
    root: EditorRoot,
    path: String,
) -> IpcResult<EditorFile> {
    to_ipc(
        live_root(&app, &engine, &root)
            .and_then(|d| open_impl(&d.dir, &state, event_emitter(&app), &root, &path)),
    )
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)] // one argument per contract field + the three Tauri injections
pub fn editor_save(
    app: AppHandle,
    engine: State<'_, Engine>,
    state: State<'_, EditorState>,
    root: EditorRoot,
    path: String,
    text: String,
    base_version: String,
    line_ending: LineEnding,
    bom: bool,
) -> IpcResult<EditorSaveData> {
    to_ipc(live_root(&app, &engine, &root).and_then(|d| {
        let input = SaveInput {
            text: &text,
            base_version: &base_version,
            line_ending,
            bom,
        };
        save_impl(&d.dir, &state, &root, &path, input)
    }))
}

#[tauri::command(async)]
pub fn editor_close(
    app: AppHandle,
    engine: State<'_, Engine>,
    state: State<'_, EditorState>,
    root: EditorRoot,
    path: String,
) -> IpcResult<Option<()>> {
    to_ipc(live_root(&app, &engine, &root).map(|d| {
        close_impl(&d.dir, &state, &root, &path);
        None
    }))
}

/// francois:editor:openExternal (FR-15) — for `project` roots; session roots work too.
#[tauri::command(async)]
pub fn editor_open_external(
    app: AppHandle,
    engine: State<'_, Engine>,
    root: EditorRoot,
    editor_id: EditorId,
    file: String,
    line: Option<u32>,
) -> IpcResult<Option<()>> {
    match live_root(&app, &engine, &root) {
        Ok(d) => open_external_impl(&cached_editors(), &d.dir, editor_id, Some(&file), line),
        Err(e) => e.into(),
    }
}

/// Registered with the session teardown seam: a session root's watches die with it.
pub struct EditorTeardown;

impl crate::session::SessionTeardown for EditorTeardown {
    fn dispose_session(&self, app: &AppHandle, session_id: &str) -> usize {
        let root = EditorRoot::Session {
            session_id: session_id.to_string(),
        };
        app.try_state::<EditorState>()
            .map_or(0, |s| s.drop_root(&root))
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::{Path, PathBuf};

    /// A throwaway directory removed on drop.
    pub struct TempDir(PathBuf);
    impl TempDir {
        pub fn new() -> Self {
            let p = std::env::temp_dir().join(format!("francois-editor-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        pub fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub fn git(dir: &Path, args: &[&str]) {
        let status = crate::process_util::spawn("git")
            .args([
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }
}
