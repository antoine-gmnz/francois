//! read-only / misc commands: transcript fetch, directory picker, session list.

use crate::ipc::{err, ok, IpcResult};
use crate::session::*;
use serde_json::Value;
use tauri::{AppHandle, State};

/// transcript-scale FR-9: clamp the client's requested page size into `1..=500`,
/// defaulting to 200 — an out-of-range value is corrected, never `INVALID_INPUT`.
fn clamp_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(200).clamp(1, 500)
}

/// transcript-scale FR-6: no `before` ⇒ the in-memory tail, oldest-first, capped
/// at `limit`. `hasMore` folds together two cases that both mean "a block older
/// than the first returned one exists in the persisted transcript": the buffer
/// holding more than `limit` (still in memory), and `truncated` — the buffer
/// having ever been trimmed past `TRANSCRIPT_BUFFER_CAP` (FR-1/2/3). Either way
/// the excluded block is already on disk, flushed by `append_transcript` long
/// before it aged out of memory.
fn tail_page(buffer: &[BufBlock], truncated: bool, limit: usize) -> Value {
    let start = buffer.len().saturating_sub(limit);
    let has_more = truncated || start > 0;
    let blocks: Vec<Value> = buffer[start..].iter().map(classify_block).collect();
    serde_json::json!({ "blocks": blocks, "hasMore": has_more })
}

/// transcript-scale FR-6/FR-9: the no-`before` page for a live session, resolved
/// entirely from `Engine` — no `AppHandle`, so this is the piece unit tests can
/// reach directly (the command below is otherwise untestable, same precedent
/// as every other `AppHandle`-consuming command in this module).
fn transcript_tail(engine: &Engine, session_id: &str, limit: usize) -> Option<Value> {
    engine.with_session(session_id, |s| {
        tail_page(&s.block_buffer, s.transcript_truncated, limit)
    })
}

/// transcript-scale FR-7/FR-8: `before` ⇒ page backwards over the FOLDED
/// persisted transcript (`folded`, already `parse_transcript`-upserted by
/// blockId — never raw line offsets, since a resolved question/permission
/// block folds two lines into one entry). A `before` absent from the fold
/// (e.g. `/clear`ed since, or a transcript that was never persisted) resolves
/// an empty page rather than an error.
fn page_before(folded: &[BufBlock], before: &str, limit: usize) -> Value {
    match folded.iter().position(|b| b.block_id == before) {
        None => serde_json::json!({ "blocks": Vec::<Value>::new(), "hasMore": false }),
        Some(idx) => {
            let start = idx.saturating_sub(limit);
            let has_more = start > 0;
            let blocks: Vec<Value> = folded[start..idx].iter().map(classify_block).collect();
            serde_json::json!({ "blocks": blocks, "hasMore": has_more })
        }
    }
}

/// francois:conversation:getTranscript — owned by conversation-view (spec §5),
/// paged per transcript-scale FR-5..FR-9. No `before` reads the in-memory tail
/// under the sessions lock; a `before` page re-reads and re-folds the on-disk
/// transcript (FR-8, deliberately no cache) OUTSIDE that lock — only a quick
/// existence check happens under it.
#[tauri::command(async)]
pub fn conversation_get_transcript(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    before: Option<String>,
    limit: Option<usize>,
) -> IpcResult<Value> {
    let limit = clamp_limit(limit);
    match before {
        None => match transcript_tail(&engine, &session_id, limit) {
            None => err("SESSION_NOT_FOUND", "no such session"),
            Some(page) => ok(page),
        },
        Some(before_id) => {
            // This existence check and the `read_transcript` below are not
            // atomic — a `session_remove` racing between them resolves `ok`
            // with an empty page instead of `SESSION_NOT_FOUND`. Accepted:
            // harmless (the frontend already treats an empty page as "nothing
            // more to load"), and matches the "file missing" edge case §7
            // already documents for a transcript read after removal.
            if engine.with_session(&session_id, |_| ()).is_none() {
                return err("SESSION_NOT_FOUND", "no such session");
            }
            let folded = read_transcript(&app, &session_id);
            ok(page_before(&folded, &before_id, limit))
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::{test_engine_with, test_session};

    fn user_blocks(ids: &[&str]) -> Vec<BufBlock> {
        ids.iter()
            .map(|id| {
                let mut s = test_session();
                s.buf_user(id, format!("text-{id}"));
                s.block_buffer.pop().unwrap()
            })
            .collect()
    }

    // ---------- FR-9: limit clamping ----------

    #[test]
    fn clamp_limit_defaults_to_200() {
        assert_eq!(clamp_limit(None), 200);
    }

    #[test]
    fn clamp_limit_clamps_zero_up_to_one() {
        assert_eq!(clamp_limit(Some(0)), 1);
    }

    #[test]
    fn clamp_limit_clamps_an_oversized_request_down_to_500() {
        assert_eq!(clamp_limit(Some(9_999)), 500);
    }

    #[test]
    fn clamp_limit_passes_through_an_in_range_value() {
        assert_eq!(clamp_limit(Some(42)), 42);
    }

    // ---------- FR-6: no-`before` tail ----------

    #[test]
    fn tail_page_returns_everything_when_under_the_limit_and_untruncated() {
        let blocks = user_blocks(&["b1", "b2", "b3"]);
        let page = tail_page(&blocks, false, 200);
        assert_eq!(page["blocks"].as_array().unwrap().len(), 3);
        assert_eq!(page["hasMore"], false);
    }

    #[test]
    fn tail_page_has_more_when_the_buffer_holds_more_than_the_limit() {
        let blocks = user_blocks(&["b1", "b2", "b3"]);
        let page = tail_page(&blocks, false, 2);
        let got: Vec<&str> = page["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["blockId"].as_str().unwrap())
            .collect();
        assert_eq!(got, vec!["b2", "b3"]); // the tail, oldest-first
        assert_eq!(page["hasMore"], true);
    }

    #[test]
    fn tail_page_has_more_when_truncated_even_if_the_limit_covers_everything_held() {
        let blocks = user_blocks(&["b1"]);
        let page = tail_page(&blocks, true, 200);
        assert_eq!(page["hasMore"], true);
    }

    #[test]
    fn transcript_tail_is_none_for_an_unknown_session() {
        let engine = test_engine_with(test_session());
        assert!(transcript_tail(&engine, "nope", 200).is_none());
    }

    #[test]
    fn transcript_tail_reads_the_live_buffer_through_the_engine() {
        let engine = test_engine_with(test_session());
        engine.with_session_mut("s1", |s| {
            s.buf_user("b1", "hi".into());
        });
        let page = transcript_tail(&engine, "s1", 200).unwrap();
        assert_eq!(page["blocks"].as_array().unwrap().len(), 1);
        assert_eq!(page["hasMore"], false);
    }

    // ---------- FR-7/FR-8: `before` paging over the folded transcript ----------

    #[test]
    fn page_before_returns_an_empty_page_when_the_block_is_not_in_the_fold() {
        let blocks = user_blocks(&["b1", "b2"]);
        let page = page_before(&blocks, "missing", 200);
        assert_eq!(page["blocks"].as_array().unwrap().len(), 0);
        assert_eq!(page["hasMore"], false);
    }

    #[test]
    fn page_before_returns_an_empty_page_for_a_never_persisted_transcript() {
        let page = page_before(&[], "b1", 200);
        assert_eq!(page["blocks"].as_array().unwrap().len(), 0);
        assert_eq!(page["hasMore"], false);
    }

    #[test]
    fn page_before_pages_oldest_first_and_reports_has_more() {
        let blocks = user_blocks(&["b1", "b2", "b3", "b4", "b5"]);
        let page = page_before(&blocks, "b4", 2);
        let got: Vec<&str> = page["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["blockId"].as_str().unwrap())
            .collect();
        assert_eq!(got, vec!["b2", "b3"]); // immediately before b4, oldest-first
        assert_eq!(page["hasMore"], true); // b1 remains
    }

    #[test]
    fn page_before_the_oldest_block_has_no_more() {
        let blocks = user_blocks(&["b1", "b2", "b3"]);
        let page = page_before(&blocks, "b1", 200);
        assert_eq!(page["blocks"].as_array().unwrap().len(), 0);
        assert_eq!(page["hasMore"], false);
    }

    #[test]
    fn page_before_folds_a_question_asked_then_answered_to_one_entry_and_never_splits_it() {
        // FR-7: paging is computed over the FOLDED sequence — a question
        // written twice (ask + resolve) must fold to one entry before paging,
        // so no page boundary can land mid-fold.
        let content = concat!(
            r#"{"blockId":"u1","kind":"user","text":"hi","tool":"","summary":"","meta":null}"#,
            "\n",
            r#"{"blockId":"q1","kind":"question","questions":[{"question":"Q","header":"H","options":[],"multiSelect":false}],"state":"pending"}"#,
            "\n",
            r#"{"blockId":"a1","kind":"assistant","text":"ok","tool":"","summary":"","meta":null}"#,
            "\n",
            r#"{"blockId":"q1","kind":"question","questions":[{"question":"Q","header":"H","options":[],"multiSelect":false}],"state":"answered","answers":{"Q":"A"}}"#,
            "\n",
        );
        let folded = crate::session::parse_transcript(content);
        assert_eq!(folded.len(), 3); // u1, q1, a1 — one entry per blockId

        let page = page_before(&folded, "a1", 200);
        let blocks = page["blocks"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["blockId"], "u1");
        assert_eq!(blocks[1]["blockId"], "q1");
        assert_eq!(blocks[1]["state"], "answered"); // resolved, not the pending write
        assert_eq!(page["hasMore"], false);
    }
}
