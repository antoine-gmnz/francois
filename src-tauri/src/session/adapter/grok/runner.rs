//! Driving one `grok -p --output-format streaming-json` turn: spawn, read,
//! translate, finish (multi-provider-grok FR-5..FR-9, FR-13..FR-18, FR-27).
//!
//! Same split `codex::runner` documents: a pure `Translator` state machine
//! (`GrokEvent` → `Effect`), and a thin `apply` half that performs them
//! against the `AppHandle`. Nothing here needs a live `AppHandle` to test.

use super::args::grok_invocation;
use super::wire::{self, GrokEvent};
use super::{GrokTurnHandle, GROK_MISSING_HINT};
use crate::ipc::AppError;
use crate::session::adapter::TurnContext;
use crate::session::*;

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

// ---------- the pure translation (FR-13..FR-18) ----------

/// One thing a `GrokEvent` asks the engine to do.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Effect {
    /// FR-14: a streamed chunk of assistant text. `accumulated` is the
    /// block's full text so far (what the transcript buffer stores);
    /// `delta`/`offset` are what rides `SessionEvent::AssistantDelta`.
    TextDelta {
        block_id: String,
        delta: String,
        accumulated: String,
        offset: usize,
    },
    TextDone {
        block_id: String,
        text: String,
    },
    ToolStart {
        block_id: String,
        tool: String,
        summary: String,
    },
    ToolDone {
        block_id: String,
        tool: String,
        meta: String,
    },
    /// FR-16: context window occupancy, off `end`'s aggregate usage only.
    Usage(u64),
    Failed(String),
}

/// FR-15: ACP `kind` → the Claude Code tool vocabulary a permission rule and
/// a transcript card both key off (the standing naming decision). Unmapped
/// (including `think`/`switch_mode`/`other`/anything future) falls through to
/// the caller's own `toolName`/`title` — a generic card, never dropped.
fn kind_to_claude_name(kind: &str) -> Option<&'static str> {
    match kind {
        "read" => Some("Read"),
        // `delete`/`move` mutate the working tree exactly like `edit` does —
        // same displayed name, so the SAME diff-recompute trigger `apply`
        // keys off ("Edit") fires for all three.
        "edit" | "delete" | "move" => Some("Edit"),
        "search" => Some("Grep"),
        "execute" => Some("Bash"),
        "fetch" => Some("WebFetch"),
        _ => None,
    }
}

/// FR-15: the displayed tool name for a `tool_call`. `kind` wins when it maps
/// to Claude Code's vocabulary; otherwise the CLI's own `toolName` (its
/// internal tool id, e.g. `read_file`), then `title`, then a bare fallback —
/// never dropped, per FR-15's "unknown kind renders as a generic tool card".
fn tool_display_name(kind: Option<&str>, tool_name: Option<&str>, title: Option<&str>) -> String {
    if let Some(mapped) = kind.and_then(kind_to_claude_name) {
        return mapped.to_string();
    }
    tool_name
        .or(title)
        .filter(|s| !s.is_empty())
        .unwrap_or("Tool")
        .to_string()
}

/// The completion meta for a finished tool card. `status` is Grok's own
/// (`pending`/`in_progress`/`completed`/`failed`) — no richer output shape is
/// documented per-tool, so this is intentionally coarse rather than guessed.
fn tool_meta(status: Option<&str>) -> String {
    match status {
        Some("failed") => "failed".to_string(),
        _ => "done".to_string(),
    }
}

/// FR-13..FR-18: the stream → effects state machine.
///
/// Stateful for two reasons: (1) consecutive `text` chunks belong to ONE open
/// assistant block until something else interrupts them (a tool call, a
/// response boundary, the turn's end); (2) a `tool_call`'s id must survive
/// until its `tool_call_update` closes the same card (FR-15).
pub(super) struct Translator<F: FnMut() -> String> {
    new_id: F,
    /// The currently-streaming assistant block: (block_id, accumulated text).
    open_text: Option<(String, String)>,
    /// Grok `toolCallId` → (Francois block id, displayed tool name).
    open_tools: HashMap<String, (String, String)>,
}

impl<F: FnMut() -> String> Translator<F> {
    pub(super) fn new(new_id: F) -> Self {
        Self {
            new_id,
            open_text: None,
            open_tools: HashMap::new(),
        }
    }

    /// Finalize whatever text block is open, if any — called before any
    /// non-text event so a tool call or the turn's end never lands mid-block.
    fn close_text(&mut self) -> Option<Effect> {
        let (block_id, text) = self.open_text.take()?;
        Some(Effect::TextDone { block_id, text })
    }

    pub(super) fn on_event(&mut self, event: GrokEvent) -> Vec<Effect> {
        match event {
            GrokEvent::Text { text } => {
                let (block_id, accumulated) = match self.open_text.take() {
                    Some(existing) => existing,
                    None => ((self.new_id)(), String::new()),
                };
                let offset = accumulated.encode_utf16().count();
                let mut accumulated = accumulated;
                accumulated.push_str(&text);
                let effect = Effect::TextDelta {
                    block_id: block_id.clone(),
                    delta: text,
                    accumulated: accumulated.clone(),
                    offset,
                };
                self.open_text = Some((block_id, accumulated));
                vec![effect]
            }
            GrokEvent::ToolCall {
                call_id,
                title,
                kind,
                tool_name,
            } => {
                let mut effects: Vec<Effect> = self.close_text().into_iter().collect();
                // Idempotent: a duplicate tool_call for an id already open
                // (Grok is not documented to repeat one, but §FR-12 leniency
                // means never trusting a stream not to) opens no second card.
                if !self.open_tools.contains_key(&call_id) {
                    let block_id = (self.new_id)();
                    let tool =
                        tool_display_name(kind.as_deref(), tool_name.as_deref(), title.as_deref());
                    let summary = title
                        .or(tool_name)
                        .filter(|s| !s.is_empty())
                        .unwrap_or_default();
                    self.open_tools
                        .insert(call_id, (block_id.clone(), tool.clone()));
                    effects.push(Effect::ToolStart {
                        block_id,
                        tool,
                        summary,
                    });
                }
                effects
            }
            GrokEvent::ToolCallUpdate { call_id, status } => {
                let mut effects: Vec<Effect> = self.close_text().into_iter().collect();
                let meta = tool_meta(status.as_deref());
                match self.open_tools.remove(&call_id) {
                    Some((block_id, tool)) => effects.push(Effect::ToolDone {
                        block_id,
                        tool,
                        meta,
                    }),
                    // An update with no matching start still has to appear —
                    // same "never silently drop the tool call" reasoning
                    // `codex::runner::Translator` documents.
                    None => {
                        let block_id = (self.new_id)();
                        effects.push(Effect::ToolStart {
                            block_id: block_id.clone(),
                            tool: "Tool".into(),
                            summary: String::new(),
                        });
                        effects.push(Effect::ToolDone {
                            block_id,
                            tool: "Tool".into(),
                            meta,
                        });
                    }
                }
                effects
            }
            GrokEvent::End { stop_reason, usage } => {
                let mut effects: Vec<Effect> = self.close_text().into_iter().collect();
                // FR-16: no usage reported ⇒ the meter stays empty, never
                // estimated.
                if !usage.is_zero() {
                    effects.push(Effect::Usage(usage.context_used()));
                }
                // FR-17: `refusal` ends the turn errored; every other stop
                // reason (including `cancelled`, which the reader loop's own
                // `interrupted` flag already accounts for) ends it cleanly.
                if stop_reason.as_deref() == Some("refusal") {
                    effects.push(Effect::Failed("grok refused this request".to_string()));
                }
                effects
            }
            GrokEvent::Error { message } => {
                let mut effects: Vec<Effect> = self.close_text().into_iter().collect();
                effects.push(Effect::Failed(message));
                effects
            }
            // FR-18: dropped explicitly, not by falling through.
            GrokEvent::Thought | GrokEvent::Plan => Vec::new(),
            // Recognized, no block corresponds to either.
            GrokEvent::ResponseUsage | GrokEvent::AvailableCommands => Vec::new(),
            GrokEvent::Unknown => Vec::new(),
        }
    }

    /// Whatever is still open when the stream ends — a killed child would
    /// otherwise leave a text block half-written or a tool card spinning
    /// forever.
    pub(super) fn close_open(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        if let Some(e) = self.close_text() {
            effects.push(e);
        }
        let mut open: Vec<(String, (String, String))> = self.open_tools.drain().collect();
        // HashMap order is not stable; the transcript's is.
        open.sort_by(|a, b| a.0.cmp(&b.0));
        for (_, (block_id, tool)) in open {
            effects.push(Effect::ToolDone {
                block_id,
                tool,
                meta: "interrupted".to_string(),
            });
        }
        effects
    }
}

// ---------- applying an effect ----------

fn apply(app: &AppHandle, session_id: &str, cwd: &str, effect: Effect) {
    match effect {
        Effect::TextDelta {
            block_id,
            delta,
            accumulated,
            offset,
        } => {
            app.state::<Engine>().with_session_mut(session_id, |s| {
                s.buf_assistant_streaming(&block_id, &accumulated);
            });
            emit(
                app,
                SessionEvent::AssistantDelta {
                    session_id: session_id.to_string(),
                    block_id,
                    text: delta,
                    offset,
                },
            );
        }
        Effect::TextDone { block_id, text } => {
            finalize_text_block(app, session_id, &block_id, text);
        }
        Effect::ToolStart {
            block_id,
            tool,
            summary,
        } => {
            let block = app
                .state::<Engine>()
                .with_session_mut(session_id, |s| {
                    s.buf_tool(&block_id, tool.clone(), summary.clone(), false, None);
                    s.block_buffer.last().cloned()
                })
                .flatten();
            if let Some(b) = &block {
                append_transcript(app, session_id, b);
            }
            emit(
                app,
                SessionEvent::ToolStart {
                    session_id: session_id.to_string(),
                    block_id,
                    tool,
                    summary,
                    model: None,
                },
            );
        }
        Effect::ToolDone {
            block_id,
            tool,
            meta,
        } => {
            let block = app
                .state::<Engine>()
                .with_session_mut(session_id, |s| {
                    s.buf_tool_done(&block_id, meta.clone());
                    s.block_buffer
                        .iter()
                        .find(|b| b.block_id == block_id)
                        .cloned()
                })
                .flatten();
            if let Some(b) = &block {
                append_transcript(app, session_id, b);
            }
            if tool == "Edit" {
                crate::diff::on_tool_done(app, session_id, cwd);
            }
            emit(
                app,
                SessionEvent::ToolDone {
                    session_id: session_id.to_string(),
                    block_id,
                    meta,
                },
            );
        }
        Effect::Usage(used) => {
            let limit = app
                .state::<Engine>()
                .with_session(session_id, |s| s.context_limit_tokens)
                .unwrap_or(0);
            let used = if limit > 0 { used.min(limit) } else { used };
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
        // Applied by the reader loop, which owns turn termination.
        Effect::Failed(_) => {}
    }
}

// ---------- spawn + read ----------

const SANDBOX_UNAVAILABLE_NOTICE: &str =
    "Grok's sandbox (Landlock/Seatbelt) has no Windows implementation — this session runs with no OS-level sandboxing, relying on the model's own cooperation.";

/// FR-5/FR-8: start the turn. Unlike `claude`/`codex`, the prompt rides the
/// `-p` ARGUMENT, not stdin (see `args.rs`'s module doc) — nothing is written
/// to the child's stdin at all, so it is closed immediately.
pub(super) fn begin_turn(
    app: &AppHandle,
    ctx: TurnContext,
) -> Result<Arc<dyn crate::session::adapter::TurnControl>, AppError> {
    let config_dir = crate::account::config_dir_of(app, &ctx.account_id);

    // FR-8: OUR session id is the anchor from the very first turn — there is
    // no vendor-minted id to capture off the stream, unlike Codex's
    // `thread.started`. Set once; a no-op on every later turn.
    app.state::<Engine>()
        .with_session_mut(&ctx.session_id, |s| {
            if s.claude_session_id.is_none() {
                s.claude_session_id = Some(ctx.session_id.clone());
            }
        });

    // FR-27: once per session, Windows only, before the turn spawns.
    if cfg!(windows) {
        let claimed = app
            .state::<Engine>()
            .with_session_mut(&ctx.session_id, |s| s.claim_grok_sandbox_notice())
            .unwrap_or(false);
        if claimed {
            finalize_command_block(
                app,
                &ctx.session_id,
                &uuid(),
                "notice",
                &CommandCard::Notice {
                    text: SANDBOX_UNAVAILABLE_NOTICE.into(),
                },
            );
        }
    }

    let resume = ctx.resume.is_some();
    let (program, argv) = grok_invocation(
        &ctx.text,
        &ctx.model_id,
        &ctx.session_id,
        resume,
        &ctx.permission_mode,
    );

    let mut cmd = Command::new(program);
    cmd.args(argv);
    // FR-5: the child's own working directory, not a `--cwd` flag — see
    // args.rs's module doc for why.
    cmd.current_dir(&ctx.cwd);
    if let Some(path) = claude_path_env() {
        cmd.env("PATH", path);
    }
    // FR-19: this turn runs under its session's account.
    for (k, v) in account_env_for_kind(
        config_dir.as_deref(),
        crate::account::AccountKind::GrokCli,
        &ctx.runtime,
        &[],
    ) {
        cmd.env(k, v);
    }
    no_window(&mut cmd);
    // FR-5: nothing is ever written to stdin (the prompt is argv), so it is
    // closed rather than piped — an inherited or piped-with-no-writer stdin
    // risks the child blocking on a read that will never resolve.
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let child = cmd.spawn().map_err(|e| AppError {
        code: "SPAWN_FAILED".into(),
        message: if e.kind() == std::io::ErrorKind::NotFound {
            GROK_MISSING_HINT.to_string()
        } else {
            format!("could not start grok: {e}")
        },
        detail: None,
    });
    let mut child = child?;

    let stdout = child.stdout.take();
    let child = Arc::new(Mutex::new(child));
    let interrupted = Arc::new(AtomicBool::new(false));
    let handle: Arc<GrokTurnHandle> = Arc::new(GrokTurnHandle {
        child: child.clone(),
        interrupted: interrupted.clone(),
    });

    let app2 = app.clone();
    let TurnContext {
        session_id, cwd, ..
    } = ctx;
    std::thread::spawn(move || match stdout {
        Some(out) => run_reader(
            app2,
            session_id,
            cwd,
            BufReader::new(out),
            child,
            interrupted,
        ),
        None => finish_turn(
            &app2,
            &session_id,
            true,
            Some("grok produced no output".into()),
        ),
    });

    Ok(handle)
}

fn run_reader<R: BufRead>(
    app: AppHandle,
    session_id: String,
    cwd: String,
    reader: R,
    child: Arc<Mutex<std::process::Child>>,
    interrupted: Arc<AtomicBool>,
) {
    let mut translator = Translator::new(uuid);
    let mut failure: Option<String> = None;
    let mut completed = false;

    for line in reader.lines() {
        if interrupted.load(Ordering::SeqCst) {
            break;
        }
        let Ok(line) = line else { break };
        let event = wire::parse_line(&line);
        if matches!(event, GrokEvent::End { .. }) {
            completed = true;
        }
        for effect in translator.on_event(event) {
            if let Effect::Failed(message) = &effect {
                failure.get_or_insert_with(|| message.clone());
                continue;
            }
            apply(&app, &session_id, &cwd, effect);
        }
    }

    for effect in translator.close_open() {
        apply(&app, &session_id, &cwd, effect);
    }

    let status = child.lock().unwrap().wait();
    let interrupted = interrupted.load(Ordering::SeqCst);

    let error = failure.or_else(|| {
        if interrupted || completed {
            None
        } else {
            Some(match status {
                Ok(s) if !s.success() => format!("grok exited with status {s}"),
                _ => "grok ended without completing the turn".to_string(),
            })
        }
    });

    match error {
        Some(message) => finish_turn(&app, &session_id, true, Some(message)),
        None => finish_turn(&app, &session_id, false, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::adapter::grok::wire::parse_line;

    fn counter() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("b{n}")
        }
    }

    fn translate_all(lines: &str) -> Vec<Effect> {
        let mut t = Translator::new(counter());
        let mut out: Vec<Effect> = lines
            .lines()
            .flat_map(|l| t.on_event(parse_line(l)))
            .collect();
        out.extend(t.close_open());
        out
    }

    // ---------- FR-13: the captured (doc-derived) turn, end to end ----------

    #[test]
    fn the_captured_turn_translates_into_the_expected_blocks() {
        let effects = translate_all(include_str!("fixtures/exec_turn.jsonl"));
        assert_eq!(
            effects,
            vec![
                Effect::TextDelta {
                    block_id: "b1".into(),
                    delta: "I\u{2019}ll check the current folder.".into(),
                    accumulated: "I\u{2019}ll check the current folder.".into(),
                    offset: 0,
                },
                Effect::TextDone {
                    block_id: "b1".into(),
                    text: "I\u{2019}ll check the current folder.".into(),
                },
                Effect::ToolStart {
                    block_id: "b2".into(),
                    tool: "Read".into(),
                    summary: "Read".into(),
                },
                Effect::ToolDone {
                    block_id: "b2".into(),
                    tool: "Read".into(),
                    meta: "done".into(),
                },
                Effect::TextDelta {
                    block_id: "b3".into(),
                    delta: "Here's a summary of src/main.rs.".into(),
                    accumulated: "Here's a summary of src/main.rs.".into(),
                    offset: 0,
                },
                Effect::TextDone {
                    block_id: "b3".into(),
                    text: "Here's a summary of src/main.rs.".into(),
                },
                Effect::Usage(812 + 45),
            ]
        );
    }

    // ---------- FR-14: consecutive text chunks are ONE block ----------

    #[test]
    fn consecutive_text_events_accumulate_into_one_block_with_growing_offsets() {
        let effects = translate_all(
            "{\"type\":\"text\",\"data\":\"Hel\"}\n{\"type\":\"text\",\"data\":\"lo\"}",
        );
        assert_eq!(
            effects,
            vec![
                Effect::TextDelta {
                    block_id: "b1".into(),
                    delta: "Hel".into(),
                    accumulated: "Hel".into(),
                    offset: 0,
                },
                Effect::TextDelta {
                    block_id: "b1".into(),
                    delta: "lo".into(),
                    accumulated: "Hello".into(),
                    offset: 3,
                },
                Effect::TextDone {
                    block_id: "b1".into(),
                    text: "Hello".into(),
                },
            ]
        );
    }

    #[test]
    fn a_tool_call_closes_any_open_text_block_first() {
        let effects = translate_all(
            r#"{"type":"text","data":"checking"}
{"type":"tool_call","toolCallId":"c1","title":"Read","kind":"read","toolName":"read_file"}"#,
        );
        assert_eq!(
            effects,
            vec![
                Effect::TextDelta {
                    block_id: "b1".into(),
                    delta: "checking".into(),
                    accumulated: "checking".into(),
                    offset: 0,
                },
                Effect::TextDone {
                    block_id: "b1".into(),
                    text: "checking".into(),
                },
                Effect::ToolStart {
                    block_id: "b2".into(),
                    tool: "Read".into(),
                    summary: "Read".into(),
                },
                // `translate_all` always drains `close_open` — the tool call
                // above never received its `tool_call_update`.
                Effect::ToolDone {
                    block_id: "b2".into(),
                    tool: "Read".into(),
                    meta: "interrupted".into(),
                },
            ]
        );
    }

    // ---------- FR-15: tool name mapping ----------

    #[test]
    fn an_unmapped_kind_falls_back_to_tool_name_then_title() {
        let effects = translate_all(
            r#"{"type":"tool_call","toolCallId":"c1","title":"Update plan","kind":"think","toolName":"update_plan"}"#,
        );
        match &effects[0] {
            Effect::ToolStart { tool, .. } => assert_eq!(tool, "update_plan"),
            other => panic!("expected ToolStart, got {other:?}"),
        }
    }

    #[test]
    fn edit_delete_and_move_kinds_all_display_as_edit() {
        for kind in ["edit", "delete", "move"] {
            let line = format!(
                r#"{{"type":"tool_call","toolCallId":"c1","kind":"{kind}","toolName":"x"}}"#
            );
            let effects = translate_all(&line);
            match &effects[0] {
                Effect::ToolStart { tool, .. } => assert_eq!(tool, "Edit", "kind={kind}"),
                other => panic!("expected ToolStart, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_finishing_edit_tool_is_named_edit_so_the_diff_view_recomputes() {
        let effects = translate_all(
            r#"{"type":"tool_call","toolCallId":"c1","kind":"edit","toolName":"search_replace","title":"Edit"}
{"type":"tool_call_update","toolCallId":"c1","status":"completed"}"#,
        );
        match &effects[1] {
            Effect::ToolDone { tool, meta, .. } => {
                assert_eq!(tool, "Edit");
                assert_eq!(meta, "done");
            }
            other => panic!("expected ToolDone, got {other:?}"),
        }
    }

    #[test]
    fn a_failed_tool_call_reports_failed_not_done() {
        let effects = translate_all(
            r#"{"type":"tool_call","toolCallId":"c1","kind":"execute","toolName":"run_terminal_cmd"}
{"type":"tool_call_update","toolCallId":"c1","status":"failed"}"#,
        );
        match effects.last().unwrap() {
            Effect::ToolDone { meta, .. } => assert_eq!(meta, "failed"),
            other => panic!("expected ToolDone, got {other:?}"),
        }
    }

    #[test]
    fn an_update_with_no_matching_start_still_produces_a_card() {
        let effects =
            translate_all(r#"{"type":"tool_call_update","toolCallId":"c1","status":"completed"}"#);
        assert_eq!(
            effects,
            vec![
                Effect::ToolStart {
                    block_id: "b1".into(),
                    tool: "Tool".into(),
                    summary: String::new(),
                },
                Effect::ToolDone {
                    block_id: "b1".into(),
                    tool: "Tool".into(),
                    meta: "done".into(),
                },
            ]
        );
    }

    // ---------- FR-13: what produces nothing ----------

    #[test]
    fn thought_plan_response_usage_and_available_commands_produce_no_blocks() {
        let effects = translate_all(
            r#"{"type":"thought","data":"hmm"}
{"type":"plan","entries":[]}
{"type":"usage","messageId":"r1","usage":{}}
{"type":"available_commands","tools":[],"commands":[]}
not json at all
{"type":"brand.new.event"}"#,
        );
        assert_eq!(effects, Vec::new());
    }

    // ---------- interruption ----------

    #[test]
    fn a_stream_that_dies_mid_tool_call_closes_the_open_card() {
        let effects = translate_all(
            r#"{"type":"tool_call","toolCallId":"c1","kind":"execute","toolName":"run_terminal_cmd","title":"sleep 100"}"#,
        );
        assert_eq!(
            effects,
            vec![
                Effect::ToolStart {
                    block_id: "b1".into(),
                    tool: "Bash".into(),
                    summary: "sleep 100".into(),
                },
                Effect::ToolDone {
                    block_id: "b1".into(),
                    tool: "Bash".into(),
                    meta: "interrupted".into(),
                },
            ]
        );
    }

    #[test]
    fn a_stream_that_dies_mid_text_still_closes_the_block() {
        let effects = translate_all(r#"{"type":"text","data":"partial"}"#);
        assert_eq!(
            effects,
            vec![
                Effect::TextDelta {
                    block_id: "b1".into(),
                    delta: "partial".into(),
                    accumulated: "partial".into(),
                    offset: 0,
                },
                Effect::TextDone {
                    block_id: "b1".into(),
                    text: "partial".into(),
                },
            ]
        );
    }

    // ---------- FR-16/17: end ----------

    #[test]
    fn end_reports_usage_once() {
        let effects = translate_all(
            r#"{"type":"end","stopReason":"end_turn","usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":0,"reasoning_tokens":4}}"#,
        );
        assert_eq!(effects, vec![Effect::Usage(160)]);
    }

    #[test]
    fn end_with_no_usage_reports_nothing_rather_than_estimating() {
        let effects = translate_all(r#"{"type":"end","stopReason":"cancelled"}"#);
        assert_eq!(effects, Vec::new());
    }

    #[test]
    fn a_refusal_stop_reason_ends_the_turn_errored() {
        let effects = translate_all(r#"{"type":"end","stopReason":"refusal"}"#);
        assert_eq!(
            effects,
            vec![Effect::Failed("grok refused this request".into())]
        );
    }

    #[test]
    fn an_error_line_surfaces_as_a_failure_effect() {
        assert_eq!(
            translate_all(r#"{"type":"error","message":"rate limited"}"#),
            vec![Effect::Failed("rate limited".into())]
        );
    }

    #[test]
    fn a_failure_mid_stream_does_not_stop_earlier_blocks_from_rendering() {
        let effects = translate_all(
            r#"{"type":"text","data":"starting"}
{"type":"error","message":"boom"}"#,
        );
        assert_eq!(
            effects,
            vec![
                Effect::TextDelta {
                    block_id: "b1".into(),
                    delta: "starting".into(),
                    accumulated: "starting".into(),
                    offset: 0,
                },
                Effect::TextDone {
                    block_id: "b1".into(),
                    text: "starting".into(),
                },
                Effect::Failed("boom".into()),
            ]
        );
    }
}
