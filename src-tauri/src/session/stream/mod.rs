//! the per-turn NDJSON reader and its stream-event handlers, split by
//! concern: `lines` (top-level NDJSON line dispatch + turn teardown),
//! `blocks` (`content_block_*` stream events), `tool_results` (`tool_result`
//! reconciliation). `mod.rs` owns the shared per-turn bookkeeping types
//! (`ToolRec`, `BlockKind`) and `run_reader`, the module's one entry point
//! (called from `turn.rs`).
//!
//! Re-exported at `pub(crate)` so `session::stream::<name>` keeps resolving
//! unchanged — `session/mod.rs`'s own `pub(crate) use stream::*;` is what
//! lets `agents.rs` reach `extract_result_text` as a bare name.

mod blocks;
mod lines;
mod tool_results;

pub(crate) use blocks::*;
pub(crate) use lines::*;
pub(crate) use tool_results::*;

use super::*;

use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

/// Per-turn state while parsing the NDJSON stream.
pub(crate) struct ToolRec {
    block_id: String,
    tool: String,
    input: Value,
    is_task: bool,
    /// workflow-panel FR-2: this call is a `Workflow` dispatch, so its input and
    /// its tool_result feed pane [6] as well as the transcript.
    is_workflow: bool,
}

/// What kind of content block a stream index is carrying.
///
/// This was a bare `u8` in a positional tuple with `0=text 1=tool` recorded only
/// in a comment — so a miswritten literal, or a comparison against the wrong
/// number, compiled clean and silently routed a tool block through the text path.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum BlockKind {
    Text,
    Tool,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_reader(
    app: AppHandle,
    session_id: String,
    child: Arc<Mutex<Child>>,
    interrupted: Arc<AtomicBool>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending_questions: Arc<Mutex<HashMap<String, PendingQuestion>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    model_id: String,
    resume_used: bool,
    block_id: String,
    text: String,
) {
    // Take stdout out of the shared child so we can read without holding its lock.
    let stdout = { child.lock().unwrap().stdout.take() };
    let Some(stdout) = stdout else {
        finish_turn(&app, &session_id, false, None);
        return;
    };
    let reader = BufReader::new(stdout);

    // index -> (blockId, kind, input_accum)
    let mut blocks: HashMap<u64, (String, BlockKind, String)> = HashMap::new();
    let mut tools: HashMap<String, ToolRec> = HashMap::new(); // tool_use_id -> rec
    let mut text_accum: HashMap<String, String> = HashMap::new(); // blockId -> text
    let mut open_block: Option<(String, BlockKind)> = None;
    let mut ctx_usage = ContextTracker::default();
    let mut got_result = false;
    let mut got_init = false; // did the stream start (system/init)? — resume-fail detection (FR-8)
    let mut result_error: Option<String> = None;
    // interactive-commands: the turn's parsed command token (FR-17), whether a
    // synthetic message was carded (FR-16), and the result string (FR-18 fallback).
    let turn_cmd: Option<String> = parse_command(&text).map(|(c, _)| c);
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

    let cwd = {
        let engine = app.state::<Engine>();
        let map = engine.sessions.lock().unwrap();
        map.get(&session_id)
            .map(|s| s.cwd.clone())
            .unwrap_or_default()
    };

    for line in reader.lines() {
        let Ok(line) = line else { break };
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
                attribute_inner_line(&app, &session_id, &ptuid, &v, &cwd);
                continue;
            }
            LineRoute::Notice => {
                // async-agents FR-13: a harness-injected task-notification closes
                // its background agent and never reaches the transcript.
                // workflow-panel FR-8: three rungs, most specific first. The
                // workflow ladder's NAMED rungs (run id / name) go before the
                // agent ladder, whose own last rung would otherwise let a lone
                // background agent swallow a workflow's completion notice; the
                // workflow ladder's sole-candidate rung goes after it, for the
                // symmetric reason.
                if handle_workflow_notification(&app, &session_id, &v, false)
                    || handle_task_notification(&app, &session_id, &v)
                    || handle_workflow_notification(&app, &session_id, &v, true)
                {
                    continue;
                }
            }
            LineRoute::Parent => {}
        }
        let line_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match line_type {
            "system" => {
                if let Some(running) = parse_background_tasks(&v) {
                    bg_tasks.store(running, Ordering::Relaxed);
                }
                if handle_system_line(&app, &session_id, &cwd, &v) {
                    got_init = true;
                    // The stream is live: `starting` → `running`. Only the init
                    // line promotes, so the spawn window is a real state rather
                    // than a claim that work began the instant we forked.
                    mark_stream_live(&app, &session_id);
                }
            }
            "stream_event" => {
                if let Some(ev) = v.get("event") {
                    handle_stream_event(
                        &app,
                        &session_id,
                        &cwd,
                        ev,
                        &mut blocks,
                        &mut tools,
                        &mut text_accum,
                        &mut open_block,
                        &mut ctx_usage,
                    );
                }
            }
            "user" => {
                handle_tool_results(&app, &session_id, &v, &mut tools, &mut open_block);
            }
            "assistant" => {
                if handle_assistant_line(&app, &session_id, turn_cmd.as_deref(), &v) {
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
                    &stdin,
                    &pending_questions,
                    &pending_permissions,
                    &bg_tasks,
                    &last_line_at,
                    &mut closer_armed,
                );
            }
            "control_request" => {
                // session-questions FR-6..FR-9 + permission-guardrails FR-1/FR-2.
                handle_control_request(
                    &app,
                    &session_id,
                    &v,
                    &stdin,
                    &pending_questions,
                    &pending_permissions,
                );
            }
            "control_cancel_request" => {
                // session-questions FR-10 / permission-guardrails FR-10: the CLI
                // withdrew a parked request. Unmatched ids are ignored.
                handle_control_cancel_line(
                    &app,
                    &session_id,
                    &v,
                    &stdin,
                    &pending_questions,
                    &pending_permissions,
                );
            }
            _ => {} // keep_alive & any unrecognized top-level type stay ignored (FR-4)
        }
    }

    // session-questions FR-2: stdout is gone (result, child death, or interrupt) —
    // drop the stdin writer before wait() so the CLI can never linger on an open pipe.
    *stdin.lock().unwrap() = None;
    let _ = child.lock().unwrap().wait();
    let was_interrupted = interrupted.load(Ordering::SeqCst);

    drain_orphaned_questions(&app, &session_id, &pending_questions);
    drain_orphaned_permissions(&app, &session_id, &pending_permissions);

    // Resume-fail (FR-8/9): Claude rejected the stale --resume id before starting a
    // thread. Tell the UI and transparently re-run the same message on a fresh thread
    // (ResumeRetry forces resume off → this can fire at most once). The stored id is
    // left in place — a fresh init overwrites it on success; a transient failure keeps it.
    if is_resume_fail(resume_used, got_init, got_result, was_interrupted) {
        emit(
            &app,
            SessionEvent::ResumeFailed {
                session_id: session_id.clone(),
            },
        );
        begin_turn(&app, &session_id, block_id, text, TurnMode::ResumeRetry);
        return;
    }

    // Close any block left open (interrupt or crash) — FR-24/FR-34.
    close_open_block(&app, &session_id, open_block.take(), &text_accum);

    let had_blocks = !blocks.is_empty();
    finish_reader_turn(
        &app,
        &session_id,
        &model_id,
        ctx_usage,
        got_result,
        result_error,
        was_interrupted,
        saw_synthetic,
        had_blocks,
        result_text,
        turn_cmd.as_deref(),
    );
}
