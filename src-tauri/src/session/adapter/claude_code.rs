//! `ClaudeCodeAdapter` — the only real `SessionAdapter` today (FR-3). Wraps
//! the pre-existing `claude -p --output-format stream-json …` spawn, the
//! stdio control channel (`session::stdio`) and the NDJSON reader
//! (`session::stream::run_reader`) with NO behavioural change: same argv,
//! same env, same resume/`ResumeRetry` logic, same control-channel protocol,
//! same `allow_git` auto-approval, same post-result close policy.
//!
//! The concrete turn handle (`TurnHandle`) lives here, `pub(crate)` to this
//! module only — every other file reaches a live turn through the
//! `TurnControl` trait (FR-2/FR-8). `spawn_claude`/`turn_args`/`user_line`
//! moved here from `turn.rs` for the same reason: they are Claude-CLI-shaped,
//! not engine-shaped.

use super::*;
use crate::ipc::{AppError, ErrorCode};

// `super::*` only brings in this module's own siblings (AgentRuntime, TurnContext,
// TurnControl, …) — the shared session data model (Session, Engine,
// PendingQuestion/PendingPermission, emit, the stdio control-response
// builders, run_reader, refresh_models, the spawn/env helpers, …) needs its
// own glob import, same as every other child of `session`.
use crate::session::*;

use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write as _};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub struct ClaudeCodeAdapter;

// ---------- argv / spawn (moved from turn.rs, unchanged) ----------

/// The claude argv for a session turn. session-questions FR-1: `-p` with NO
/// positional prompt (the turn text rides stdin), plus the stdio control
/// channel (`--input-format stream-json --permission-prompt-tool stdio`).
/// Pure; unit-tested.
#[allow(clippy::too_many_arguments)]
pub fn turn_args(
    model_id: &str,
    resume: Option<&str>,
    effort: Option<&str>,
    permission_mode: &str,
    system_prompt: Option<&str>,
    extra_args: &[String],
    response_mode: crate::session::ResponseMode,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--permission-prompt-tool".into(),
        "stdio".into(),
        "--include-partial-messages".into(),
        "--verbose".into(),
        "--model".into(),
        model_id.into(),
    ];
    args.extend(permission_args(permission_mode)); // per-invocation; --resume does not carry it
    if let Some(e) = effort {
        args.extend(["--effort".into(), e.into()]);
    }
    // session-profiles FR-12/FR-13: REPLACE-mode prompt rides EVERY invocation,
    // including a --resume turn (--resume itself carries neither).
    if let Some(sp) = system_prompt {
        args.extend(["--system-prompt".into(), sp.into()]);
    }
    // response-mode FR-7: the directive rides EVERY invocation, --resume path
    // included, and is APPENDED AFTER a profile's replace-mode prompt — the
    // profile says who the model is, the mode says how it writes. 'default'
    // omits the flag entirely rather than appending an empty instruction.
    if let Some(directive) = response_mode.directive() {
        args.extend(["--append-system-prompt".into(), directive.into()]);
    }
    if let Some(r) = resume {
        args.extend(["--resume".into(), r.into()]);
    }
    // session-profiles FR-12: appended LAST, after every argument Francois builds.
    args.extend(extra_args.iter().cloned());
    args
}

/// The §5.5 NDJSON user line carrying a turn's text over stdin (FR-1).
pub fn user_line(text: &str) -> String {
    let mut line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    })
    .to_string();
    line.push('\n');
    line
}

#[allow(clippy::too_many_arguments)]
pub fn spawn_claude(
    cwd: &str,
    model_id: &str,
    resume: Option<&str>,
    text: &str,
    effort: Option<&str>,
    permission_mode: &str,
    runtime: &str,
    worktree_distro: Option<&str>,
    account_config_dir: Option<&str>,
    system_prompt: Option<&str>,
    extra_args: &[String],
    response_mode: crate::session::ResponseMode,
) -> std::io::Result<Child> {
    let args = turn_args(
        model_id,
        resume,
        effort,
        permission_mode,
        system_prompt,
        extra_args,
        response_mode,
    );
    let (program, argv) = claude_invocation(runtime, cwd, args, worktree_distro);
    // multi-account FR-21/FR-24: this turn runs under its session's account.
    // session-questions FR-1: stdin is piped — the turn text goes down it as one
    // NDJSON user line, and the stdio control channel (question answers /
    // permission denies) rides the same pipe for the rest of the turn. It is the
    // one spawn in the tree that overrides the facade's null stdin.
    let mut cmd = crate::process_util::spawn(program)
        .args(argv)
        .envs(account_env(account_config_dir, runtime, &[]))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if runtime != "wsl" {
        cmd = cmd.current_dir(cwd); // wsl turns get their cwd via `--cd` inside the distro
    }
    let mut child = cmd.start()?;
    let wrote = match child.stdin.as_mut() {
        Some(w) => w
            .write_all(user_line(text).as_bytes())
            .and_then(|_| w.flush()),
        None => Ok(()),
    };
    if let Err(e) = wrote {
        // The child died before reading its prompt — surface it as a spawn failure.
        let _ = child.kill();
        return Err(e);
    }
    Ok(child)
}

pub fn child_stdout_lines(mut child: Child) -> Option<Vec<String>> {
    let stdout = child.stdout.take()?;
    let reader = BufReader::new(stdout);
    let mut lines = Vec::new();
    for line in reader.lines() {
        match line {
            Ok(l) => lines.push(l),
            Err(_) => break,
        }
    }
    let _ = child.wait();
    Some(lines)
}

// ---------- the concrete turn handle (FR-2) ----------

pub struct TurnHandle {
    child: Arc<Mutex<Child>>,
    interrupted: Arc<AtomicBool>,
    /// session-questions FR-2: the turn's stdin writer. Lives for the whole turn;
    /// None once the turn ends (closing it is what lets the CLI exit). ALL writes
    /// go through this mutex — never while holding Engine.sessions (a blocking
    /// pipe write must not stall every command).
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// session-questions FR-6: blockId → parked AskUserQuestion. Removing an entry
    /// CLAIMS it — that atomic claim is what makes resolution exactly-once (FR-13).
    pending_questions: Arc<Mutex<HashMap<String, PendingQuestion>>>,
    /// permission-guardrails FR-2: blockId → parked tool call awaiting approval.
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
}

/// The peek half of the FR-7 rule-write gate — the exact counterpart of
/// `claim_pending`: it READS the parked ask's pattern and leaves the entry
/// alone. Free-standing so the "pending ⇒ Some, claimed ⇒ None" discipline is
/// unit-testable without spawning a `Child` to build a `TurnHandle` around.
fn peek_permission_pattern(
    pending: &Arc<Mutex<HashMap<String, PendingPermission>>>,
    id: &str,
) -> Option<String> {
    pending.lock().unwrap().get(id).map(|p| p.pattern.clone())
}

impl TurnControl for TurnHandle {
    fn interrupt(&self) {
        self.interrupted.store(true, Ordering::SeqCst);
    }

    fn kill(&self) {
        let _ = self.child.lock().unwrap().kill();
    }

    fn answer_question(&self, id: &str, answers: &Value) -> ControlAck {
        // FR-13: removal from the pending map IS the exactly-once claim.
        let claimed = claim_pending(&self.pending_questions, id);
        let Some(q) = claimed else {
            return ControlAck::NotPending;
        };
        let payload = allow_response(&q.request_id, &q.input, answers);
        if write_control_line(&self.stdin, &payload) {
            ControlAck::Applied
        } else {
            ControlAck::ChannelClosed
        }
    }

    fn decide_permission(&self, id: &str, decision: PermissionDecision) -> ControlAck {
        // FR-10: removal from the pending map IS the exactly-once claim.
        let claimed = claim_pending(&self.pending_permissions, id);
        let Some(q) = claimed else {
            return ControlAck::NotPending;
        };
        let payload = match decision {
            PermissionDecision::Allow => allow_tool_response(&q.request_id, &q.input),
            PermissionDecision::Deny => deny_response(&q.request_id, PERMISSION_DENY_MSG),
        };
        if write_control_line(&self.stdin, &payload) {
            ControlAck::Applied
        } else {
            ControlAck::ChannelClosed
        }
    }

    fn pending_permission_pattern(&self, id: &str) -> Option<String> {
        peek_permission_pattern(&self.pending_permissions, id)
    }

    fn pending_counts(&self) -> PendingCounts {
        PendingCounts {
            questions: self.pending_questions.lock().unwrap().len(),
            permissions: self.pending_permissions.lock().unwrap().len(),
        }
    }

    fn drain_pending(&self) -> (Vec<String>, Vec<String>) {
        let questions: Vec<String> = self
            .pending_questions
            .lock()
            .unwrap()
            .drain()
            .map(|(block_id, _)| block_id)
            .collect();
        let permissions: Vec<String> = self
            .pending_permissions
            .lock()
            .unwrap()
            .drain()
            .map(|(block_id, _)| block_id)
            .collect();
        (questions, permissions)
    }
}

// ---------- the adapter ----------

impl SessionAdapter for ClaudeCodeAdapter {
    fn agent_runtime(&self) -> AgentRuntime {
        AgentRuntime::ClaudeCode
    }

    /// FR-7: the `ACCOUNT_NOT_AUTHENTICATED` preflight that used to live
    /// inline in `begin_turn` (turn.rs:271-287) — same error code, same
    /// `mark_auth_failed` side effect, same message.
    fn preflight(&self, app: &tauri::AppHandle, ctx: &TurnContext) -> Result<(), AppError> {
        let account_config_dir = crate::account::config_dir_of(app, &ctx.account_id);
        if let Some(dir) = account_config_dir.as_deref() {
            if !crate::account::identity_file_exists(dir) {
                crate::account::mark_auth_failed(app, &ctx.account_id);
                return Err(AppError {
                    code: ErrorCode::AccountNotAuthenticated,
                    message:
                        "this session's account is not signed in — use Re-login in the Accounts modal"
                            .into(),
                    detail: None,
                });
            }
        }
        Ok(())
    }

    fn begin_turn(
        &self,
        app: &tauri::AppHandle,
        ctx: TurnContext,
    ) -> Result<Arc<dyn TurnControl>, AppError> {
        let account_config_dir = crate::account::config_dir_of(app, &ctx.account_id);
        let mut child = spawn_claude(
            &ctx.cwd,
            &ctx.model_id,
            ctx.resume.as_deref(),
            &ctx.text,
            ctx.effort.as_deref(),
            &ctx.permission_mode,
            &ctx.runtime,
            ctx.worktree_distro.as_deref(),
            account_config_dir.as_deref(),
            ctx.system_prompt.as_deref(),
            &ctx.extra_args,
            ctx.response_mode,
        )
        .map_err(|e| AppError {
            code: ErrorCode::SpawnFailed,
            message: format!("could not start claude: {e}"),
            detail: None,
        })?;

        // session-questions FR-2: the stdin writer joins the turn state for the
        // whole turn — the reader thread (denies) and session_answer_question
        // (answers) share it; it closes only when the turn ends.
        let stdin = Arc::new(Mutex::new(child.stdin.take()));
        // FR-5: the adapter owns the process and hands the reader its stdout —
        // `run_reader` never reaches into the `Child` for it. `None` is
        // unreachable in practice (spawn_claude pipes stdout and nothing else
        // takes it); it still ends the turn exactly as it did before.
        let stdout = child.stdout.take();
        let pending_questions: Arc<Mutex<HashMap<String, PendingQuestion>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let child = Arc::new(Mutex::new(child));
        let interrupted = Arc::new(AtomicBool::new(false));

        let handle: Arc<TurnHandle> = Arc::new(TurnHandle {
            child: child.clone(),
            interrupted: interrupted.clone(),
            stdin: stdin.clone(),
            pending_questions: pending_questions.clone(),
            pending_permissions: pending_permissions.clone(),
        });

        let resume_used = ctx.resume.is_some();
        let app2 = app.clone();
        let TurnContext {
            session_id,
            block_id,
            text,
            model_id,
            ..
        } = ctx;
        // block_id/text carried into the reader so a resume-fail can re-run this
        // turn fresh (session-engine FR-9).
        std::thread::spawn(move || match stdout {
            Some(out) => crate::session::run_reader(
                app2,
                session_id,
                BufReader::new(out),
                child,
                interrupted,
                stdin,
                pending_questions,
                pending_permissions,
                model_id,
                resume_used,
                block_id,
                text,
            ),
            None => crate::session::finish_turn(&app2, &session_id, false, None),
        });

        Ok(handle)
    }

    /// FR-10: today's `models.rs` path verbatim (live `/v1/models` fetch,
    /// static fallback). `account_id` is accepted for the trait's sake but
    /// unused — v1 `session_models` has no per-session/per-account context on
    /// the wire (`contract/session-engine.ts`'s `session_models` payload is
    /// empty) and always read the GLOBAL `~/.claude/.credentials.json`, a
    /// pre-existing gap this refactor does not change.
    fn models(&self, app: &tauri::AppHandle, _account_id: &str) -> Vec<ModelInfo> {
        // With the handle: a picker open that lands a live fetch also mirrors the
        // catalog and reconciles every session's window, so a run that booted
        // offline heals as soon as the network comes back.
        crate::session::refresh_models_for(Some(app))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_args_enable_stdio_control_channel_without_positional_prompt() {
        let args = turn_args(
            "sonnet",
            Some("thread-1"),
            Some("high"),
            "plan",
            None,
            &[],
            ResponseMode::Default,
        );
        assert_eq!(args[0], "-p");
        assert!(
            args[1].starts_with("--"),
            "no positional prompt after -p: {args:?}"
        );
        let has_pair = |a: &str, b: &str| args.windows(2).any(|w| w[0] == a && w[1] == b);
        assert!(has_pair("--output-format", "stream-json"));
        assert!(has_pair("--input-format", "stream-json"));
        assert!(has_pair("--permission-prompt-tool", "stdio"));
        assert!(args.iter().any(|a| a == "--include-partial-messages"));
        assert!(args.iter().any(|a| a == "--verbose"));
        assert!(has_pair("--model", "sonnet"));
        assert!(has_pair("--permission-mode", "plan"));
        assert!(has_pair("--effort", "high"));
        assert!(has_pair("--resume", "thread-1"));
    }

    #[test]
    fn turn_args_omit_system_prompt_and_extra_args_when_absent() {
        let args = turn_args(
            "sonnet",
            None,
            None,
            "default",
            None,
            &[],
            ResponseMode::Default,
        );
        assert!(!args.iter().any(|a| a == "--system-prompt"));
        assert_eq!(args.last().unwrap(), "sonnet"); // nothing appended past --model
    }

    #[test]
    fn turn_args_append_a_present_system_prompt() {
        let args = turn_args(
            "sonnet",
            None,
            None,
            "default",
            Some("be terse"),
            &[],
            ResponseMode::Default,
        );
        let has_pair = |a: &str, b: &str| args.windows(2).any(|w| w[0] == a && w[1] == b);
        assert!(has_pair("--system-prompt", "be terse"));
    }

    #[test]
    fn turn_args_append_extra_args_last_after_every_built_argument() {
        let extra = vec!["--add-dir".to_string(), "/tmp".to_string()];
        let args = turn_args(
            "sonnet",
            Some("thread-1"),
            Some("high"),
            "plan",
            Some("be terse"),
            &extra,
            ResponseMode::Default,
        );
        // FR-12: extra_args are LAST, after everything Francois builds — including resume.
        assert_eq!(&args[args.len() - 2..], &["--add-dir", "/tmp"]);
    }

    // ---------- response-mode FR-7 (claude-code) ----------

    #[test]
    fn turn_args_omit_the_append_system_prompt_on_the_default_response_mode() {
        // FR-7: 'default' is the ABSENCE of an instruction, not an empty one.
        let args = turn_args(
            "sonnet",
            None,
            None,
            "default",
            None,
            &[],
            ResponseMode::Default,
        );
        assert!(!args.iter().any(|a| a == "--append-system-prompt"));
    }

    #[test]
    fn turn_args_append_the_response_directive_after_a_profiles_system_prompt() {
        // §7: a session created from a profile with a replace-mode prompt
        // carries BOTH — `--system-prompt <profile>` then
        // `--append-system-prompt <directive>`, in that order.
        let args = turn_args(
            "sonnet",
            None,
            None,
            "default",
            Some("you are a reviewer"),
            &[],
            ResponseMode::Concise,
        );
        let at = |flag: &str| args.iter().position(|a| a == flag).unwrap();
        assert!(at("--system-prompt") < at("--append-system-prompt"));
        assert_eq!(
            args[at("--append-system-prompt") + 1],
            ResponseMode::Concise.directive().unwrap()
        );
    }

    #[test]
    fn turn_args_carry_the_response_directive_on_the_resume_path_too() {
        // FR-7: EVERY turn, including --resume — the flag rides the invocation,
        // and --resume carries none of it.
        for mode in [
            ResponseMode::Concise,
            ResponseMode::Explanatory,
            ResponseMode::Learning,
        ] {
            let args = turn_args("sonnet", Some("thread-1"), None, "default", None, &[], mode);
            let has_pair = |a: &str, b: &str| args.windows(2).any(|w| w[0] == a && w[1] == b);
            assert!(has_pair("--resume", "thread-1"));
            assert!(has_pair(
                "--append-system-prompt",
                mode.directive().unwrap()
            ));
        }
    }

    #[test]
    fn turn_args_carry_system_prompt_and_extra_args_on_the_resume_path() {
        // FR-13: both ride EVERY invocation, including --resume.
        let extra = vec!["--add-dir".to_string(), "/tmp".to_string()];
        let args = turn_args(
            "sonnet",
            Some("thread-1"),
            None,
            "default",
            Some("be terse"),
            &extra,
            ResponseMode::Default,
        );
        let has_pair = |a: &str, b: &str| args.windows(2).any(|w| w[0] == a && w[1] == b);
        assert!(has_pair("--system-prompt", "be terse"));
        assert!(has_pair("--resume", "thread-1"));
        assert!(args.iter().any(|a| a == "--add-dir"));
    }

    #[test]
    fn user_line_matches_wire_shape() {
        let line = user_line("fix the bug");
        assert!(line.ends_with('\n'));
        let v: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "type": "user", "message": { "role": "user",
                "content": [{ "type": "text", "text": "fix the bug" }] } })
        );
    }

    #[test]
    fn claude_code_adapter_reports_its_runtime() {
        assert_eq!(ClaudeCodeAdapter.agent_runtime(), AgentRuntime::ClaudeCode);
    }

    /// permission-guardrails FR-7: the ask pattern an `*Always` decision writes
    /// comes off the LIVE pending map — present while the ask is parked, gone
    /// the instant it is claimed — and peeking it claims nothing. That pairing
    /// is what makes "still pending" the authorization for a rule write.
    #[test]
    fn a_permission_pattern_is_peeked_from_the_pending_map_and_dies_with_the_claim() {
        let pending: Arc<Mutex<HashMap<String, PendingPermission>>> =
            Arc::new(Mutex::new(HashMap::new()));
        pending.lock().unwrap().insert(
            "b1".into(),
            PendingPermission {
                request_id: "req-1".into(),
                input: serde_json::json!({ "command": "npm test" }),
                pattern: "Bash(npm test:*)".into(),
            },
        );
        // A peek is not a claim: twice in a row, same answer.
        assert_eq!(
            peek_permission_pattern(&pending, "b1").as_deref(),
            Some("Bash(npm test:*)")
        );
        assert_eq!(
            peek_permission_pattern(&pending, "b1").as_deref(),
            Some("Bash(npm test:*)")
        );
        assert_eq!(peek_permission_pattern(&pending, "nope"), None);
        // The claim `decide_permission` makes is what ends it.
        claim_pending(&pending, "b1").expect("claims the entry");
        assert_eq!(peek_permission_pattern(&pending, "b1"), None);
    }
}
