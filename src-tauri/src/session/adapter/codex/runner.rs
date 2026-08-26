//! Driving one `codex exec` turn: spawn, read, translate, finish
//! (multi-provider-codex FR-5..FR-8, FR-13..FR-15).
//!
//! The translation is a **pure state machine** (`Translator`) that turns a
//! `CodexEvent` into a list of `Effect`s, and a thin apply half that performs
//! them against the `AppHandle`. That split is deliberate and follows this
//! crate's documented convention: there is no `AppHandle` test harness, so
//! anything worth testing must not need one. Everything interesting here —
//! which blocks a stream produces, in what order, addressed by which id — is on
//! the pure side.

use super::args::codex_invocation;
use super::wire::{self, CodexEvent, ItemKind};
use super::{CodexTurnHandle, CODEX_MISSING_HINT};
use crate::ipc::AppError;
use crate::ipc::ErrorCode;
use crate::session::adapter::TurnContext;
use crate::session::*;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write as _};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

// ---------- the pure translation (FR-13/FR-14) ----------

/// One thing a `CodexEvent` asks the engine to do. Naming the effects rather
/// than performing them inline is what lets the whole FR-13 table be tested.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Effect {
    /// FR-8: store Codex's `thread_id` as the session's resume anchor.
    Anchor(String),
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
    /// FR-13: a whole assistant message. No delta variant — this transport has
    /// none (§2).
    Assistant {
        block_id: String,
        text: String,
    },
    /// FR-15: context window occupancy.
    Usage(u64),
    Failed(String),
}

/// How one Codex item renders as a Francois tool block (FR-14). `None` for the
/// item kinds that produce no block at all (`agent_message` has its own effect,
/// `reasoning` is dropped, unknown kinds are ignored).
fn tool_view(kind: &ItemKind) -> Option<(String, String)> {
    match kind {
        ItemKind::CommandExecution { command, .. } => {
            Some(("Bash".to_string(), shell_summary(command)))
        }
        // Named `Edit` rather than `FileChange` so it reaches the SAME
        // downstream behaviour a Claude edit does — `finish_tool_block` keys the
        // diff-view recompute off this exact name (FR-14).
        ItemKind::FileChange { paths } => Some(("Edit".to_string(), summarize_paths(paths))),
        ItemKind::McpToolCall { server, tool, .. } => Some((
            format!("mcp__{server}__{tool}"),
            if tool.is_empty() {
                server.clone()
            } else {
                tool.clone()
            },
        )),
        ItemKind::WebSearch { query } => Some(("WebSearch".to_string(), query.clone())),
        ItemKind::TodoList { count } => Some((
            "TodoWrite".to_string(),
            format!("{count} item{}", if *count == 1 { "" } else { "s" }),
        )),
        ItemKind::AgentMessage { .. } | ItemKind::Reasoning | ItemKind::Unknown => None,
    }
}

/// The completion meta for a finished item.
///
/// For a command this follows the Claude path's `meta_bash` convention
/// (`"N lines"` / `"done"`) so the two runtimes read alike — **except** on a
/// non-zero exit, which says so instead. A failed command that reported
/// "3 lines" would bury the only fact that matters about it.
fn tool_meta(kind: &ItemKind) -> String {
    match kind {
        ItemKind::CommandExecution {
            aggregated_output,
            exit_code,
            ..
        } => match exit_code {
            Some(code) if *code != 0 => format!("exit {code}"),
            _ => {
                if aggregated_output.trim().is_empty() {
                    "done".to_string()
                } else {
                    format!("{} lines", aggregated_output.lines().count())
                }
            }
        },
        ItemKind::FileChange { paths } => match paths.len() {
            0 => "done".to_string(),
            1 => "1 file".to_string(),
            n => format!("{n} files"),
        },
        ItemKind::McpToolCall { status, .. } => {
            if status.is_empty() {
                "done".to_string()
            } else {
                status.clone()
            }
        }
        _ => "done".to_string(),
    }
}

/// Codex reports the command it ran as a full shell invocation
/// (`"C:\…\pwsh.exe" -Command ls`, or `bash -lc 'npm test'`). The wrapper is
/// noise in a transcript — the user cares about `ls`. Strips a leading program
/// plus a single command-string flag, and returns the input untouched when it
/// does not match that shape, so an unrecognised form degrades to "slightly
/// verbose" rather than "mangled".
fn shell_summary(command: &str) -> String {
    let trimmed = command.trim();
    let Some((_program, rest)) = split_program(trimmed) else {
        return trimmed.to_string();
    };
    let rest = rest.trim_start();
    for flag in ["-Command", "-command", "-lc", "-c"] {
        if let Some(tail) = rest.strip_prefix(flag) {
            // Only when the flag is a whole token — `-command-ish` is not a match.
            if tail.starts_with(char::is_whitespace) {
                return unquote(tail.trim()).to_string();
            }
        }
    }
    trimmed.to_string()
}

/// Split off the leading program token, honouring the double quotes Codex wraps
/// a path in when it contains spaces. `None` when there is no separator at all.
fn split_program(s: &str) -> Option<(&str, &str)> {
    if let Some(rest) = s.strip_prefix('"') {
        let end = rest.find('"')?;
        return Some((&rest[..end], &rest[end + 1..]));
    }
    s.split_once(char::is_whitespace)
}

fn unquote(s: &str) -> &str {
    for q in ['"', '\''] {
        if let Some(inner) = s.strip_prefix(q).and_then(|r| r.strip_suffix(q)) {
            return inner;
        }
    }
    s
}

fn summarize_paths(paths: &[String]) -> String {
    match paths.len() {
        0 => "files".to_string(),
        1 => paths[0].clone(),
        n => format!("{} +{} more", paths[0], n - 1),
    }
}

/// FR-13/FR-14: the stream → effects state machine.
///
/// Stateful for one reason: an item's `started` and its `completed` are two
/// events that must address **one** block, so the id assigned at the first
/// sighting has to survive until the second.
pub(super) struct Translator<F: FnMut() -> String> {
    new_id: F,
    /// Codex item id → the Francois block id it was opened with.
    open: HashMap<String, String>,
}

impl<F: FnMut() -> String> Translator<F> {
    pub(super) fn new(new_id: F) -> Self {
        Self {
            new_id,
            open: HashMap::new(),
        }
    }

    pub(super) fn on_event(&mut self, event: CodexEvent) -> Vec<Effect> {
        match event {
            CodexEvent::ThreadStarted { thread_id } => vec![Effect::Anchor(thread_id)],
            CodexEvent::ItemStarted { item } | CodexEvent::ItemUpdated { item } => {
                match tool_view(&item.kind) {
                    // Opening is idempotent: `item.updated` for an item already
                    // live must not produce a second card.
                    Some((tool, summary)) if !self.open.contains_key(&item.id) => {
                        let block_id = (self.new_id)();
                        self.open.insert(item.id, block_id.clone());
                        vec![Effect::ToolStart {
                            block_id,
                            tool,
                            summary,
                        }]
                    }
                    _ => Vec::new(),
                }
            }
            CodexEvent::ItemCompleted { item } => match &item.kind {
                ItemKind::AgentMessage { text } if !text.trim().is_empty() => {
                    vec![Effect::Assistant {
                        block_id: (self.new_id)(),
                        text: text.clone(),
                    }]
                }
                kind => {
                    let Some((tool, summary)) = tool_view(kind) else {
                        return Vec::new();
                    };
                    let mut effects = Vec::new();
                    // An item whose `started` we never saw still has to appear —
                    // several kinds only ever emit `completed`, and a card that
                    // is never opened would silently drop the tool call.
                    let block_id = match self.open.remove(&item.id) {
                        Some(id) => id,
                        None => {
                            let id = (self.new_id)();
                            effects.push(Effect::ToolStart {
                                block_id: id.clone(),
                                tool: tool.clone(),
                                summary,
                            });
                            id
                        }
                    };
                    effects.push(Effect::ToolDone {
                        block_id,
                        tool,
                        meta: tool_meta(kind),
                    });
                    effects
                }
            },
            CodexEvent::TurnCompleted { usage } => vec![Effect::Usage(usage.context_used())],
            CodexEvent::Failed { message } => vec![Effect::Failed(message)],
            CodexEvent::TurnStarted | CodexEvent::Unknown => Vec::new(),
        }
    }

    /// Whatever is still open when the stream ends. A child killed mid-command
    /// would otherwise leave a tool card spinning forever in the transcript.
    pub(super) fn close_open(&mut self) -> Vec<Effect> {
        let mut ids: Vec<(String, String)> = self.open.drain().collect();
        // HashMap order is not stable; the transcript's is.
        ids.sort();
        ids.into_iter()
            .map(|(_, block_id)| Effect::ToolDone {
                block_id,
                tool: String::new(),
                meta: "interrupted".to_string(),
            })
            .collect()
    }
}

// ---------- applying an effect ----------

fn apply(app: &AppHandle, session_id: &str, cwd: &str, effect: Effect) {
    match effect {
        Effect::Anchor(thread_id) => {
            let engine = app.state::<Engine>();
            engine.with_session_mut(session_id, |s| {
                s.claude_session_id = Some(thread_id);
            });
            // FR-8: persist immediately so the anchor survives a quit that
            // happens mid-turn — the whole point of resuming.
            persist(app, &engine);
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
            // transcript-scale CRITICAL fix: use the clone `buf_tool_done`
            // returns (captured before its internal trim runs) instead of
            // re-`find`ing by id — a re-find can miss a block that settling
            // itself just evicted.
            let block = app
                .state::<Engine>()
                .with_session_mut(session_id, |s| s.buf_tool_done(&block_id, meta.clone()))
                .flatten();
            if let Some(b) = &block {
                append_transcript(app, session_id, b);
            }
            // FR-14: a file change recomputes the diff summary exactly as a
            // Claude `Edit` does — same trigger, same tool name.
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
        Effect::Assistant { block_id, text } => {
            finalize_text_block(app, session_id, &block_id, text);
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

/// FR-5/FR-6: start the turn. The prompt goes down stdin and stdin is then
/// **closed** — Codex reads instructions until EOF, so leaving it open would
/// hang the turn forever rather than fail it.
pub(super) fn begin_turn(
    app: &AppHandle,
    ctx: TurnContext,
) -> Result<Arc<dyn crate::session::adapter::TurnControl>, AppError> {
    let config_dir = crate::account::config_dir_of(app, &ctx.account_id);
    let (program, argv) = codex_invocation(
        &ctx.model_id,
        ctx.resume.as_deref(),
        ctx.effort.as_deref(),
        &ctx.permission_mode,
    );

    // The facade resolves PATH against the login shell for the same reason
    // every `claude` spawn needs it: a GUI app launched from Finder/Dock
    // inherits launchd's minimal PATH, so an npm/homebrew-installed `codex` is
    // otherwise invisible. (On Windows that leg is a no-op — there the problem
    // is the missing `.cmd` extension instead, handled by `codex_program`.)
    //
    // FR-6: `codex exec resume` has no `--cd`, so the child's own working
    // directory is how BOTH forms learn the cwd. Set unconditionally.
    // FR-18: this turn runs under its session's account.
    let mut child = crate::process_util::spawn(program)
        .args(argv)
        .current_dir(&ctx.cwd)
        .envs(account_env_for_kind(
            config_dir.as_deref(),
            crate::account::AccountKind::CodexCli,
            &ctx.runtime,
            &[],
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .start()
        .map_err(|e| AppError {
            code: ErrorCode::SpawnFailed,
            message: if e.kind() == std::io::ErrorKind::NotFound {
                CODEX_MISSING_HINT.to_string()
            } else {
                format!("could not start codex: {e}")
            },
            detail: None,
        })?;

    // The prompt, then EOF. A failure here means the child died before reading
    // it — a spawn failure in everything but name.
    let wrote = match child.stdin.take() {
        Some(mut w) => w.write_all(ctx.text.as_bytes()).and_then(|_| w.flush()),
        None => Ok(()),
    };
    if let Err(e) = wrote {
        let _ = child.kill();
        return Err(AppError {
            code: ErrorCode::SpawnFailed,
            message: format!("could not send the prompt to codex: {e}"),
            detail: None,
        });
    }

    let stdout = child.stdout.take();
    let child = Arc::new(Mutex::new(child));
    let interrupted = Arc::new(AtomicBool::new(false));
    let handle: Arc<CodexTurnHandle> = Arc::new(CodexTurnHandle {
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
            Some("codex produced no output".into()),
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
        if matches!(event, CodexEvent::TurnCompleted { .. }) {
            completed = true;
        }
        for effect in translator.on_event(event) {
            if let Effect::Failed(message) = &effect {
                // First failure wins: later noise on a dying stream must not
                // overwrite the reason the turn actually failed.
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

    // §7: a child that exits without `turn.completed` failed, whatever its code
    // said — the stream is the source of truth for whether the turn finished.
    let error = failure.or_else(|| {
        if interrupted || completed {
            None
        } else {
            Some(match status {
                Ok(s) if !s.success() => format!("codex exited with status {s}"),
                _ => "codex ended without completing the turn".to_string(),
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
    use crate::session::adapter::codex::wire::parse_line;

    /// Deterministic ids so a translation can be asserted whole.
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

    // ---------- FR-13: the captured turn, end to end ----------

    /// The real `codex exec --json` capture replayed into the exact block
    /// sequence a user would see. This is the FR-13/FR-14 table as one
    /// assertion, over bytes Codex actually produced.
    #[test]
    fn the_captured_turn_translates_into_the_expected_blocks() {
        let effects = translate_all(include_str!("fixtures/exec_turn.jsonl"));
        assert_eq!(
            effects,
            vec![
                Effect::Anchor("01a00f3d-6d04-73d3-96e0-00edad63ce9d".into()),
                Effect::Assistant {
                    block_id: "b1".into(),
                    text: "I’ll check the current folder.".into()
                },
                // The command goes live on item.started…
                Effect::ToolStart {
                    block_id: "b2".into(),
                    tool: "Bash".into(),
                    summary: "ls".into()
                },
                // …and completes in the SAME block on item.completed.
                Effect::ToolDone {
                    block_id: "b2".into(),
                    tool: "Bash".into(),
                    meta: "8 lines".into()
                },
                Effect::Assistant {
                    block_id: "b3".into(),
                    text: "a.txt".into()
                },
                Effect::Usage(27022 + 19968 + 114),
            ]
        );
    }

    // ---------- FR-14: one block across two events ----------

    #[test]
    fn item_updated_does_not_open_a_second_card() {
        let effects = translate_all(
            r#"{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls","exit_code":null}}
{"type":"item.updated","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"partial","exit_code":null}}
{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"a\nb\n","exit_code":0}}"#,
        );
        assert_eq!(effects.len(), 2, "one start, one done: {effects:?}");
        assert!(matches!(&effects[0], Effect::ToolStart { block_id, .. } if block_id == "b1"));
        assert!(matches!(&effects[1], Effect::ToolDone { block_id, .. } if block_id == "b1"));
    }

    #[test]
    fn an_item_that_only_ever_completes_still_produces_a_card() {
        // file_change and web_search commonly arrive completed-only. Without
        // this, the tool call would never appear in the transcript at all.
        let effects = translate_all(
            r#"{"type":"item.completed","item":{"id":"i1","type":"file_change","changes":[{"path":"src/a.ts"}],"status":"completed"}}"#,
        );
        assert_eq!(
            effects,
            vec![
                Effect::ToolStart {
                    block_id: "b1".into(),
                    tool: "Edit".into(),
                    summary: "src/a.ts".into()
                },
                Effect::ToolDone {
                    block_id: "b1".into(),
                    tool: "Edit".into(),
                    meta: "1 file".into()
                },
            ]
        );
    }

    /// FR-14: the name is load-bearing, not cosmetic — `apply` keys the
    /// diff-view recompute off exactly `"Edit"`, so renaming this to something
    /// more descriptive would silently stop the DIFF tab updating.
    #[test]
    fn a_file_change_is_named_edit_so_the_diff_view_recomputes() {
        let effects = translate_all(
            r#"{"type":"item.completed","item":{"id":"i1","type":"file_change","changes":[{"path":"a"},{"path":"b"},{"path":"c"}]}}"#,
        );
        match &effects[1] {
            Effect::ToolDone { tool, meta, .. } => {
                assert_eq!(tool, "Edit");
                assert_eq!(meta, "3 files");
            }
            other => panic!("expected ToolDone, got {other:?}"),
        }
    }

    // ---------- FR-13: what produces nothing ----------

    #[test]
    fn reasoning_turn_started_and_unknown_items_produce_no_blocks() {
        let effects = translate_all(
            r#"{"type":"turn.started"}
{"type":"item.completed","item":{"id":"i1","type":"reasoning","text":"hmm"}}
{"type":"item.started","item":{"id":"i2","type":"collab_tool_call"}}
{"type":"item.completed","item":{"id":"i2","type":"collab_tool_call"}}
not json at all
{"type":"brand.new.event"}"#,
        );
        assert_eq!(effects, Vec::new());
    }

    #[test]
    fn an_empty_assistant_message_does_not_open_a_blank_block() {
        let effects = translate_all(
            r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"   "}}"#,
        );
        assert_eq!(effects, Vec::new());
    }

    // ---------- interruption ----------

    #[test]
    fn a_stream_that_dies_mid_command_closes_the_open_card() {
        // Otherwise the tool card spins forever in the transcript.
        let effects = translate_all(
            r#"{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"sleep 100","exit_code":null}}"#,
        );
        assert_eq!(
            effects,
            vec![
                Effect::ToolStart {
                    block_id: "b1".into(),
                    tool: "Bash".into(),
                    summary: "sleep 100".into()
                },
                Effect::ToolDone {
                    block_id: "b1".into(),
                    tool: String::new(),
                    meta: "interrupted".into()
                },
            ]
        );
    }

    // ---------- meta ----------

    #[test]
    fn a_failed_command_reports_its_exit_code_rather_than_a_line_count() {
        let effects = translate_all(
            r#"{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"npm test","aggregated_output":"a\nb\nc\n","exit_code":1}}"#,
        );
        match effects.last().unwrap() {
            Effect::ToolDone { meta, .. } => assert_eq!(meta, "exit 1"),
            other => panic!("expected ToolDone, got {other:?}"),
        }
    }

    #[test]
    fn a_silent_successful_command_says_done() {
        let effects = translate_all(
            r#"{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"true","aggregated_output":"","exit_code":0}}"#,
        );
        match effects.last().unwrap() {
            Effect::ToolDone { meta, .. } => assert_eq!(meta, "done"),
            other => panic!("expected ToolDone, got {other:?}"),
        }
    }

    // ---------- shell_summary ----------

    #[test]
    fn the_shell_wrapper_is_stripped_from_a_command_summary() {
        // Verbatim from the live capture — the whole reason this helper exists.
        assert_eq!(
            shell_summary(
                r#""C:\Users\gnzan\AppData\Local\Microsoft\WindowsApps\pwsh.exe" -Command ls"#
            ),
            "ls"
        );
        assert_eq!(shell_summary("bash -lc 'npm test'"), "npm test");
        assert_eq!(shell_summary(r#"/bin/sh -c "echo hi""#), "echo hi");
    }

    #[test]
    fn an_unrecognised_command_shape_is_left_alone() {
        // Degrade to verbose, never to mangled.
        assert_eq!(shell_summary("ls -la"), "ls -la");
        assert_eq!(shell_summary("git status"), "git status");
        assert_eq!(shell_summary("cargo"), "cargo");
        assert_eq!(shell_summary(""), "");
        // `-command-ish` is not the `-command` flag.
        assert_eq!(shell_summary("pwsh -commandish x"), "pwsh -commandish x");
    }

    // ---------- FR-15 ----------

    #[test]
    fn usage_is_reported_once_at_turn_completion() {
        let effects = translate_all(
            r#"{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10,"reasoning_output_tokens":4}}"#,
        );
        assert_eq!(effects, vec![Effect::Usage(160)]);
    }

    // ---------- failures ----------

    #[test]
    fn turn_failed_and_error_both_surface_as_a_failure_effect() {
        assert_eq!(
            translate_all(r#"{"type":"turn.failed","error":{"message":"rate limited"}}"#),
            vec![Effect::Failed("rate limited".into())]
        );
        assert_eq!(
            translate_all(r#"{"type":"error","message":"disconnected"}"#),
            vec![Effect::Failed("disconnected".into())]
        );
    }

    #[test]
    fn a_failure_mid_stream_does_not_stop_earlier_blocks_from_rendering() {
        let effects = translate_all(
            r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"starting"}}
{"type":"turn.failed","error":{"message":"boom"}}"#,
        );
        assert_eq!(
            effects,
            vec![
                Effect::Assistant {
                    block_id: "b1".into(),
                    text: "starting".into()
                },
                Effect::Failed("boom".into()),
            ]
        );
    }
}
