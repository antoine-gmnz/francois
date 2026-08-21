//! FR-16/FR-17 — the adapter-owned thread file.
//!
//! `<appData>/threads/<sessionId>.json` holds the WIRE messages the API
//! accepts, deliberately not merged into the durable-sessions transcript, which
//! is a render model. Collapsing the two would make every future adapter's wire
//! format the UI's problem (decision 2026-08-12, `_decisions.md`).
//!
//! This module owns the wire message shape (`ThreadMessage`/`ThreadToolCall`),
//! since it is the file that must serialize/deserialize it byte-for-byte; the
//! Chat Completions codec (`wire.rs`) constructs and reads the same type when
//! it builds a request body or accumulates a streamed tool call.

use crate::session::*;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// One Chat Completions message — exactly the wire shape both the request
/// body and the persisted thread file use. `role` is `"system"` | `"user"` |
/// `"assistant"` | `"tool"`; `tool_calls` only appears on an assistant
/// message that invoked tools, `tool_call_id` only on the `tool` message that
/// answers one of them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ThreadMessage {
    pub(crate) role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) content: Option<String>,
    #[serde(
        default,
        rename = "tool_calls",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) tool_calls: Option<Vec<ThreadToolCall>>,
    #[serde(
        default,
        rename = "tool_call_id",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) tool_call_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ThreadToolCall {
    pub(crate) id: String,
    #[serde(rename = "type", default = "function_call_kind")]
    pub(crate) kind: String,
    pub(crate) function: ThreadToolCallFunction,
}

fn function_call_kind() -> String {
    "function".into()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ThreadToolCallFunction {
    pub(crate) name: String,
    pub(crate) arguments: String,
}

// ---------- paths ----------

/// The sanitized `threads/<sessionId>.json` filename, `None` when `session_id`
/// would escape the directory. Split out from `thread_path` so the traversal
/// guard is unit-testable without a live `AppHandle` (this crate wires up no
/// such harness — see `session/env.rs`'s module doc).
fn thread_file_name(session_id: &str) -> Option<String> {
    valid_session_id(session_id).then(|| format!("{session_id}.json"))
}

/// `<appData>/threads/<sessionId>.json` — same sanitization `transcript_path`
/// uses (persistence.rs FR-42/43), so a session id can never escape the
/// threads dir.
pub(crate) fn thread_path(app: &AppHandle, session_id: &str) -> Option<PathBuf> {
    let name = thread_file_name(session_id)?;
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("threads").join(name))
}

// ---------- I/O (pure over a Path, so it's testable without an AppHandle) ----------

/// FR-16: atomic (temp + rename) write of the message array.
pub(crate) fn write_thread_file(path: &Path, messages: &[ThreadMessage]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(messages).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// FR-17's three outcomes, kept distinct so a brand-new session (no thread
/// file yet — nothing to resume) never fires the same signal as a corrupted
/// one: only `Corrupt` is a degrade.
#[derive(Debug, PartialEq)]
pub(crate) enum ThreadLoad {
    /// No file at this path yet.
    Fresh,
    /// The file was there and parsed clean.
    Ok(Vec<ThreadMessage>),
    /// The file was there but unreadable or malformed.
    Corrupt,
}

/// FR-17: read the persisted array back. Never panics on a missing or
/// malformed file — the caller (`load_thread`) turns `Corrupt` into the
/// `session.resumeFailed` degrade, `Fresh` into silently starting empty.
pub(crate) fn read_thread_file(path: &Path) -> ThreadLoad {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<Vec<ThreadMessage>>(&bytes) {
            Ok(messages) => ThreadLoad::Ok(messages),
            Err(_) => ThreadLoad::Corrupt,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ThreadLoad::Fresh,
        Err(_) => ThreadLoad::Corrupt,
    }
}

// ---------- the loop's entry points ----------

/// FR-17 end to end: resolve the session's thread path, read it back, and —
/// only when the file existed but failed to parse — emit the same
/// `session.resumeFailed` degrade `--resume` rejection already takes (never a
/// failure to open the session; the rendered transcript is untouched, only
/// the wire array starts fresh). A session with no thread file yet (its very
/// first turn) is silently `Fresh` — nothing to resume, nothing to report.
pub(crate) fn load_thread(app: &AppHandle, session_id: &str) -> Vec<ThreadMessage> {
    let Some(path) = thread_path(app, session_id) else {
        return Vec::new();
    };
    match read_thread_file(&path) {
        ThreadLoad::Ok(messages) => messages,
        ThreadLoad::Fresh => Vec::new(),
        ThreadLoad::Corrupt => {
            emit(
                app,
                SessionEvent::ResumeFailed {
                    session_id: session_id.to_string(),
                },
            );
            Vec::new()
        }
    }
}

/// FR-16: best-effort save, same discipline `append_transcript`/`persist`
/// already use elsewhere in this domain — a write failure must never fail an
/// otherwise-successful turn. Call this ONLY with a message array that has
/// already gone through `drop_unanswered_tool_calls`, and never after a
/// stream cut mid-block (§7: "the thread file is not written").
pub(crate) fn save_thread(app: &AppHandle, session_id: &str, messages: &[ThreadMessage]) {
    let Some(path) = thread_path(app, session_id) else {
        return;
    };
    let _ = write_thread_file(&path, messages);
}

// ---------- FR-8's write-side consistency rule ----------

/// Pure over the message array, so the loop can call it before every write
/// without any I/O: an assistant message's `tool_calls` are trimmed to only
/// the ones a following `role: "tool"` message (matched by `tool_call_id`)
/// actually answered. A tool_call left dangling — the turn was interrupted
/// mid-call — is dropped rather than persisted, because the Chat Completions
/// API rejects an assistant message whose `tool_calls` aren't every one
/// answered on the very next request (FR-8, §9).
pub(crate) fn drop_unanswered_tool_calls(messages: &[ThreadMessage]) -> Vec<ThreadMessage> {
    let answered: std::collections::HashSet<&str> = messages
        .iter()
        .filter(|m| m.role == "tool")
        .filter_map(|m| m.tool_call_id.as_deref())
        .collect();

    messages
        .iter()
        .cloned()
        .map(|mut m| {
            if let Some(calls) = &m.tool_calls {
                let kept: Vec<ThreadToolCall> = calls
                    .iter()
                    .filter(|&c| answered.contains(c.id.as_str()))
                    .cloned()
                    .collect();
                m.tool_calls = if kept.is_empty() { None } else { Some(kept) };
            }
            m
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("francois-thread-{tag}-{}.json", uuid()))
    }

    fn user(text: &str) -> ThreadMessage {
        ThreadMessage {
            role: "user".into(),
            content: Some(text.into()),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    fn assistant_with_call(id: &str) -> ThreadMessage {
        ThreadMessage {
            role: "assistant".into(),
            content: None,
            tool_calls: Some(vec![ThreadToolCall {
                id: id.into(),
                kind: "function".into(),
                function: ThreadToolCallFunction {
                    name: "Bash".into(),
                    arguments: "{\"command\":\"ls\"}".into(),
                },
            }]),
            tool_call_id: None,
        }
    }

    fn tool_result(id: &str, content: &str) -> ThreadMessage {
        ThreadMessage {
            role: "tool".into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: Some(id.into()),
        }
    }

    // ---------- FR-16/FR-17: quit-and-reopen round-trips the array ----------

    #[test]
    fn write_then_read_round_trips_the_message_array() {
        let path = tmp_path("roundtrip");
        let messages = vec![
            user("hello"),
            assistant_with_call("call_1"),
            tool_result("call_1", "ok"),
        ];
        write_thread_file(&path, &messages).expect("write");
        match read_thread_file(&path) {
            ThreadLoad::Ok(back) => assert_eq!(back, messages),
            other => panic!("expected Ok, got {other:?}"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn write_is_atomic_temp_then_rename_and_creates_the_parent_dir() {
        let dir = std::env::temp_dir().join(format!("francois-thread-dir-{}", uuid()));
        let path = dir.join("s1.json");
        assert!(!dir.exists());
        write_thread_file(&path, &[user("hi")]).expect("write");
        assert!(path.exists());
        assert!(
            !path.with_extension("json.tmp").exists(),
            "temp file left behind"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------- FR-17: missing vs corrupt ----------

    #[test]
    fn a_missing_file_is_fresh_not_corrupt() {
        let path = tmp_path("missing");
        assert_eq!(read_thread_file(&path), ThreadLoad::Fresh);
    }

    #[test]
    fn a_corrupted_file_yields_corrupt_never_a_panic() {
        let path = tmp_path("corrupt");
        std::fs::write(&path, b"not json at all {{{").unwrap();
        assert_eq!(read_thread_file(&path), ThreadLoad::Corrupt);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_file_holding_the_wrong_shape_is_also_corrupt() {
        // valid JSON, but not an array of ThreadMessage
        let path = tmp_path("wrong-shape");
        std::fs::write(&path, br#"{"not":"an array"}"#).unwrap();
        assert_eq!(read_thread_file(&path), ThreadLoad::Corrupt);
        let _ = std::fs::remove_file(&path);
    }

    // ---------- path sanitization (defense-in-depth against traversal) ----------

    #[test]
    fn thread_file_name_refuses_a_traversal_id() {
        assert_eq!(thread_file_name("../../etc/passwd"), None);
        assert_eq!(thread_file_name("a/b"), None);
        assert_eq!(thread_file_name("a\\b"), None);
        assert_eq!(thread_file_name(""), None);
        assert_eq!(
            thread_file_name("11111111-2222-3333-4444-555555555555"),
            Some("11111111-2222-3333-4444-555555555555.json".to_string())
        );
    }

    // ---------- FR-8: the write-side consistency pass ----------

    #[test]
    fn drop_unanswered_tool_calls_drops_a_dangling_call_but_keeps_the_message() {
        let messages = vec![user("do a thing"), assistant_with_call("call_1")];
        // no matching `role: "tool"` message — the turn was interrupted mid-call
        let cleaned = drop_unanswered_tool_calls(&messages);
        assert_eq!(cleaned.len(), 2);
        assert_eq!(cleaned[1].role, "assistant");
        assert!(
            cleaned[1].tool_calls.is_none(),
            "dangling tool_calls must be dropped"
        );
    }

    #[test]
    fn drop_unanswered_tool_calls_keeps_a_fully_answered_call() {
        let messages = vec![
            user("do a thing"),
            assistant_with_call("call_1"),
            tool_result("call_1", "done"),
        ];
        let cleaned = drop_unanswered_tool_calls(&messages);
        assert_eq!(cleaned, messages, "a consistent array is untouched");
    }

    #[test]
    fn drop_unanswered_tool_calls_keeps_only_the_answered_call_among_several() {
        let assistant = ThreadMessage {
            role: "assistant".into(),
            content: None,
            tool_calls: Some(vec![
                ThreadToolCall {
                    id: "call_1".into(),
                    kind: "function".into(),
                    function: ThreadToolCallFunction {
                        name: "Read".into(),
                        arguments: "{}".into(),
                    },
                },
                ThreadToolCall {
                    id: "call_2".into(),
                    kind: "function".into(),
                    function: ThreadToolCallFunction {
                        name: "Bash".into(),
                        arguments: "{}".into(),
                    },
                },
            ]),
            tool_call_id: None,
        };
        let messages = vec![
            assistant,
            tool_result("call_1", "ok"),
            // call_2 never answered — interrupted mid-second-call
        ];
        let cleaned = drop_unanswered_tool_calls(&messages);
        let calls = cleaned[0].tool_calls.as_ref().expect("call_1 kept");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
    }

    #[test]
    fn a_turn_interrupted_mid_tool_call_leaves_a_file_the_endpoint_accepts_next_time() {
        // §9 acceptance: after the consistency pass, EVERY assistant tool_calls
        // entry has a matching tool reply — the shape the API requires.
        let messages = vec![
            user("run two things"),
            assistant_with_call("call_1"),
            // interrupted before the tool reply for call_1 was appended
        ];
        let cleaned = drop_unanswered_tool_calls(&messages);
        for m in &cleaned {
            if let Some(calls) = &m.tool_calls {
                for c in calls {
                    assert!(
                        cleaned
                            .iter()
                            .any(|t| t.role == "tool" && t.tool_call_id.as_deref() == Some(&c.id)),
                        "every remaining tool_call must have a matching tool reply"
                    );
                }
            }
        }
    }
}
