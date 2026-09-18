//! stdio control-channel wiring: writing control lines and resolving parked asks.

//! turn execution: spawning the CLI and reading its NDJSON stream.

use super::*;

use crate::permissions::PermissionRule;
use serde_json::Value;
use std::collections::HashMap;
use std::process::ChildStdin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

// ---------- when the control channel closes (permission-guardrails FR-2) ----------
//
// Our stdin is the CLI's control channel AND its EOF signal: `--input-format
// stream-json` keeps the child alive until stdin closes, so something has to
// close it. It used to be the `result` line, on the assumption that nothing can
// be outstanding past a turn's result.
//
// That assumption is false for background subagents. A turn that dispatches one
// (`Agent` with `run_in_background`, the harness default) emits its `result` and
// keeps going — the subagent's own tool calls land AFTER it. And the CLI treats
// our EOF as `inputClosed`: every `can_use_tool` it raises from then on is
// thrown away at the source with `AbortError: Stream closed`, so no
// `control_request` ever reaches Francois, no approval card is ever shown, and
// the subagent gets a hard deny it did not ask for. Verified against the CLI:
// with stdin closed at the result, a background subagent's Bash comes back as
// `Tool permission request failed: AbortError: Stream closed`.
//
// So the result only closes the channel when nothing is outstanding (the common
// turn — no latency change). Otherwise a closer thread holds it open until the
// CLI's background tasks have drained, no ask is parked, and the stream has gone
// quiet — with a ceiling so a wedged task can never keep a child alive.
//
// That ceiling is measured in SILENCE, not wall clock. It used to run from the
// turn's `result`, which made it fire on healthy work: a `/build` dispatching two
// implementers emits its result when the first drains, so the second inherited
// whatever was left of the ten minutes and lost the channel mid-flight — the very
// silent deny the hold exists to prevent. A subagent still emitting lines is by
// definition not wedged, however long it has been running; one that has emitted
// nothing for the ceiling is, whether or not the CLI still counts it as running.

/// Quiet stream time required before the held-open channel closes. Covers the
/// gap between the last background task draining and the follow-up turn the CLI
/// runs to report it.
const POST_RESULT_QUIET_MS: u64 = 2_000;

/// Ceiling on how long the channel may be held open with NO sign of life on the
/// stream — the wedge backstop. Ten minutes, mirroring the CLI's own
/// `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` default. A parked ask does NOT get to
/// ignore it — an unanswered card is not a reason to keep a child process alive
/// forever; the turn-end drain cancels it as always. The channel can never
/// outlive the child either way: the reader's teardown drops stdin when the
/// process goes, and the closer thread exits with it.
const POST_RESULT_IDLE_CEILING_MS: u64 = 600_000;

/// How often the closer thread re-checks. Cheap: three uncontended locks.
const CLOSER_POLL_MS: u64 = 100;

/// What the closer thread should do on this tick.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ChannelClose {
    /// Close the stdin writer — the CLI has nothing left that could need it.
    Now,
    /// Keep it open; something is still outstanding.
    Hold,
}

/// FR-2: may the turn's `result` line close the control channel outright?
/// Only when the CLI has nothing left in flight — no background task that will
/// keep making tool calls, no ask already parked on a card.
pub fn result_closes_channel(bg_tasks: usize, parked: usize) -> bool {
    bg_tasks == 0 && parked == 0
}

/// FR-2: the held-open channel's close decision. Pure; unit-tested.
pub fn post_result_close(bg_tasks: usize, parked: usize, quiet_ms: u64) -> ChannelClose {
    if quiet_ms >= POST_RESULT_IDLE_CEILING_MS {
        return ChannelClose::Now; // backstop — nothing has spoken for the ceiling
    }
    if bg_tasks > 0 || parked > 0 {
        return ChannelClose::Hold;
    }
    if quiet_ms < POST_RESULT_QUIET_MS {
        return ChannelClose::Hold; // a late ask may still be on its way
    }
    ChannelClose::Now
}

/// Apply the close policy at the turn's `result` line: close the channel now, or
/// arm the closer thread that will. `armed` makes the arming once-only — a turn
/// that emits several `result` lines (the CLI runs a follow-up turn to report a
/// finished background task) must not spawn a closer per result.
pub fn close_or_hold_channel(
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    pending_questions: &Arc<Mutex<HashMap<String, PendingQuestion>>>,
    pending_permissions: &Arc<Mutex<HashMap<String, PendingPermission>>>,
    bg_tasks: &Arc<AtomicUsize>,
    last_line_at: &Arc<AtomicU64>,
    armed: &mut bool,
) {
    let parked = parked_count(pending_questions, pending_permissions);
    if result_closes_channel(bg_tasks.load(Ordering::Relaxed), parked) {
        *stdin.lock().unwrap() = None;
        return;
    }
    if *armed {
        return;
    }
    *armed = true;
    let stdin = stdin.clone();
    let pending_questions = pending_questions.clone();
    let pending_permissions = pending_permissions.clone();
    let bg_tasks = bg_tasks.clone();
    let last_line_at = last_line_at.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(CLOSER_POLL_MS));
        if stdin.lock().unwrap().is_none() {
            return; // the reader's own teardown got there first
        }
        let decision = post_result_close(
            bg_tasks.load(Ordering::Relaxed),
            parked_count(&pending_questions, &pending_permissions),
            now_ms().saturating_sub(last_line_at.load(Ordering::Relaxed)),
        );
        if decision == ChannelClose::Now {
            *stdin.lock().unwrap() = None;
            return;
        }
    });
}

/// How many asks are parked on a card right now, across both maps. Never taken
/// while holding Engine.sessions (the file-wide lock rule).
fn parked_count(
    pending_questions: &Arc<Mutex<HashMap<String, PendingQuestion>>>,
    pending_permissions: &Arc<Mutex<HashMap<String, PendingPermission>>>,
) -> usize {
    pending_questions.lock().unwrap().len() + pending_permissions.lock().unwrap().len()
}

/// Serialize + write one NDJSON control line to the turn's stdin. Every stdin
/// write goes through the handle's own mutex (reader-thread denies vs.
/// command-thread answers) and is NEVER made while holding Engine.sessions.
/// false ⇔ the pipe is gone (turn over / child dead).
pub fn write_control_line(stdin: &Arc<Mutex<Option<ChildStdin>>>, payload: &Value) -> bool {
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
pub fn handle_control_request(
    env: &dyn SessionEnv,
    session_id: &str,
    v: &Value,
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    pending: &Arc<Mutex<HashMap<String, PendingQuestion>>>,
    pending_perms: &Arc<Mutex<HashMap<String, PendingPermission>>>,
) {
    let (allow_git, cwd) = env
        .engine()
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
            // FR-7: the pattern rides the PENDING entry, so an `*Always`
            // decision can only ever write the rule of an ask that is still
            // parked (the entry is gone the moment the ask is claimed).
            let pattern = ask.pattern.clone();
            pending_perms.lock().unwrap().insert(
                block_id.clone(),
                PendingPermission {
                    request_id,
                    input,
                    pattern,
                },
            );
            let block = env
                .engine()
                .with_session_mut(session_id, |s| {
                    s.buf_permission(&block_id, ask_value);
                    s.block_buffer.last().cloned()
                })
                .flatten();
            if let Some(b) = &block {
                env.append_transcript(session_id, b); // FR-2: persisted while pending
            }
            env.emit_session(SessionEvent::PermissionAsked {
                session_id: session_id.into(),
                block_id: block_id.clone(),
                ask,
            });
            // The turn is now parked → `awaiting_approval`, so every surface that
            // is not the SESSION tab (sidebar card, overview, notifications) can
            // see that this session is stalled on the user. AFTER the card event,
            // for the same ordering reason the workflow attribution below is.
            refresh_parked_status(env, session_id);
            // workflow-details FR-20/FR-21: the ask is parked and its SESSION card
            // is already out — only THEN is it offered to the workflow ladder, so
            // the `workflow.detail` FR-23 emits can never name a blockId whose card
            // the frontend has not received yet. Attribution is additive: a match
            // adds a correlation entry and nothing else, so a mis-attribution can
            // mislabel a card but never lose one.
            attribute_workflow_ask(
                env,
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
            let block = env
                .engine()
                .with_session_mut(session_id, |s| {
                    s.buf_question(&question_block_id, questions_value);
                    s.block_buffer.last().cloned()
                })
                .flatten();
            if let Some(b) = &block {
                env.append_transcript(session_id, b); // FR-6: persisted while pending
            }
            env.emit_session(SessionEvent::QuestionAsked {
                session_id: session_id.into(),
                block_id: question_block_id.clone(),
                questions,
            });
            // Parked on a question → `awaiting_input` (see the permission branch).
            refresh_parked_status(env, session_id);
            // workflow-details FR-20: same ladder, same card-first ordering. A
            // question carries no tool name — the row label is the question's own.
            attribute_workflow_ask(env, session_id, v, &question_block_id, "question", None);
        }
    }
}

/// session-questions FR-11/FR-13: flip a question block to its resolved state,
/// persist it, and emit exactly one question.resolved. Callers must have CLAIMED
/// the pending entry first (removed it from the turn's map) — that removal is
/// what makes resolution exactly-once.
pub(crate) fn resolve_question(
    env: &dyn SessionEnv,
    session_id: &str,
    block_id: &str,
    state: &str,
    answers: Option<&Value>,
) {
    let block = env
        .engine()
        .with_session_mut(session_id, |s| {
            s.buf_question_resolve(block_id, state, answers)
        })
        .flatten();
    if let Some(b) = &block {
        env.append_transcript(session_id, b);
    }
    // workflow-details FR-22/FR-26: every resolution path funnels through here
    // (the answer command, `control_cancel_request`, the turn-end drain and
    // `kill_all`), so dropping the attribution here covers all of them at once.
    remove_workflow_ask(env, session_id, block_id);
    env.emit_session(SessionEvent::QuestionResolved {
        session_id: session_id.into(),
        block_id: block_id.into(),
        state: state.into(),
        answers: answers.cloned(),
    });
}

/// permission-guardrails FR-8/FR-10: CLAIM a parked ask. The `HashMap::remove`
/// under the map's own mutex IS the exactly-once guarantee — whoever removes the
/// entry owns the resolution, and every other path (a concurrent decide, a
/// `control_cancel_request`, the turn-end drain, `kill_all`) then finds nothing.
/// Extracted so that discipline is unit-testable without an `AppHandle`.
pub fn claim_pending<T>(pending: &Arc<Mutex<HashMap<String, T>>>, block_id: &str) -> Option<T> {
    pending.lock().unwrap().remove(block_id)
}

/// permission-guardrails FR-8/FR-10: flip a permission block to its resolved
/// state, persist it, and emit exactly one permission.resolved. Callers must have
/// CLAIMED the pending entry first (removed it from the turn's map) — that
/// removal is what makes resolution exactly-once.
pub(crate) fn resolve_permission(
    env: &dyn SessionEnv,
    session_id: &str,
    block_id: &str,
    state: &str,
    rule: Option<&PermissionRule>,
) {
    let rule_value = rule.and_then(|r| serde_json::to_value(r).ok());
    let block = env
        .engine()
        .with_session_mut(session_id, |s| {
            s.buf_permission_resolve(block_id, state, rule_value.as_ref())
        })
        .flatten();
    if let Some(b) = &block {
        env.append_transcript(session_id, b);
    }
    remove_workflow_ask(env, session_id, block_id); // FR-22/FR-26, as above
    env.emit_session(SessionEvent::PermissionResolved {
        session_id: session_id.into(),
        block_id: block_id.into(),
        state: state.into(),
        rule: rule.cloned(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::*;
    use serde_json::json;

    #[test]
    fn result_closes_the_channel_only_when_nothing_is_outstanding() {
        // The ordinary turn: nothing in flight, so the result closes stdin
        // exactly as it always did — no added latency on the common path.
        assert!(result_closes_channel(0, 0));
        // THE BUG: a turn that dispatched a background subagent emits its result
        // while that subagent is still making tool calls. Closing here is what
        // made the CLI throw `AbortError: Stream closed` at every `can_use_tool`
        // it raised afterwards — no control_request, no card, a silent deny.
        assert!(!result_closes_channel(1, 0));
        // An ask already parked on a card must never have its channel pulled.
        assert!(!result_closes_channel(0, 1));
        assert!(!result_closes_channel(2, 3));
    }

    #[test]
    fn held_channel_closes_once_background_tasks_drain_and_the_stream_goes_quiet() {
        let quiet = POST_RESULT_QUIET_MS;
        // A running background task holds the channel however quiet it has gone —
        // it may raise a permission ask at any moment.
        assert_eq!(post_result_close(1, 0, quiet), ChannelClose::Hold);
        assert_eq!(post_result_close(1, 0, quiet * 10), ChannelClose::Hold);
        // So does a parked card: the user is still deciding.
        assert_eq!(post_result_close(0, 1, quiet * 10), ChannelClose::Hold);
        // Drained but not yet quiet — a late ask may still be in flight.
        assert_eq!(post_result_close(0, 0, quiet - 1), ChannelClose::Hold);
        // Drained AND quiet: the CLI has nothing left, close so it can exit.
        assert_eq!(post_result_close(0, 0, quiet), ChannelClose::Now);
    }

    #[test]
    fn a_working_background_subagent_is_never_closed_on_the_wall_clock() {
        // Regression, 2026-08-04: a `/build` turn dispatched two implementers and
        // emitted its result when the first drained, while the second still had
        // ~12 minutes of work left. The ceiling was an ABSOLUTE clock from the
        // result, so it fired mid-flight and pulled the channel out from under a
        // perfectly healthy subagent — every `can_use_tool` it raised afterwards
        // died at the source with `AbortError: Stream closed`, no card, silent deny.
        // A stream still emitting lines is the definition of not-wedged, whatever
        // the wall clock says. 200ms of silence twelve minutes past the result is
        // a healthy agent between two tool calls.
        assert_eq!(post_result_close(1, 0, 200), ChannelClose::Hold);
        assert_eq!(post_result_close(1, 0, 0), ChannelClose::Hold);
        // Right up to the last millisecond of silence before the backstop.
        assert_eq!(
            post_result_close(1, 0, POST_RESULT_IDLE_CEILING_MS - 1),
            ChannelClose::Hold
        );
    }

    #[test]
    fn the_idle_ceiling_closes_the_channel_whatever_is_outstanding() {
        // A wedged background task (or a card no one ever answers) must never
        // keep a child process alive forever — the turn-end drain then cancels
        // the card exactly as it does for any other dead child (FR-10). "Wedged"
        // is now measured as silence on the stream, so this only fires on a task
        // that has genuinely stopped saying anything.
        assert_eq!(
            post_result_close(1, 1, POST_RESULT_IDLE_CEILING_MS),
            ChannelClose::Now
        );
        assert_eq!(
            post_result_close(1, 1, POST_RESULT_IDLE_CEILING_MS - 1),
            ChannelClose::Hold
        );
    }

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
