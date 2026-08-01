//! stdio control-channel wiring: writing control lines and resolving parked asks.

//! turn execution: spawning the CLI and reading its NDJSON stream.

use super::*;

use crate::permissions::PermissionRule;
use serde_json::Value;
use std::collections::HashMap;
use std::process::ChildStdin;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

/// Serialize + write one NDJSON control line to the turn's stdin. Every stdin
/// write goes through the handle's own mutex (reader-thread denies vs.
/// command-thread answers) and is NEVER made while holding Engine.sessions.
/// false ⇔ the pipe is gone (turn over / child dead).
pub(crate) fn write_control_line(stdin: &Arc<Mutex<Option<ChildStdin>>>, payload: &Value) -> bool {
    use std::io::Write as _;
    let mut line = payload.to_string();
    line.push('\n');
    let mut guard = stdin.lock().unwrap();
    match guard.as_mut() {
        Some(w) => w.write_all(line.as_bytes()).and_then(|_| w.flush()).is_ok(),
        None => false,
    }
}

/// Apply a `control_request` line (session-questions FR-6..FR-9): park an
/// AskUserQuestion as a pending entry + question block + question.asked event, or
/// answer everything else on the spot.
pub(crate) fn handle_control_request(
    app: &AppHandle,
    session_id: &str,
    v: &Value,
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    pending: &Arc<Mutex<HashMap<String, PendingQuestion>>>,
    pending_perms: &Arc<Mutex<HashMap<String, PendingPermission>>>,
) {
    let (allow_git, cwd) = app
        .state::<Engine>()
        .with_session(session_id, |s| (s.allow_git, s.cwd.clone()))
        .unwrap_or_default();
    match decide_control_request(v, allow_git) {
        ControlDecision::Permission {
            request_id,
            tool_name,
            input,
        } => {
            // permission-guardrails FR-2: park the ask — mint a block, record the
            // pending entry, persist it pending, and let the card decide.
            let ask = crate::permissions::build_ask(&tool_name, &input, &cwd);
            let ask_value = serde_json::to_value(&ask).unwrap_or_else(|_| serde_json::json!({}));
            let block_id = uuid();
            pending_perms.lock().unwrap().insert(
                block_id.clone(),
                PendingPermission {
                    request_id,
                    input,
                    ask: ask.clone(),
                },
            );
            let block = app
                .state::<Engine>()
                .with_session_mut(session_id, |s| {
                    s.buf_permission(&block_id, ask_value);
                    s.block_buffer.last().cloned()
                })
                .flatten();
            if let Some(b) = &block {
                append_transcript(app, session_id, b); // FR-2: persisted while pending
            }
            emit(
                app,
                SessionEvent::PermissionAsked {
                    session_id: session_id.into(),
                    block_id: block_id.clone(),
                    ask,
                },
            );
            // workflow-details FR-20/FR-21: the ask is parked and its SESSION card
            // is already out — only THEN is it offered to the workflow ladder, so
            // the `workflow.detail` FR-23 emits can never name a blockId whose card
            // the frontend has not received yet. Attribution is additive: a match
            // adds a correlation entry and nothing else, so a mis-attribution can
            // mislabel a card but never lose one.
            attribute_workflow_ask(
                app,
                session_id,
                v,
                &block_id,
                "permission",
                Some(tool_name.as_str()),
            );
        }
        ControlDecision::Respond(payload) => {
            let _ = write_control_line(stdin, &payload); // FR-7/8/9: no event, no card
        }
        ControlDecision::Ask {
            request_id,
            input,
            questions,
        } => {
            let question_block_id = uuid();
            pending.lock().unwrap().insert(
                question_block_id.clone(),
                PendingQuestion { request_id, input },
            );
            let questions_value =
                serde_json::to_value(&questions).unwrap_or_else(|_| Value::Array(Vec::new()));
            let block = app
                .state::<Engine>()
                .with_session_mut(session_id, |s| {
                    s.buf_question(&question_block_id, questions_value);
                    s.block_buffer.last().cloned()
                })
                .flatten();
            if let Some(b) = &block {
                append_transcript(app, session_id, b); // FR-6: persisted while pending
            }
            emit(
                app,
                SessionEvent::QuestionAsked {
                    session_id: session_id.into(),
                    block_id: question_block_id.clone(),
                    questions,
                },
            );
            // workflow-details FR-20: same ladder, same card-first ordering. A
            // question carries no tool name — the row label is the question's own.
            attribute_workflow_ask(app, session_id, v, &question_block_id, "question", None);
        }
    }
}

/// session-questions FR-11/FR-13: flip a question block to its resolved state,
/// persist it, and emit exactly one question.resolved. Callers must have CLAIMED
/// the pending entry first (removed it from the turn's map) — that removal is
/// what makes resolution exactly-once.
pub(crate) fn resolve_question(
    app: &AppHandle,
    session_id: &str,
    block_id: &str,
    state: &str,
    answers: Option<&Value>,
) {
    let block = app
        .state::<Engine>()
        .with_session_mut(session_id, |s| {
            s.buf_question_resolve(block_id, state, answers)
        })
        .flatten();
    if let Some(b) = &block {
        append_transcript(app, session_id, b);
    }
    // workflow-details FR-22/FR-26: every resolution path funnels through here
    // (the answer command, `control_cancel_request`, the turn-end drain and
    // `kill_all`), so dropping the attribution here covers all of them at once.
    remove_workflow_ask(app, session_id, block_id);
    emit(
        app,
        SessionEvent::QuestionResolved {
            session_id: session_id.into(),
            block_id: block_id.into(),
            state: state.into(),
            answers: answers.cloned(),
        },
    );
}

/// permission-guardrails FR-8/FR-10: CLAIM a parked ask. The `HashMap::remove`
/// under the map's own mutex IS the exactly-once guarantee — whoever removes the
/// entry owns the resolution, and every other path (a concurrent decide, a
/// `control_cancel_request`, the turn-end drain, `kill_all`) then finds nothing.
/// Extracted so that discipline is unit-testable without an `AppHandle`.
pub(crate) fn claim_pending<T>(
    pending: &Arc<Mutex<HashMap<String, T>>>,
    block_id: &str,
) -> Option<T> {
    pending.lock().unwrap().remove(block_id)
}

/// permission-guardrails FR-8/FR-10: flip a permission block to its resolved
/// state, persist it, and emit exactly one permission.resolved. Callers must have
/// CLAIMED the pending entry first (removed it from the turn's map) — that
/// removal is what makes resolution exactly-once.
pub(crate) fn resolve_permission(
    app: &AppHandle,
    session_id: &str,
    block_id: &str,
    state: &str,
    rule: Option<&PermissionRule>,
) {
    let rule_value = rule.and_then(|r| serde_json::to_value(r).ok());
    let block = app
        .state::<Engine>()
        .with_session_mut(session_id, |s| {
            s.buf_permission_resolve(block_id, state, rule_value.as_ref())
        })
        .flatten();
    if let Some(b) = &block {
        append_transcript(app, session_id, b);
    }
    remove_workflow_ask(app, session_id, block_id); // FR-22/FR-26, as above
    emit(
        app,
        SessionEvent::PermissionResolved {
            session_id: session_id.into(),
            block_id: block_id.into(),
            state: state.into(),
            rule: rule.cloned(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::*;
    use serde_json::json;

    #[test]
    fn question_block_lifecycle_pending_answered() {
        // FR-6/FR-15: pending block streams; resolution updates IN PLACE; the
        // answers key exists only once answered.
        let mut s = test_session();
        let qs = json!([{ "question": "Q", "header": "H", "options": [], "multiSelect": false }]);
        s.buf_question("q1", qs.clone());
        let pending = classify_block(&s.block_buffer[0]);
        assert_eq!(
            pending,
            json!({ "kind": "question", "blockId": "q1", "isStreaming": true,
                "questions": qs, "state": "pending" })
        );

        let answers = json!({ "Q": "A" });
        let resolved = s
            .buf_question_resolve("q1", "answered", Some(&answers))
            .expect("resolve");
        assert_eq!(s.block_buffer.len(), 1); // upsert, not append
        assert!(!resolved.streaming);
        let done = classify_block(&s.block_buffer[0]);
        assert_eq!(
            done,
            json!({ "kind": "question", "blockId": "q1", "isStreaming": false,
                "questions": qs, "state": "answered", "answers": { "Q": "A" } })
        );
        // unknown blockId resolves nothing (FR-13 exactly-once claims handle the rest)
        assert!(s.buf_question_resolve("nope", "cancelled", None).is_none());
    }

    #[test]
    fn permission_block_buffers_pending_then_resolves_in_place() {
        // FR-2/FR-8: isStreaming ⇔ pending (FR-25); `rule` present iff written.
        let mut s = perm_session();
        let ask = serde_json::to_value(crate::permissions::build_ask(
            "Bash",
            &json!({ "command": "npm test" }),
            "/repo",
        ))
        .unwrap();
        s.buf_permission("p1", ask);
        let pending = classify_block(&s.block_buffer[0]);
        assert_eq!(pending["kind"], "permission");
        assert_eq!(pending["state"], "pending");
        assert_eq!(pending["isStreaming"], true);
        assert_eq!(pending["ask"]["patternLabel"], "npm test (any arguments)");
        assert!(pending.get("rule").is_none());

        let rule = serde_json::to_value(sample_rule()).unwrap();
        let updated = s
            .buf_permission_resolve("p1", "allowed", Some(&rule))
            .expect("resolves");
        let done = classify_block(&updated);
        assert_eq!(done["state"], "allowed");
        assert_eq!(done["isStreaming"], false);
        assert_eq!(done["rule"]["pattern"], "Bash(npm test:*)");
        assert_eq!(s.block_buffer.len(), 1, "resolved in place, never appended");

        // An unknown blockId resolves nothing (the exactly-once claim lives in the
        // pending map, not here).
        assert!(s.buf_permission_resolve("nope", "denied", None).is_none());
    }
}
