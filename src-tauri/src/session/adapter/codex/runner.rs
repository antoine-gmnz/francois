//! Driving one `codex exec` turn: spawn, read, translate, finish
//! (multi-provider-codex FR-5..FR-8, FR-13..FR-15).
//!
//! The translation is a **pure state machine** (`Translator`) that turns a
//! `CodexEvent` into a list of `Effect`s — it lives in `translate.rs`, with
//! its tests — and this, the thin apply half that performs those effects
//! against the `AppHandle`. That split is deliberate and follows this crate's
//! documented convention: there is no `AppHandle` test harness, so anything
//! worth testing must not need one.

use super::args::codex_invocation;
use super::translate::{Effect, ToolCapture, Translator};
use super::wire::{self, CodexEvent};
use super::{CodexTurnHandle, CODEX_MISSING_HINT};
use crate::ipc::AppError;
use crate::ipc::ErrorCode;
use crate::session::adapter::TurnContext;
use crate::session::*;

use std::io::{BufRead, BufReader, Write as _};
use std::process::Stdio;
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
            // command-inspect FR-1/FR-2/FR-9: write the sidecar record BEFORE
            // the block settles, so `hasDetail` is right on the first (and
            // only) line ever persisted for it (FR-10).
            let has_detail = match capture {
                Some(cap) => {
                    let runtime = app
                        .state::<Engine>()
                        .runtime_of(session_id)
                        .unwrap_or_else(|| "native".to_string());
                    let detail = codex_step_detail(&block_id, &cap, cwd, &runtime);
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
                    has_detail: has_detail.then_some(true),
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

/// command-inspect FR-1/FR-9: assemble this runtime's own `StepDetail` from
/// its `ToolCapture` — pulled out of `apply`'s `ToolDone` arm as its own pure
/// function (mirroring openai's `openai_step_detail`) so the exact record
/// this runtime produces is unit-testable without an `AppHandle`. Codex
/// states no split stderr, so `stderr_lines` is always `None` (FR-6).
fn codex_step_detail(block_id: &str, cap: &ToolCapture, cwd: &str, runtime: &str) -> StepDetail {
    build_step_detail(
        block_id,
        &cap.tool,
        cwd,
        runtime,
        cap.started_at,
        cap.ended_at,
        cap.is_error,
        cap.exit_code,
        &cap.input,
        &cap.output,
        None, // FR-6: Codex does not separate stdout/stderr
    )
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
    // response-mode FR-10: decided BEFORE the spawn, recorded only after the
    // prompt reaches the child (below). `resume.is_none()` is "fresh thread" —
    // which is also how a resume retry arrives here, so the directive is
    // re-sent on the new thread it starts.
    let prefix = crate::session::pending_prefix(
        app,
        &ctx.session_id,
        ctx.response_mode,
        ctx.resume.is_none(),
    )
    .map(str::to_string);
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
    //
    // response-mode FR-9: `codex exec` has no append-system-prompt seam, so the
    // directive is prefixed to a LOCAL COPY of the prompt bytes — never to
    // `ctx.text`, which is the string `turn.rs` buffers the transcript's user
    // block from. FR-10: emitted only when it can be needed (fresh thread, or a
    // mode this thread has not been told about).
    let prompt = prefixed_prompt(prefix.as_deref(), &ctx.text);
    let wrote = match child.stdin.take() {
        Some(mut w) => w.write_all(prompt.as_bytes()).and_then(|_| w.flush()),
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

    // FR-10: the prompt reached the child, so the thread now carries this mode.
    crate::session::mark_sent(app, &ctx.session_id, ctx.response_mode);

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
            // command-inspect: claimed BEFORE `apply` so the sidecar record
            // (if any) exists before the block settles/emits (FR-10).
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
    use serde_json::json;

    // ---------- codex_step_detail (command-inspect FR-1/FR-9) ----------

    #[test]
    fn a_settled_capture_becomes_a_field_exact_step_detail() {
        let cap = ToolCapture {
            tool: "Bash".to_string(),
            started_at: 100,
            ended_at: 200,
            input: json!({ "command": "npm test" }),
            output: "14 failed\n".to_string(),
            exit_code: Some(1),
            is_error: true,
        };
        let d = codex_step_detail("b1", &cap, "/repo", "native");
        assert_eq!(d.block_id, "b1");
        assert_eq!(d.tool, "Bash");
        assert_eq!(d.cwd, "/repo");
        assert_eq!(d.runtime, "native");
        assert_eq!(d.started_at, 100);
        assert_eq!(d.ended_at, Some(200));
        assert!(d.is_error);
        assert_eq!(d.exit_code, Some(1));
        match d.body {
            StepBody::Command { command, output } => {
                assert_eq!(command.command, "npm test");
                assert_eq!(output.text, "14 failed\n");
                assert_eq!(output.stderr_lines, None); // FR-6: Codex never splits streams
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
            output: String::new(),
            exit_code: None,
            is_error: false,
        };
        let d = codex_step_detail("b2", &cap, "/repo", "native");
        assert_eq!(d.tool, "Read");
        assert!(!d.is_error);
        assert_eq!(d.exit_code, None);
        match d.body {
            StepBody::Generic { input_json, .. } => {
                assert!(input_json.contains("src/x.ts"));
            }
            other => panic!("expected a generic body, got {other:?}"),
        }
    }
}
