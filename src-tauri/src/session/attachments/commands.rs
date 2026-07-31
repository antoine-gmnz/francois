//! The six `session_*` attachment commands (spec §5.2).
//!
//! Shape shared by all of them: read what is needed under the engine lock, do
//! every filesystem operation with NO lock held, then re-take the lock to record
//! the outcome and persist. Nothing here decides anything — the decisions live in
//! `ingest`/`retention`, which are testable without a Tauri `AppHandle`.
//!
//! The rule has no exception, and `session_clear_attachments` is why it is worth
//! stating: `Engine.sessions` is ONE mutex over EVERY session in the app, so disk
//! work held under it stalls unrelated sessions' turns and IPC — a project clear
//! would hold it for a crawl over every session dir of the project. The sweep
//! therefore runs unlocked, ordered so that it still cannot orphan a file
//! (`retention::clear_session` carries the argument).

use super::*;
use crate::ipc::{err, err_detail, ok, IpcResult};
use crate::session::{now_ms, persist};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

const NO_SESSION: &str = "no such session";

/// Serialize a record for the envelope. Serialization of these shapes cannot
/// fail in practice, and when it somehow does, `null` is what the rest of the
/// core answers with (`persistence.rs` uses the same fallback for the very same
/// `Attachment` type) — panicking the command task is never the better answer.
fn json_of<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Turn a pipeline refusal into the IPC envelope, keeping FR-8's `detail`.
fn refuse<T: Serialize>(e: AttachError) -> IpcResult<T> {
    match e.detail {
        Some(detail) => err_detail(e.code, e.message, detail),
        None => err(e.code, e.message),
    }
}

/// Record freshly ingested refs and persist. `false` when the session vanished
/// while the bytes were being written (no lock is held during IO): the copies are
/// then deleted again rather than orphaned under a cwd nothing points at any more.
fn record_staged(
    app: &AppHandle,
    engine: &Engine,
    session_id: &str,
    staged: &[Attachment],
) -> bool {
    let recorded = engine.with_session_mut(session_id, |s| {
        for a in staged {
            s.stage_attachment(a.clone());
        }
    });
    if recorded.is_none() {
        for a in staged {
            delete_stored(a);
        }
        return false;
    }
    persist(app, engine);
    // FR-12: the chip's thumbnail is read off disk BY THE WEBVIEW, through the
    // asset protocol — which serves nothing outside its scope. The grant is made
    // once the record exists and covers exactly these files (see `asset_scope`).
    allow_thumbnails(app, staged);
    true
}

/// The single-ref path: record it, or refuse and take the bytes back.
fn stage_one(
    app: &AppHandle,
    engine: &Engine,
    session_id: &str,
    attachment: Attachment,
) -> IpcResult<Value> {
    let value = json_of(&attachment);
    if record_staged(app, engine, session_id, std::slice::from_ref(&attachment)) {
        ok(value)
    } else {
        err("SESSION_NOT_FOUND", NO_SESSION)
    }
}

/// francois:session:attachFile (FR-1).
#[tauri::command(async)]
pub fn session_attach_file(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    path: String,
) -> IpcResult<Value> {
    let Some(cwd) = engine.cwd_of(&session_id) else {
        return err("SESSION_NOT_FOUND", NO_SESSION);
    };
    match ingest_path(&session_id, &cwd, &path, now_ms()) {
        Ok(a) => stage_one(&app, &engine, &session_id, a),
        Err(e) => refuse(e),
    }
}

/// francois:session:attachClipboardImage (FR-6).
#[tauri::command(async)]
pub fn session_attach_clipboard_image(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    mime: String,
    data_base64: String,
) -> IpcResult<Value> {
    let Some(cwd) = engine.cwd_of(&session_id) else {
        return err("SESSION_NOT_FOUND", NO_SESSION);
    };
    match ingest_clipboard_image(&session_id, &cwd, &mime, &data_base64, now_ms()) {
        Ok(a) => stage_one(&app, &engine, &session_id, a),
        Err(e) => refuse(e),
    }
}

/// francois:session:pickAttachments (FR-9). The native multi-select dialog opens
/// HERE, in the core, so the frontend stays entirely on `invoke`. Every pick is
/// ingested independently: successes land in `attached`, refusals in `failed`
/// (never as a call-level error), and a cancelled dialog is `ok: true` with both
/// arrays empty.
///
/// `async fn` + `spawn_blocking`: the dialog stays open for as long as the user
/// browses, and waiting for it on an async-runtime worker starves every other
/// `invoke` for that whole time. `Engine` is resolved via `app.state()` rather
/// than a `State<'_, Engine>` parameter — a borrowed param cannot cross an
/// `.await` in the generated handler (same reason as the `diff` commands).
#[tauri::command]
pub async fn session_pick_attachments(app: AppHandle, session_id: String) -> IpcResult<Value> {
    use tauri_plugin_dialog::DialogExt;
    let engine = app.state::<Engine>();
    let Some(cwd) = engine.cwd_of(&session_id) else {
        return err("SESSION_NOT_FOUND", NO_SESSION);
    };
    let dialog_app = app.clone();
    let picks = match tauri::async_runtime::spawn_blocking(move || {
        dialog_app.dialog().file().blocking_pick_files()
    })
    .await
    {
        Ok(Some(picks)) => picks,
        // FR-9: cancelling is a normal outcome, not an error.
        Ok(None) => return ok(json_of(&PickAttachmentsResponse::default())),
        Err(e) => {
            return err(
                "ATTACHMENT_IO_FAILED",
                format!("the file picker failed: {e}"),
            )
        }
    };
    let (paths, unresolvable) = split_picks(picks);
    let mut response = ingest_picks(&session_id, &cwd, &paths, now_ms());
    response.failed.extend(unresolvable);
    if !response.attached.is_empty()
        && !record_staged(&app, &engine, &session_id, &response.attached)
    {
        return err("SESSION_NOT_FOUND", NO_SESSION);
    }
    ok(json_of(&response))
}

/// Split the dialog's picks into ingestible paths and per-entry refusals.
///
/// A pick is a `FilePath`, which is a path OR a URI: `into_path` resolves the
/// `file://` flavour some desktop portals hand back, and what remains (an Android
/// `content://` handle, any non-file scheme) has no path the copy could ever
/// read. FR-9 says every refusal is REPORTED, per file — dropping such an entry
/// silently makes it indistinguishable from a file the user never picked.
fn split_picks(picks: Vec<tauri_plugin_dialog::FilePath>) -> (Vec<String>, Vec<AttachFailure>) {
    let mut paths = Vec::new();
    let mut failed = Vec::new();
    for pick in picks {
        let shown = pick.to_string();
        match pick.into_path() {
            Ok(p) => paths.push(p.to_string_lossy().to_string()),
            Err(_) => failed.push(AttachFailure {
                name: file_name_of(std::path::Path::new(&shown)),
                error: AttachError::io(
                    std::path::Path::new(&shown),
                    "that item has no file path Francois can read",
                )
                .to_app_error(),
            }),
        }
    }
    (paths, failed)
}

/// francois:session:releaseAttachment (FR-13).
///
/// Only a STAGED ref is releasable: `take_attachment` refuses to claim a `sent`
/// one, so this answers `ATTACHMENT_NOT_FOUND` rather than deleting bytes the
/// transcript still points at (FR-15's invariant, enforced by the core and not
/// merely by the frontend offering `×` on staged chips only).
#[tauri::command(async)]
pub fn session_release_attachment(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    attachment_id: String,
) -> IpcResult<Option<()>> {
    let Some(taken) = engine.with_session_mut(&session_id, |s| s.take_attachment(&attachment_id))
    else {
        return err("SESSION_NOT_FOUND", NO_SESSION);
    };
    let Some(attachment) = taken else {
        return refuse(AttachError::not_found());
    };
    delete_stored(&attachment); // a copied: false origin is never touched
    persist(&app, &engine);
    ok(None)
}

/// francois:session:commitAttachments (FR-15).
#[tauri::command(async)]
pub fn session_commit_attachments(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    text: String,
) -> IpcResult<Value> {
    let Some((result, dropped)) =
        engine.with_session_mut(&session_id, |s| s.commit_attachments(&text))
    else {
        return err("SESSION_NOT_FOUND", NO_SESSION);
    };
    for a in &dropped {
        delete_stored(a);
    }
    persist(&app, &engine);
    ok(json_of(&result))
}

/// francois:session:clearAttachments (FR-18).
#[tauri::command(async)]
pub fn session_clear_attachments(
    app: AppHandle,
    engine: State<'_, Engine>,
    scope: ClearScope,
) -> IpcResult<Value> {
    let targets = match &scope {
        ClearScope::Session { session_id } => match engine.cwd_of(session_id) {
            Some(cwd) => vec![(session_id.clone(), cwd)],
            None => return err("SESSION_NOT_FOUND", NO_SESSION),
        },
        ClearScope::Project { project_id } => {
            // FR-18: the sweep is driven by the SESSION REGISTRY, which is what
            // includes sessions running in worktrees (their cwd is nowhere near
            // the project root, so a filesystem crawl would miss them).
            if !crate::project::known_ids(&app).contains(project_id) {
                return err("PROJECT_NOT_FOUND", "no such project");
            }
            engine.sessions_of_project(project_id)
        }
    };
    let mut stats = ClearAttachmentsResult::default();
    for (session_id, cwd) in targets {
        // Records under the lock, bytes outside it — `clear_session` carries the
        // ordering argument and why the reverse (sweeping under the lock) stalls
        // EVERY session in the app, not just this one.
        stats.merge(clear_session(&engine, &session_id, &cwd));
    }
    persist(&app, &engine);
    ok(json_of(&stats))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tauri_plugin_dialog::FilePath;

    #[test]
    fn picks_resolve_paths_and_file_urls() {
        // A `file://` URL only resolves in the HOST's own dialect — Windows wants
        // a drive letter where unix wants a rooted path.
        #[cfg(windows)]
        let url = "file:///C:/repo/shot.png";
        #[cfg(not(windows))]
        let url = "file:///repo/shot.png";
        let picks = vec![
            FilePath::from_str("/repo/notes.txt").unwrap(),
            FilePath::from_str(url).unwrap(),
        ];

        let (paths, failed) = split_picks(picks);

        assert!(failed.is_empty(), "both entries carry a filesystem path");
        assert_eq!(paths.len(), 2);
        assert!(paths[0].ends_with("notes.txt"));
        assert!(
            paths[1].ends_with("shot.png"),
            "a file:// pick resolves to a path rather than being refused: {paths:?}"
        );
    }

    #[test]
    fn a_pick_with_no_filesystem_path_is_reported_not_dropped() {
        // FR-9: "every refusal is reported, per file". A `FilePath::Url` that is
        // not a `file://` URL (an Android `content://` handle, a portal URI) has
        // no path the copy could read — dropping it silently makes it
        // indistinguishable from a file the user never picked.
        let picks = vec![FilePath::from_str("content://media/external/images/1234").unwrap()];

        let (paths, failed) = split_picks(picks);

        assert!(paths.is_empty());
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].name, "1234", "the refusal names the file");
        assert_eq!(failed[0].error.code, "ATTACHMENT_IO_FAILED");
        assert!(failed[0].error.detail.is_some(), "detail carries the path");
    }
}
