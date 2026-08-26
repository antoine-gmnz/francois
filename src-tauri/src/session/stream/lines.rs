//! top-level NDJSON line handlers (`type: "system"` / `"assistant"` /
//! `"result"` / `"control_cancel_request"`) plus the reader's post-loop
//! teardown: draining orphaned parked requests, closing a dangling open
//! block, and ending the turn.

use super::BlockKind;
use crate::session::*;

use serde_json::Value;
use std::collections::HashMap;
use std::process::ChildStdin;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

/// `type: "system"` lines: only `subtype: "init"` matters here. Returns
/// whether this line was the init line, so the caller can set `got_init`
/// (which feeds resume-fail detection).
pub(crate) fn handle_system_line(
    env: &dyn SessionEnv,
    session_id: &str,
    cwd: &str,
    v: &Value,
) -> bool {
    if v.get("subtype").and_then(|subtype| subtype.as_str()) != Some("init") {
        return false;
    }
    if let Some(claude_session_id) = v.get("session_id").and_then(|id| id.as_str()) {
        {
            let mut map = env.engine().sessions.lock().unwrap();
            if let Some(s) = map.get_mut(session_id) {
                s.claude_session_id = Some(claude_session_id.to_string());
            }
        }
        // persist the (possibly new) thread id so --resume survives a restart (FR-7)
        env.persist();
    }
    emit_mcp_from_init(env, session_id, v);
    // slash-menu FR-2: capture the CLI's own slash_commands; on a
    // CHANGE emit one session.commands carrying the merged
    // registry. Absent array → no change, identical set → silent.
    if let Some(names) = parse_init_slash_commands(v) {
        let changed = {
            let mut map = env.engine().sessions.lock().unwrap();
            map.get_mut(session_id)
                .is_some_and(|s| capture_cli_commands(s, names.clone()))
        };
        if changed {
            // Engine.sessions dropped — the skills disk scan must
            // never run under it (lock rules).
            let commands = merge_commands(&help_entries(), &env.discover_commands(cwd), &names);
            env.emit_session(SessionEvent::Commands {
                session_id: session_id.to_string(),
                commands,
            });
        }
    }
    true
}

/// `type: "assistant"` lines: only a synthetic (CLI-local) message becomes a
/// command card here — real top-level assistant echoes stay ignored
/// (stream_events carry those). Returns whether a synthetic message was
/// seen, so the caller can set `saw_synthetic`.
pub(crate) fn handle_assistant_line(
    env: &dyn SessionEnv,
    session_id: &str,
    turn_cmd: Option<&str>,
    v: &Value,
) -> bool {
    // interactive-commands FR-16: a synthetic (CLI-local) assistant message
    // becomes its own command card — no assistant.delta/done for it. Real
    // top-level assistant echoes stay ignored (stream_events carry them).
    let Some(answer) = synthetic_text(v) else {
        return false;
    };
    let card = classify_local_answer(turn_cmd, &answer);
    finalize_command_block(env, session_id, &uuid(), turn_cmd.unwrap_or(""), &card);
    true
}

/// The pure parse of a `type: "result"` line: whether it carries an error,
/// and (if present) its free-text result.
struct ResultLine {
    error: Option<String>,
    text: Option<String>,
}

fn parse_result_line(v: &Value) -> ResultLine {
    let is_error = v.get("is_error").and_then(|is_error| is_error.as_bool()) == Some(true)
        || v.get("subtype")
            .and_then(|subtype| subtype.as_str())
            .map(|subtype| subtype != "success")
            .unwrap_or(false);
    let error = is_error.then(|| {
        v.get("result")
            .and_then(|result| result.as_str())
            .unwrap_or("the turn ended with an error")
            .to_string()
    });
    let text = v
        .get("result")
        .and_then(|result| result.as_str())
        .map(String::from); // interactive-commands FR-18
    ResultLine { error, text }
}

/// `type: "result"` lines end the turn. Updates the running context-usage
/// estimate.
///
/// It does NOT close the stdin writer any more — `close_or_hold_channel`
/// owns that decision now, because the CLI keeps working past its own
/// `result` (see the module doc on the post-result close policy in
/// `session/stdio.rs`).
pub(crate) fn handle_result_line(
    v: &Value,
    ctx_usage: &mut ContextTracker,
    result_error: &mut Option<String>,
    result_text: &mut Option<String>,
) {
    let parsed = parse_result_line(v);
    if let Some(error) = parsed.error {
        *result_error = Some(error);
    }
    if let Some(text) = parsed.text {
        *result_text = Some(text);
    }
    if let Some(usage) = v.get("usage") {
        ctx_usage.observe_result(usage);
    }
}

/// The CLI's own census of running background tasks, off a
/// `system` / `background_tasks_changed` line: `tasks` is the FULL current
/// list, so its length is the count (an empty array means "all drained").
///
/// This is the signal the post-result close policy reads. It is authoritative
/// and it always precedes the `result` line — a background subagent can only be
/// dispatched by a tool call the turn already made.
pub(crate) fn parse_background_tasks(v: &Value) -> Option<usize> {
    if v.get("subtype").and_then(|subtype| subtype.as_str()) != Some("background_tasks_changed") {
        return None;
    }
    Some(
        v.get("tasks")
            .and_then(|tasks| tasks.as_array())
            .map_or(0, |tasks| tasks.len()),
    )
}

/// `type: "control_cancel_request"` lines: the CLI withdrew a parked
/// question or permission ask (session-questions FR-10 /
/// permission-guardrails FR-10). Unmatched ids are ignored.
pub(crate) fn handle_control_cancel_line(
    env: &dyn SessionEnv,
    session_id: &str,
    v: &Value,
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    pending_questions: &Arc<Mutex<HashMap<String, PendingQuestion>>>,
    pending_permissions: &Arc<Mutex<HashMap<String, PendingPermission>>>,
) {
    let Some(request_id) = v.get("request_id").and_then(|r| r.as_str()) else {
        return;
    };
    let claimed = {
        let mut pending = pending_questions.lock().unwrap();
        take_pending_by_request_id(&mut pending, request_id, |q| q.request_id.as_str())
    };
    if let Some((block_id, question)) = claimed {
        // FR-13: best-effort deny for the (live) child, then cancel.
        let _ = write_control_line(
            stdin,
            &deny_response(&question.request_id, "question cancelled"),
        );
        resolve_question(env, session_id, &block_id, "cancelled", None);
    }
    let claimed_perm = {
        let mut pending = pending_permissions.lock().unwrap();
        take_pending_by_request_id(&mut pending, request_id, |q| q.request_id.as_str())
    };
    if let Some((block_id, permission)) = claimed_perm {
        let _ = write_control_line(
            stdin,
            &deny_response(&permission.request_id, "request cancelled"),
        );
        resolve_permission(env, session_id, &block_id, "cancelled", None);
    }
}

/// Remove and return the single entry in `pending` whose projected request
/// id equals `request_id`, if any. Shared by the two parked-request maps
/// (`PendingQuestion`/`PendingPermission`), which both key on a CLI-issued
/// request id but are otherwise unrelated types.
fn take_pending_by_request_id<T>(
    pending: &mut HashMap<String, T>,
    request_id: &str,
    request_id_of: impl Fn(&T) -> &str,
) -> Option<(String, T)> {
    let key = pending
        .iter()
        .find(|(_, entry)| request_id_of(entry) == request_id)
        .map(|(key, _)| key.clone());
    key.and_then(|key| pending.remove(&key).map(|entry| (key, entry)))
}

/// session-questions FR-13: any question still parked when the turn dies
/// resolves as cancelled, exactly once — this drain is the claim; kill_all's
/// own drain and an in-flight answer can never double-resolve. No
/// control_response: child is gone.
pub(crate) fn drain_orphaned_questions(
    env: &dyn SessionEnv,
    session_id: &str,
    pending_questions: &Arc<Mutex<HashMap<String, PendingQuestion>>>,
) {
    let orphaned: Vec<String> = {
        let mut pending = pending_questions.lock().unwrap();
        pending.drain().map(|(block_id, _)| block_id).collect()
    };
    for block_id in orphaned {
        resolve_question(env, session_id, &block_id, "cancelled", None);
    }
}

/// permission-guardrails FR-10: identical drain for parked approval cards —
/// an ask never outlives the turn it parked, and the claim is exactly-once.
pub(crate) fn drain_orphaned_permissions(
    env: &dyn SessionEnv,
    session_id: &str,
    pending_permissions: &Arc<Mutex<HashMap<String, PendingPermission>>>,
) {
    let orphaned: Vec<String> = {
        let mut pending = pending_permissions.lock().unwrap();
        pending.drain().map(|(block_id, _)| block_id).collect()
    };
    for block_id in orphaned {
        resolve_permission(env, session_id, &block_id, "cancelled", None);
    }
}

/// Close a block left open when the reader loop ends (interrupt or crash) — FR-24/FR-34.
///
/// A text block settles through the same path a `content_block_stop` takes, so
/// the partial answer is buffered and persisted rather than living only in the
/// deltas the UI happened to receive.
pub(crate) fn close_open_block(
    env: &dyn SessionEnv,
    session_id: &str,
    open_block: Option<(String, BlockKind)>,
    text_accum: &HashMap<String, String>,
) {
    let Some((block_id, kind)) = open_block else {
        return;
    };
    match kind {
        BlockKind::Text => {
            let text = text_accum.get(&block_id).cloned().unwrap_or_default();
            finalize_text_block(env, session_id, &block_id, text);
        }
        // command-inspect: a block closed here never settled through a real
        // tool_result, so FR-1 never ran for it — no record, no chevron.
        BlockKind::Tool => env.emit_session(SessionEvent::ToolDone {
            session_id: session_id.to_string(),
            block_id,
            meta: "interrupted".into(),
            has_detail: None,
        }),
    }
}

/// After the reader loop ends (result, interrupt, or crash): reconcile the
/// running context-usage estimate, fire the interactive-commands FR-18
/// fallback card, and end the turn — success, interrupted, or crashed.
#[allow(clippy::too_many_arguments)]
pub(crate) fn finish_reader_turn(
    app: &AppHandle,
    session_id: &str,
    model_id: &str,
    ctx_usage: ContextTracker,
    got_result: bool,
    result_error: Option<String>,
    was_interrupted: bool,
    saw_synthetic: bool,
    had_blocks: bool,
    result_text: Option<String>,
    turn_cmd: Option<&str>,
) {
    let known = resolve_context_tokens(model_id);
    let limit = known.unwrap_or(DEFAULT_CONTEXT_LIMIT);
    // `finish(0)` = do not clamp. Same rule as the load path: an unknown window
    // is a display placeholder, not a ceiling, and clamping a turn's figure to
    // it writes 200000 into `sessions.json` where the true count belonged.
    let pending_used = ctx_usage.finish(known.unwrap_or(0));
    if got_result && result_error.is_none() {
        // interactive-commands FR-18 defensive fallback: a success turn with zero
        // assistant/tool blocks and no synthetic seen put its local answer only in
        // the result string — card it so no slash command ever dies silently.
        if command_fallback_fires(true, saw_synthetic, had_blocks, result_text.as_deref()) {
            let answer = result_text.clone().unwrap_or_default();
            let card = classify_local_answer(turn_cmd, &answer);
            finalize_command_block(app, session_id, &uuid(), turn_cmd.unwrap_or(""), &card);
            // app: &AppHandle coerces to &dyn SessionEnv
        }
        if let Some(used) = pending_used {
            update_used(app, session_id, used);
            emit(
                app,
                SessionEvent::ContextUsage {
                    session_id: session_id.to_string(),
                    used_tokens: used,
                    limit_tokens: limit,
                },
            );
        }
        finish_turn(app, session_id, false, None);
    } else if was_interrupted {
        if let Some(used) = pending_used {
            update_used(app, session_id, used);
            emit(
                app,
                SessionEvent::ContextUsage {
                    session_id: session_id.to_string(),
                    used_tokens: used,
                    limit_tokens: limit,
                },
            );
        }
        finish_turn(app, session_id, false, None);
    } else {
        let msg = result_error
            .unwrap_or_else(|| "the Claude Code process ended unexpectedly".to_string());
        finish_turn(app, session_id, true, Some(msg));
    }
}

pub(crate) fn emit_mcp_from_init(env: &dyn SessionEnv, session_id: &str, init: &Value) {
    let tools: Vec<String> = init
        .get("tools")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let Some(servers) = init.get("mcp_servers").and_then(|s| s.as_array()) else {
        return;
    };
    for srv in servers {
        let name = srv
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let raw_status = srv
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("connected");
        let status = match raw_status {
            "connected" | "ready" => "connected",
            "failed" | "error" => "error",
            _ => "connecting",
        };
        let prefix = format!("mcp__{name}__");
        let count = tools.iter().filter(|t| t.starts_with(&prefix)).count() as u32;
        let info = McpServerInfo {
            name: name.clone(),
            status: status.into(),
            tool_count: if status == "connected" {
                Some(count)
            } else {
                None
            },
            error_message: if status == "error" {
                Some(
                    srv.get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("connection failed")
                        .to_string(),
                )
            } else {
                None
            },
            scope: None,
        };
        {
            let mut map = env.engine().sessions.lock().unwrap();
            if let Some(s) = map.get_mut(session_id) {
                s.mcp.insert(name.clone(), info.clone());
            }
        }
        env.emit_session(SessionEvent::McpUpdate {
            session_id: session_id.into(),
            server: info,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---------- parse_result_line (type: "result") ----------

    #[test]
    fn parse_result_line_success_extracts_text_no_error() {
        let v = json!({ "type": "result", "subtype": "success", "result": "done" });
        let parsed = parse_result_line(&v);
        assert_eq!(parsed.error, None);
        assert_eq!(parsed.text, Some("done".to_string()));
    }

    #[test]
    fn parse_result_line_is_error_flag_produces_error() {
        let v = json!({ "type": "result", "is_error": true, "result": "boom" });
        let parsed = parse_result_line(&v);
        assert_eq!(parsed.error, Some("boom".to_string()));
        assert_eq!(parsed.text, Some("boom".to_string()));
    }

    #[test]
    fn parse_result_line_non_success_subtype_produces_error() {
        let v = json!({ "type": "result", "subtype": "error_max_turns" });
        let parsed = parse_result_line(&v);
        assert_eq!(
            parsed.error,
            Some("the turn ended with an error".to_string())
        );
        assert_eq!(parsed.text, None);
    }

    // ---------- parse_background_tasks (system/background_tasks_changed) ----------

    #[test]
    fn parse_background_tasks_counts_the_full_task_list() {
        let line = |tasks: Value| json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": tasks });
        assert_eq!(
            parse_background_tasks(&line(json!([{ "task_id": "a" }, { "task_id": "b" }]))),
            Some(2)
        );
        // `tasks: []` is the drained signal the close policy waits for — it must
        // read as Some(0), never as "no information".
        assert_eq!(parse_background_tasks(&line(json!([]))), Some(0));
        // Any other system line carries no census at all, so it must not reset
        // the count to zero behind a still-running background subagent.
        assert_eq!(
            parse_background_tasks(&json!({ "type": "system", "subtype": "init" })),
            None
        );
        assert_eq!(parse_background_tasks(&json!({ "type": "result" })), None);
    }

    // ---------- take_pending_by_request_id (control_cancel_request) ----------

    struct Rec {
        request_id: String,
    }

    #[test]
    fn take_pending_by_request_id_removes_matching_entry() {
        let mut pending = HashMap::new();
        pending.insert(
            "block-a".to_string(),
            Rec {
                request_id: "req-1".into(),
            },
        );
        pending.insert(
            "block-b".to_string(),
            Rec {
                request_id: "req-2".into(),
            },
        );
        let found = take_pending_by_request_id(&mut pending, "req-2", |r| r.request_id.as_str());
        let (block_id, rec) = found.expect("entry should be found");
        assert_eq!(block_id, "block-b");
        assert_eq!(rec.request_id, "req-2");
        assert_eq!(pending.len(), 1);
        assert!(pending.contains_key("block-a"));
    }

    #[test]
    fn take_pending_by_request_id_no_match_returns_none() {
        let mut pending = HashMap::new();
        pending.insert(
            "block-a".to_string(),
            Rec {
                request_id: "req-1".into(),
            },
        );
        let found =
            take_pending_by_request_id(&mut pending, "req-missing", |r| r.request_id.as_str());
        assert!(found.is_none());
        assert_eq!(pending.len(), 1);
    }
}
