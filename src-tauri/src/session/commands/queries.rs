//! read-only / misc commands: transcript fetch, directory picker, session list.

use crate::ipc::{err, ok, IpcResult};
use crate::session::*;
use serde_json::Value;
use tauri::{AppHandle, State};

/// francois:conversation:getTranscript — owned by conversation-view (spec §5).
/// Returns the session's in-memory transcript buffer as ConversationBlock[].
#[tauri::command(async)]
pub fn conversation_get_transcript(
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Vec<Value>> {
    let transcript: Option<Vec<Value>> = engine
        .with_session(&session_id, |s| s.block_buffer.iter().map(classify_block).collect());
    match transcript {
        None => err("SESSION_NOT_FOUND", "no such session"),
        Some(blocks) => ok(blocks),
    }
}

/// francois:session:pickDirectory — owned by sessions-sidebar (spec §5).
/// Opens the native OS directory dialog. `data: null` = user cancelled. A picked
/// item WITHOUT a filesystem path (shell-namespace nodes — e.g. the "Linux"
/// entry itself in Explorer's sidebar) is an ERROR, not a cancel: silently doing
/// nothing after a successful pick reads as a dead Browse button.
#[tauri::command(async)]
pub fn session_pick_directory(app: AppHandle) -> IpcResult<Option<Value>> {
    use tauri_plugin_dialog::DialogExt;
    match app.dialog().file().blocking_pick_folder() {
        Some(fp) => match fp.as_path().map(|p| p.to_string_lossy().to_string()) {
            Some(path) => ok(Some(serde_json::json!({ "path": path }))),
            None => err(
                "INVALID_INPUT",
                "that location has no filesystem path — pick a folder inside it, or paste its path (e.g. \\\\wsl$\\<distro>\\…) into the directory field",
            ),
        },
        None => ok(None),
    }
}

#[tauri::command(async)]
pub fn session_list(app: AppHandle, engine: State<'_, Engine>) -> IpcResult<Vec<Value>> {
    // FR-12: re-emit one session.meta per entry (registry order) before resolving.
    let metas: Vec<SessionMeta> = {
        let map = engine.sessions.lock().unwrap();
        map.values().map(|s| s.meta()).collect()
    };
    for m in &metas {
        emit(&app, SessionEvent::Meta { meta: m.clone() });
    }
    ok(metas
        .into_iter()
        .map(|m| serde_json::to_value(m).unwrap())
        .collect())
}
