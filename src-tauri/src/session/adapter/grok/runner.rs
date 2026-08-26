//! Driving one `grok -p --output-format streaming-json` turn: spawn, read,
//! translate, finish (multi-provider-grok FR-5..FR-9, FR-13..FR-18, FR-27).
//!
//! Same split `codex::runner` documents: a pure `Translator` state machine
//! (`GrokEvent` → `Effect`) — which lives in `translate.rs`, with its tests —
//! and this, the thin half that performs those effects against the
//! `AppHandle`.

use super::args::grok_invocation;
use super::translate::{Effect, ToolCapture, Translator};
use super::wire::{self, GrokEvent};
use super::{GrokTurnHandle, GROK_MISSING_HINT};
use crate::ipc::AppError;
use crate::session::adapter::TurnContext;
use crate::session::*;

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

// ---------- applying an effect ----------

fn apply(
    app: &AppHandle,
    session_id: &str,
    cwd: &str,
    effect: Effect,
    capture: Option<ToolCapture>,
) {
    match effect {
        Effect::TextDelta {
            block_id,
            delta,
            accumulated,
            offset,
        } => {
            app.state::<Engine>().with_session_mut(session_id, |s| {
                s.buf_assistant_streaming(&block_id, &delta, &accumulated);
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
            // command-inspect FR-1/FR-2/FR-9: written BEFORE the block
            // settles, so `hasDetail` is right the first (and only) time this
            // block is ever persisted (FR-10).
            let has_detail = match capture {
                Some(cap) => {
                    let runtime = app
                        .state::<Engine>()
                        .runtime_of(session_id)
                        .unwrap_or_else(|| "native".to_string());
                    let detail = grok_step_detail(&block_id, &cap, cwd, &runtime);
                    append_step_detail(app, session_id, &detail);
                    true
                }
                None => false,
            };
            // transcript-scale CRITICAL fix: use the clone `buf_tool_done`
            // returns (captured before its internal trim runs) instead of
            // re-`find`ing by id — a re-find can miss a block that settling
            // itself just evicted.
            let block = app
                .state::<Engine>()
                .with_session_mut(session_id, |s| {
                    s.buf_tool_done(&block_id, meta.clone(), has_detail)
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
                    has_detail: has_detail.then_some(true),
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

/// command-inspect FR-1/FR-9: assemble this runtime's own `StepDetail` from
/// its `ToolCapture` — pulled out of `apply`'s `ToolDone` arm as its own pure
/// function (mirroring openai's `openai_step_detail`) so the exact record
/// this runtime produces is unit-testable without an `AppHandle`. Grok's wire
/// states neither an exit code nor any raw output (FR-9), so both stay
/// `None`/empty here, and it never separates stdout/stderr (FR-6).
fn grok_step_detail(block_id: &str, cap: &ToolCapture, cwd: &str, runtime: &str) -> StepDetail {
    build_step_detail(
        block_id,
        &cap.tool,
        cwd,
        runtime,
        cap.started_at,
        cap.ended_at,
        cap.is_error,
        None, // Grok's wire states no exit code
        &cap.input,
        "", // …nor any raw output (FR-9)
        None,
    )
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
    // response-mode FR-9: grok has no append-system-prompt seam either, so the
    // directive is prefixed to a LOCAL COPY of the prompt — never to `ctx.text`,
    // which is what `turn.rs` buffers the transcript's user block from. FR-10:
    // emitted only when it can be needed (fresh thread, or a mode this thread
    // has not been told about).
    let prefix = crate::session::pending_prefix(app, &ctx.session_id, ctx.response_mode, !resume);
    let prompt = prefixed_prompt(prefix, &ctx.text);
    let (program, argv) = grok_invocation(
        &prompt,
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

    // FR-10: the prompt rode the argv of a child that started, so the thread now
    // carries this mode.
    crate::session::mark_sent(app, &ctx.session_id, ctx.response_mode);

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
            let capture = match &effect {
                Effect::ToolDone { block_id, .. } => translator.take_capture(block_id),
                _ => None,
            };
            apply(&app, &session_id, &cwd, effect, capture);
        }
    }

    for effect in translator.close_open() {
        apply(&app, &session_id, &cwd, effect, None);
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
    use serde_json::json;

    // ---------- grok_step_detail (command-inspect FR-1/FR-9) ----------

    #[test]
    fn a_settled_capture_becomes_a_field_exact_step_detail() {
        let cap = ToolCapture {
            tool: "Bash".to_string(),
            started_at: 100,
            ended_at: 200,
            input: json!({ "command": "npm test" }),
            is_error: true,
        };
        let d = grok_step_detail("b1", &cap, "/repo", "native");
        assert_eq!(d.block_id, "b1");
        assert_eq!(d.tool, "Bash");
        assert_eq!(d.cwd, "/repo");
        assert_eq!(d.runtime, "native");
        assert_eq!(d.started_at, 100);
        assert_eq!(d.ended_at, Some(200));
        assert!(d.is_error);
        assert_eq!(d.exit_code, None); // FR-9: Grok never states one
        match d.body {
            StepBody::Command { command, output } => {
                assert_eq!(command.command, "npm test");
                assert_eq!(output.text, ""); // FR-9: no raw output either
                assert_eq!(output.stderr_lines, None); // FR-6: never splits streams
            }
            other => panic!("expected a command body, got {other:?}"),
        }
    }

    #[test]
    fn a_non_bash_capture_becomes_a_generic_step_detail() {
        let cap = ToolCapture {
            tool: "Read".to_string(),
            started_at: 0,
            ended_at: 1,
            input: json!({ "file_path": "src/x.ts" }),
            is_error: false,
        };
        let d = grok_step_detail("b2", &cap, "/repo", "native");
        assert_eq!(d.tool, "Read");
        assert!(!d.is_error);
        match d.body {
            StepBody::Generic { input_json, .. } => {
                assert!(input_json.contains("src/x.ts"));
            }
            other => panic!("expected a generic body, got {other:?}"),
        }
    }
}
