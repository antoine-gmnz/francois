mod blocks;
#[cfg(test)]
mod coalesce;
mod environment;
mod lines;
mod tool_results;

pub(crate) use blocks::*;
#[cfg(test)]
pub(crate) use coalesce::*;
pub(crate) use environment::*;
pub(crate) use lines::*;
pub(crate) use tool_results::*;

use crate::session::{
    close_or_hold_channel, handle_control_request, is_resume_fail, now_ms, parse_command,
    route_line, user_line_text, ContextTracker, LineRoute, PendingPermission, PendingQuestion,
};

use crate::ipc::AppError;
use crate::session::application::{RuntimeEvent, SubagentObservation, TurnContext};
use serde_json::Value;
use std::collections::HashMap;
use std::process::ChildStdin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// Per-turn state while parsing the NDJSON stream.
pub struct ToolRec {
    block_id: String,
    tool: String,
    input: Value,
    is_task: bool,
    /// workflow-panel FR-2: this call is a `Workflow` dispatch, so its input and
    /// its tool_result feed pane [6] as well as the transcript.
    is_workflow: bool,
    /// command-inspect FR-2: when the `tool_use` was first seen
    /// (`content_block_start`) — `StepDetail.startedAt`.
    started_at: u64,
}

/// What kind of content block a stream index is carrying.
///
/// This was a bare `u8` in a positional tuple with `0=text 1=tool` recorded only
/// in a comment — so a miswritten literal, or a comparison against the wrong
/// number, compiled clean and silently routed a tool block through the text path.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BlockKind {
    Text,
    Tool,
}

/// multi-provider-seam FR-5/FR-18: everything `run_reader` needs back from
/// `parse_stream` to decide completion, resume rejection, and the dangling-block
/// close — the pieces of the old single-function reader that genuinely
/// depend on the live `Child` (reaping it) or a recursive `begin_turn` (which
/// needs a real, owned `application handle`) and so could not move into `parse_stream`.
pub struct ParseOutcome {
    pub(crate) got_result: bool,
    pub(crate) got_init: bool,
    pub(crate) result_error: Option<String>,
    pub(crate) result_text: Option<String>,
    pub(crate) saw_synthetic: bool,
    pub(crate) had_blocks: bool,
    pub(crate) ctx_usage: ContextTracker,
    pub(crate) open_block: Option<(String, BlockKind)>,
    pub(crate) text_accum: HashMap<String, String>,
}

/// FR-5: the whole per-line NDJSON parse loop, over a `BufRead` source
/// instead of a live `Child` — the adapter owns the process and hands this
/// its stdout (via `run_reader`, below). FR-6: emits through `env` instead of
/// calling `application handle::emit` directly, so a test can capture the exact
/// `SessionEvent` sequence a captured fixture produces (FR-17/FR-18) without
/// constructing an `application handle` (this crate wires up no such test harness).
///
/// Handles every top-level NDJSON line kind through `session.status ==
/// awaiting_*` parking; does NOT reap the child, decide resume rejection, or close
/// a still-open block — `run_reader` does those with the pieces only it has
/// (the live `Child`, a recursive `begin_turn` that needs an owned `application handle`).
#[allow(clippy::too_many_arguments)]
fn parse_frames(
    env: &dyn StreamEnvironment,
    session_id: &str,
    mut read_frame: impl FnMut() -> Result<Option<String>, AppError>,
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    pending_questions: &Arc<Mutex<HashMap<String, PendingQuestion>>>,
    pending_permissions: &Arc<Mutex<HashMap<String, PendingPermission>>>,
    turn_cmd: Option<&str>,
) -> ParseOutcome {
    // index -> (blockId, kind, input_accum)
    let mut blocks: HashMap<u64, (String, BlockKind, String)> = HashMap::new();
    let mut tools: HashMap<String, ToolRec> = HashMap::new(); // tool_use_id -> rec
    let mut text_accum: HashMap<String, String> = HashMap::new(); // blockId -> text
                                                                  // FR-2: the streamed UTF-16 offset per block, tracked incrementally instead
                                                                  // of re-derived by re-encoding `text_accum` every delta. Never read
                                                                  // downstream of this loop, so it does not join `ParseOutcome`.
    let mut text_utf16: HashMap<String, usize> = HashMap::new();
    let mut open_block: Option<(String, BlockKind)> = None;
    let mut ctx_usage = ContextTracker::default();
    let mut got_result = false;
    let mut got_init = false; // did the stream start (system/init)? — resume-fail detection (FR-8)
    let mut result_error: Option<String> = None;
    // interactive-commands: whether a synthetic message was carded (FR-16),
    // and the result string (FR-18 fallback).
    let mut saw_synthetic = false;
    let mut result_text: Option<String> = None;
    // permission-guardrails FR-2, post-result close policy (see session/stdio.rs):
    // the CLI's running-background-task count and the wall clock of the last line
    // it sent. Both are read by the closer thread, which decides when the control
    // channel may finally close — a background subagent's `can_use_tool` raised
    // after our stdin EOF never reaches Francois at all.
    let bg_tasks = Arc::new(AtomicUsize::new(0));
    let last_line_at = Arc::new(AtomicU64::new(now_ms()));
    let mut closer_armed = false;

    let cwd = env.settings(session_id).cwd;
    loop {
        if let Some(error) = env.failure() {
            result_error = Some(error.message);
            break;
        }
        let line = match read_frame() {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                result_error = Some(error.message.clone());
                break;
            }
        };
        last_line_at.store(now_ms(), Ordering::Relaxed); // feeds the post-result quiet window
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // async-agents FR-8/FR-9: a line carrying a non-null parent_tool_use_id on
        // an assistant/user/stream_event type belongs to a subagent. It is
        // attributed to that agent and NEVER passed to the parent-turn handlers,
        // so the SESSION transcript stays a record of the parent turn only. An
        // unknown correlation key is ignored entirely. Any other type (e.g. a
        // control_request) is never diverted, even if it carries a stray
        // parent_tool_use_id — it must still reach its normal handler.
        match route_line(&v) {
            LineRoute::Attributed(ptuid) => {
                publish_attributed(env, &ptuid, &v);
                continue;
            }
            LineRoute::Notice => {
                env.publish(RuntimeEvent::CompletionNotice {
                    text: user_line_text(&v),
                });
                continue;
            }
            LineRoute::Parent => {}
        }
        let line_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match line_type {
            "system" => {
                if let Some(running) = parse_background_tasks(&v) {
                    bg_tasks.store(running, Ordering::Relaxed);
                }
                if handle_system_line(env, session_id, &cwd, &v) {
                    got_init = true;
                    // The stream is live: `starting` → `running`. Only the init
                    // line promotes, so the spawn window is a real state rather
                    // than a claim that work began the instant we forked.
                    env.publish(RuntimeEvent::StreamLive);
                }
            }
            "stream_event" => {
                if let Some(ev) = v.get("event") {
                    handle_stream_event(
                        env,
                        session_id,
                        &cwd,
                        ev,
                        &mut blocks,
                        &mut tools,
                        &mut text_accum,
                        &mut text_utf16,
                        &mut open_block,
                        &mut ctx_usage,
                    );
                }
            }
            "user" => {
                handle_tool_results(env, session_id, &v, &mut tools, &mut open_block);
            }
            "assistant" => {
                if handle_assistant_line(env, session_id, turn_cmd, &v) {
                    saw_synthetic = true;
                }
            }
            "result" => {
                got_result = true;
                handle_result_line(&v, &mut ctx_usage, &mut result_error, &mut result_text);
                // The result no longer closes the control channel by itself: a
                // background subagent dispatched by this turn outlives it, and
                // the CLI throws away every permission ask raised after our
                // stdin EOF (session/stdio.rs).
                close_or_hold_channel(
                    stdin,
                    pending_questions,
                    pending_permissions,
                    &bg_tasks,
                    &last_line_at,
                    &mut closer_armed,
                );
            }
            "control_request" => {
                // session-questions FR-6..FR-9 + permission-guardrails FR-1/FR-2.
                handle_control_request(
                    env,
                    session_id,
                    &v,
                    stdin,
                    pending_questions,
                    pending_permissions,
                );
            }
            "control_cancel_request" => {
                // session-questions FR-10 / permission-guardrails FR-10: the CLI
                // withdrew a parked request. Unmatched ids are ignored.
                handle_control_cancel_line(
                    env,
                    session_id,
                    &v,
                    stdin,
                    pending_questions,
                    pending_permissions,
                );
            }
            _ => {} // keep_alive & any unrecognized top-level type stay ignored (FR-4)
        }
    }

    // The stream is over: nothing may reach the child any more, so a reply
    // racing the drain below finds the channel closed rather than writing.
    *stdin.lock().unwrap() = None;
    drain_orphaned_questions(env, session_id, pending_questions);
    drain_orphaned_permissions(env, session_id, pending_permissions);

    ParseOutcome {
        got_result,
        got_init,
        result_error,
        result_text,
        saw_synthetic,
        had_blocks: !blocks.is_empty(),
        ctx_usage,
        open_block,
        text_accum,
    }
}

/// Read one native turn and publish normalized observations.
#[allow(clippy::too_many_arguments)]
pub fn run_reader(
    env: &NativeStream,
    context: &TurnContext,
    read_frame: impl FnMut() -> Result<Option<String>, AppError>,
    child: Arc<crate::process_util::OwnedChild>,
    interrupted: Arc<AtomicBool>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending_questions: Arc<Mutex<HashMap<String, PendingQuestion>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
) {
    let turn_cmd = parse_command(&context.text).map(|(command, _)| command);
    let outcome = parse_frames(
        env,
        &context.session_id,
        read_frame,
        &stdin,
        &pending_questions,
        &pending_permissions,
        turn_cmd.as_deref(),
    );
    env.flush();
    *stdin.lock().unwrap() = None;
    let _ = child.close();
    let was_interrupted = interrupted.load(Ordering::SeqCst);
    // process-session-continuity FR-3: a refused effect (the anchor could not
    // be saved) ends the turn explicitly instead of leaving it running.
    if env.failure().is_some() {
        env.fail_refused();
        return;
    }
    if is_resume_fail(
        context.resume.is_some(),
        outcome.got_init,
        outcome.got_result,
        was_interrupted,
    ) {
        env.publish(RuntimeEvent::ResumeRejected);
        return;
    }
    close_open_block(
        env,
        &context.session_id,
        outcome.open_block,
        &outcome.text_accum,
    );
    finish_reader_turn(
        env,
        &context.session_id,
        &context.model_id,
        outcome.ctx_usage,
        outcome.got_result,
        outcome.result_error,
        was_interrupted,
        outcome.saw_synthetic,
        outcome.had_blocks,
        outcome.result_text,
        turn_cmd.as_deref(),
    );
}

fn publish_attributed(env: &dyn StreamEnvironment, parent_tool_use_id: &str, value: &Value) {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    if !matches!(kind, "assistant" | "user") {
        return;
    }
    let items = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(
            |item| match (kind, item.get("type").and_then(Value::as_str).unwrap_or("")) {
                ("assistant", "text") => Some(SubagentObservation::Text(
                    item.get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                )),
                ("assistant", "tool_use") => Some(SubagentObservation::ToolUse {
                    id: item.get("id").and_then(Value::as_str).map(String::from),
                    name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    input: item
                        .get("input")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({})),
                }),
                ("user", "tool_result") => Some(SubagentObservation::ToolResult {
                    tool_use_id: item
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    text: extract_result_text(item.get("content")),
                    is_error: item
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                }),
                _ => None,
            },
        )
        .collect();
    env.publish(RuntimeEvent::SubagentObserved {
        parent_tool_use_id: parent_tool_use_id.into(),
        items,
        at: now_ms(),
    });
}

#[cfg(any(test, feature = "harness"))]
#[allow(clippy::too_many_arguments)]
pub fn parse_stream<E: crate::session::SessionEnv>(
    env: &E,
    session_id: &str,
    reader: impl std::io::BufRead,
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    pending_questions: &Arc<Mutex<HashMap<String, PendingQuestion>>>,
    pending_permissions: &Arc<Mutex<HashMap<String, PendingPermission>>>,
    turn_cmd: Option<&str>,
) -> ParseOutcome {
    let mut frames = crate::process_util::FrameReader::new(reader);
    parse_frames(
        env,
        session_id,
        || frames.read_frame(),
        stdin,
        pending_questions,
        pending_permissions,
        turn_cmd,
    )
}

#[cfg(test)]
pub(crate) mod golden_replay_tests {
    //! multi-provider-seam FR-17/FR-18: replay a captured NDJSON stream
    //! through the REAL parse path (`parse_stream`, this file's whole point)
    //! and assert the exact `SessionEvent` sequence it produces — the proof
    //! that FR-1..FR-10's trait extraction is a behavioural no-op. `TestEnv`
    //! (session/env.rs) is what makes this possible without an `application handle`.

    use super::*;
    use crate::session::testenv::TestEnv;
    use crate::session::testutil::test_session;
    use crate::session::*;
    use std::io::Cursor;
    use std::time::Duration;

    /// `specs/multi-provider-seam.md` FR-17. **A real capture**, not a
    /// hand-built one: 103 raw stdout lines of a live `claude` 2.1.228 turn,
    /// taken 2026-08-12 in a throwaway scratch directory outside this repo,
    /// with exactly the production argv (`adapter/claude_code.rs::turn_args`) —
    /// `-p --output-format stream-json --input-format stream-json
    /// --permission-prompt-tool stdio --include-partial-messages --verbose
    /// --model sonnet` — and the turn text on stdin as the §5.5 user NDJSON
    /// line. The prompt asked, in one turn, for: a sentence of prose, a `Read`,
    /// a subagent dispatch, `mkdir build` (gated, so it raises a real
    /// `can_use_tool`), and an `AskUserQuestion` — which is how all seven
    /// FR-17 line kinds land in a single turn (asserted below by
    /// `the_fixture_covers_all_seven_fr_17_line_kinds`).
    ///
    /// The capture harness answered the two `control_request`s the way the app
    /// does, so the turn could reach its `result`; those responses ride
    /// **stdin** and are therefore absent from this stdout capture — which is
    /// why the replay legitimately sees both asks unanswered and cancels them
    /// at teardown.
    ///
    /// Scrub (FR-17: textual only — same 103 lines, same order, same per-line
    /// JSON structure, verified before it was committed): absolute paths
    /// prefix-rewritten to `C:\work\widget-demo` / `C:\Users\user` **keeping
    /// their original backslash escaping**, so a path split across two
    /// `input_json_delta` chunks still concatenates to what it did live; the
    /// real thread id replaced by a fixed uuid; thinking-block `signature`
    /// blobs replaced by `SCRUBBED`. Nothing else was touched — including the
    /// line kinds no synthetic fixture would have thought to include
    /// (`hook_started`/`hook_response`, `system/status`, `thinking_tokens`,
    /// thinking blocks, `task_started`/`task_progress`/`task_updated`,
    /// `rate_limit_event`), which is the point of capturing rather than
    /// writing one.
    const FIXTURE: &str = include_str!("fixtures/turn.ndjson");

    /// `blockId`/`agentId`/an agent's own `id`, plus every timestamp
    /// (`startedAt`/`endedAt`/`at`), are minted live (`uuid()`/`now_ms()`) —
    /// non-deterministic across runs by construction. Normalized to stable
    /// placeholders (first-seen order, so the SAME underlying id always maps
    /// to the SAME placeholder — e.g. a tool's `tool.start`/`tool.done`
    /// `blockId` still visibly match) before comparing against the locked
    /// expected list, which is committed already normalized the same way.
    pub(crate) fn normalize(events: &[Value]) -> Vec<Value> {
        let mut id_map: HashMap<String, String> = HashMap::new();
        let mut next = 1usize;
        let mut out: Vec<Value> = events.to_vec();
        for ev in &mut out {
            normalize_value(ev, &mut id_map, &mut next);
        }
        out
    }

    fn looks_like_uuid(s: &str) -> bool {
        s.len() == 36 && s.bytes().filter(|b| *b == b'-').count() == 4
    }

    fn assign_id(raw: &str, id_map: &mut HashMap<String, String>, next: &mut usize) -> String {
        id_map
            .entry(raw.to_string())
            .or_insert_with(|| {
                let placeholder = format!("id-{next}");
                *next += 1;
                placeholder
            })
            .clone()
    }

    fn normalize_value(v: &mut Value, id_map: &mut HashMap<String, String>, next: &mut usize) {
        if let Value::Object(map) = v {
            for (k, val) in map.iter_mut() {
                match k.as_str() {
                    "blockId" | "agentId" => {
                        if let Value::String(s) = val.clone() {
                            *val = Value::String(assign_id(&s, id_map, next));
                        }
                    }
                    "id" => {
                        if let Value::String(s) = val.clone() {
                            if looks_like_uuid(&s) {
                                *val = Value::String(assign_id(&s, id_map, next));
                            }
                        }
                    }
                    "startedAt" | "endedAt" | "at" if val.is_number() => {
                        *val = serde_json::json!(0);
                    }
                    _ => {}
                }
            }
            for val in map.values_mut() {
                normalize_value(val, id_map, next);
            }
        } else if let Value::Array(arr) = v {
            for item in arr.iter_mut() {
                normalize_value(item, id_map, next);
            }
        }
    }

    fn run_fixture() -> TestEnv {
        let mut session = test_session();
        // Realistic pre-turn state: `do_send` sets `starting` before spawning,
        // so `system/init` has something to promote (FR-9's derived status).
        session.status = "starting".into();
        let env = TestEnv {
            engine: crate::session::testutil::test_engine_with(session),
            ..Default::default()
        };
        let stdin = Arc::new(Mutex::new(None));
        let pending_questions = Arc::new(Mutex::new(HashMap::new()));
        let pending_permissions = Arc::new(Mutex::new(HashMap::new()));
        {
            // The same wrapper `run_reader` puts in front of the parse path
            // (coalesce.rs), with the window pinned OPEN: what merges is then a
            // function of the capture's line order alone, never of how fast the
            // machine replayed it. The expected list is locked accordingly —
            // one `assistant.delta` per run of same-block chunks.
            let coalesced = CoalescingEnv::new(&env, Duration::MAX);
            parse_stream(
                &coalesced,
                "s1",
                Cursor::new(FIXTURE.as_bytes()),
                &stdin,
                &pending_questions,
                &pending_permissions,
                None,
            );
            coalesced.flush(); // the reader's own post-loop flush
        }
        env
    }

    #[test]
    fn golden_replay_produces_the_locked_session_event_sequence() {
        let env = run_fixture();
        let raw: Vec<Value> = env
            .session_events
            .lock()
            .unwrap()
            .iter()
            .map(|ev| serde_json::to_value(ev).unwrap())
            .collect();
        let events = normalize(&raw);

        let expected: Value = serde_json::from_str(include_str!("fixtures/turn.expected.json"))
            .expect("fixtures/turn.expected.json must be valid JSON");
        let expected = expected.as_array().expect("expected list is a JSON array");

        assert_eq!(
            events.len(),
            expected.len(),
            "event count diverged from the locked expected list:\n{}",
            serde_json::to_string_pretty(&events).unwrap()
        );
        for (i, (actual, want)) in events.iter().zip(expected.iter()).enumerate() {
            assert_eq!(
                actual, want,
                "event #{i} diverged from the locked expected list"
            );
        }
    }

    #[test]
    fn golden_replay_merges_each_blocks_deltas_without_losing_a_character() {
        // coalesce.rs, on the real capture: with the window pinned open every
        // run of same-block chunks is ONE event, and what it carries still adds
        // up — offset 0, and text equal to the `assistant.done` that settles
        // the block. That equality is the merge being indistinguishable from a
        // single bigger delta; the count is the whole point of the window.
        let env = run_fixture();
        let events = env.session_events.lock().unwrap();
        let mut done = 0;
        for ev in events.iter() {
            let SessionEvent::AssistantDone { block_id, text, .. } = ev else {
                continue;
            };
            done += 1;
            let deltas: Vec<(&String, usize)> = events
                .iter()
                .filter_map(|other| match other {
                    SessionEvent::AssistantDelta {
                        block_id: id,
                        text,
                        offset,
                        ..
                    } if id == block_id => Some((text, *offset)),
                    _ => None,
                })
                .collect();
            assert_eq!(deltas.len(), 1, "block {block_id} should emit one delta");
            assert_eq!(deltas[0].0, text, "merged text must equal the final text");
            assert_eq!(deltas[0].1, 0, "a whole-block run starts at offset 0");
        }
        assert_eq!(done, 3, "the capture settles three text blocks");
    }

    #[test]
    fn the_fixture_covers_all_seven_fr_17_line_kinds() {
        // FR-17 lists seven kinds the capture must exercise IN ONE TURN. They
        // are asserted here rather than trusted, so a future re-capture that
        // silently misses one (the `can_use_tool` is the fragile one — the CLI
        // auto-approves anything it classifies read-only) fails loudly instead
        // of quietly shrinking what the golden lock proves.
        let lines: Vec<Value> = FIXTURE
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("every fixture line is JSON"))
            .collect();
        let ty = |v: &Value| {
            v.get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string()
        };
        let sub = |v: &Value| {
            v.get("subtype")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string()
        };
        let content_kinds = |v: &Value, role: &str| -> Vec<String> {
            if ty(v) != role {
                return Vec::new();
            }
            v.get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|b| {
                            let k = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            match b.get("name").and_then(|n| n.as_str()) {
                                Some(n) => format!("{k}:{n}"),
                                None => k.to_string(),
                            }
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let any = |f: &dyn Fn(&Value) -> bool| lines.iter().any(f);

        // 1. assistant text deltas
        assert!(
            any(&|v| ty(v) == "stream_event"
                && v.pointer("/event/delta/type").and_then(|t| t.as_str()) == Some("text_delta")),
            "no text_delta"
        );
        // 2. a tool call with its tool_result
        assert!(
            any(&|v| content_kinds(v, "assistant")
                .iter()
                .any(|k| k == "tool_use:Read")),
            "no Read tool call"
        );
        assert!(
            any(&|v| v
                .get("parent_tool_use_id")
                .map(|p| p.is_null())
                .unwrap_or(true)
                && content_kinds(v, "user").iter().any(|k| k == "tool_result")),
            "no parent-turn tool_result"
        );
        // 3. a subagent dispatch + an inner line carrying parent_tool_use_id
        assert!(
            any(&|v| content_kinds(v, "assistant")
                .iter()
                .any(|k| k == "tool_use:Agent" || k == "tool_use:Task")),
            "no subagent dispatch"
        );
        assert!(
            any(&|v| v
                .get("parent_tool_use_id")
                .and_then(|p| p.as_str())
                .is_some()),
            "no inner line attributed to a subagent"
        );
        // 4. a can_use_tool permission request (a tool that is NOT AskUserQuestion)
        assert!(
            any(&|v| ty(v) == "control_request"
                && v.pointer("/request/subtype").and_then(|s| s.as_str()) == Some("can_use_tool")
                && v.pointer("/request/tool_name").and_then(|s| s.as_str())
                    != Some("AskUserQuestion")),
            "no permission request"
        );
        // 5. an AskUserQuestion
        assert!(
            any(&|v| ty(v) == "control_request"
                && v.pointer("/request/tool_name").and_then(|s| s.as_str())
                    == Some("AskUserQuestion")),
            "no AskUserQuestion"
        );
        // 6. system/init  7. the final result
        assert!(
            any(&|v| ty(v) == "system" && sub(v) == "init"),
            "no system/init"
        );
        assert_eq!(ty(lines.last().expect("fixture is non-empty")), "result");
    }

    /// process-runtime-events AC-6: a subagent's own request usage never
    /// reaches the parent's occupancy, and the result aggregate does not
    /// override the last parent request.
    #[test]
    fn subagent_usage_and_result_aggregate_do_not_inflate_parent_context() {
        let env = TestEnv {
            engine: crate::session::testutil::test_engine_with(test_session()),
            ..Default::default()
        };
        let lines = [
            r#"{"type":"stream_event","parent_tool_use_id":"toolu_sub","event":{"type":"message_start","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":900000}}}}"#,
            r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":40000}}}}"#,
            r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_delta","usage":{"output_tokens":500}}}"#,
            r#"{"type":"stream_event","parent_tool_use_id":"toolu_sub","event":{"type":"message_delta","usage":{"output_tokens":90000}}}"#,
            r#"{"type":"result","subtype":"success","result":"ok","usage":{"input_tokens":5,"cache_read_input_tokens":3400000,"output_tokens":100}}"#,
        ]
        .join("\n")
            + "\n";
        let outcome = parse_stream(
            &env,
            "s1",
            Cursor::new(lines.into_bytes()),
            &Arc::new(Mutex::new(None)),
            &Arc::new(Mutex::new(HashMap::new())),
            &Arc::new(Mutex::new(HashMap::new())),
            None,
        );
        assert!(
            outcome.got_result,
            "result line was not read: {:?}",
            outcome.result_error
        );
        assert_eq!(outcome.ctx_usage.finish(200_000), Some(40_510));
    }

    #[test]
    fn golden_replay_never_leaks_the_subagents_inner_line_into_the_session_stream() {
        // async-agents FR-8/FR-9: a line carrying `parent_tool_use_id` belongs
        // to the subagent — it is routed to that agent's own trail, never to
        // the parent turn's transcript. In the capture those lines are the
        // subagent's prompt (a `user` text line) and its own `Glob` call.
        let env = run_fixture();
        let events = env.session_events.lock().unwrap();
        // The prompt text: it also rides the PARENT's own `Agent` tool input,
        // so this pins both halves at once — the inner line produced no
        // message event, and the dispatch's tool block does not ship its raw
        // input either.
        let leaked_text = events.iter().any(|ev| {
            serde_json::to_string(ev)
                .unwrap_or_default()
                .contains("Use the Glob tool to list every file")
        });
        assert!(
            !leaked_text,
            "the subagent's inner line must never reach the session's own event stream"
        );
        // The inner tool call must not open a parent-turn tool block. It is
        // still visible as an `agent.step` — that is the agent trail, which is
        // exactly where it belongs.
        let leaked_tool = events
            .iter()
            .any(|ev| matches!(ev, SessionEvent::ToolStart { tool, .. } if tool == "Glob"));
        assert!(
            !leaked_tool,
            "the subagent's own tool call must not open a block in the parent transcript"
        );
        assert!(
            events
                .iter()
                .any(|ev| matches!(ev, SessionEvent::AgentStepEvent { step, .. }
                    if step.tool.as_deref() == Some("Glob"))),
            "the inner tool call must still reach the agent's trail"
        );
        drop(events);
        assert!(
            !env.agent_events.lock().unwrap().is_empty(),
            "the inner line must still reach the agent's own block transcript"
        );
    }

    #[test]
    fn golden_replay_parks_then_orphan_cancels_the_unanswered_asks() {
        // Both asks are answered live over STDIN, which a stdout capture does
        // not contain — so on replay the fixture ends on `result` with the
        // permission ask and the question still parked. The reader's own
        // teardown (drain_orphaned_*) resolves each exactly once as
        // `cancelled`, never left dangling.
        let env = run_fixture();
        let events = env.session_events.lock().unwrap();
        let asked = events
            .iter()
            .filter(|ev| matches!(ev, SessionEvent::PermissionAsked { .. }))
            .count();
        let resolved_cancelled = events
            .iter()
            .filter(|ev| {
                matches!(ev, SessionEvent::PermissionResolved { state, .. } if state == "cancelled")
            })
            .count();
        assert_eq!(asked, 1);
        assert_eq!(resolved_cancelled, 1);

        let question_asked = events
            .iter()
            .filter(|ev| matches!(ev, SessionEvent::QuestionAsked { .. }))
            .count();
        let question_cancelled = events
            .iter()
            .filter(|ev| {
                matches!(ev, SessionEvent::QuestionResolved { state, .. } if state == "cancelled")
            })
            .count();
        assert_eq!(question_asked, 1);
        assert_eq!(question_cancelled, 1);
    }
}
