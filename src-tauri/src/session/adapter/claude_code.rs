//! Native Claude process adapter; all application effects use the injected sink.
#[cfg(test)]
mod boundary_tests;
pub(crate) mod context;
#[cfg(test)]
mod product_tests;
use super::{ControlAck, PendingCounts, PermissionDecision, TurnContext, TurnControl};
use crate::ipc::{AppError, ErrorCode};
use crate::session::application::{RuntimeEvent, RuntimeEventSink, RuntimePort};
use crate::session::stream::{NativeStream, StreamEnvironment};

// `super::*` only brings in this module's own siblings (AgentRuntime, TurnContext,
// TurnControl, …) — the shared session data model (Session, Engine,
// PendingQuestion/PendingPermission, emit, the stdio control-response
// builders, run_reader, refresh_models, the spawn/env helpers, …) needs its
// own glob import, same as every other child of `session`.
use crate::session::{
    account_env, allow_response, allow_tool_response, claim_pending, claude_invocation,
    deny_response, permission_args, route_line, write_control_line, LineRoute, PendingPermission,
    PendingQuestion, PERMISSION_DENY_MSG,
};

use serde_json::Value;
use std::collections::HashMap;
use std::io::Write as _;
use std::process::{ChildStdin, Stdio};
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

/// `/compact`: a synchronous side-run on behalf of the session — same argv,
/// account env and stdin delivery as a turn, stdin closed straight after the
/// prompt (a compaction can never park on an ask), under the same supervised
/// child ownership (`start_owned`: tree-killed and reaped, never orphaned).
/// Returns only the resulting context figure (session-engine FR-28).
#[allow(clippy::too_many_arguments)]
pub fn run_compact(
    cwd: &str,
    model_id: &str,
    resume: Option<&str>,
    effort: Option<&str>,
    permission_mode: &str,
    runtime: &str,
    worktree_distro: Option<&str>,
    account_config_dir: Option<&str>,
    system_prompt: Option<&str>,
    extra_args: &[String],
    response_mode: crate::session::ResponseMode,
    limit: u64,
) -> Option<u64> {
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
    let mut cmd = crate::process_util::spawn(program)
        .args(argv)
        .envs(account_env(account_config_dir, runtime, &[]))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if runtime != "wsl" {
        cmd = cmd.current_dir(cwd); // wsl turns get their cwd via `--cd` inside the distro
    }
    let child = Arc::new(cmd.start_owned().ok()?);
    let delivered = child.take_stdin().is_some_and(|mut w| {
        // Dropping the writer is the EOF that lets the CLI exit after its result.
        w.write_all(user_line("/compact").as_bytes())
            .and_then(|_| w.flush())
            .is_ok()
    });
    let used = match (delivered, child.take_frames()) {
        (true, Some(mut frames)) => compact_usage(
            std::iter::from_fn(|| frames.read_frame().ok().flatten()),
            limit,
        ),
        _ => None,
    };
    let _ = child.close();
    used
}

/// The context figure of a `/compact` run's stdout, by the turn's own rules
/// (`ContextTracker`): per-request parent usage wins, `result.usage` is only
/// a last resort, and subagent lines never count.
fn compact_usage(lines: impl IntoIterator<Item = String>, limit: u64) -> Option<u64> {
    let mut usage = context::ContextTracker::default();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if matches!(route_line(&v), LineRoute::Attributed(_)) {
            continue;
        }
        match v.get("type").and_then(Value::as_str) {
            Some("stream_event") => {
                if let Some(ev) = v.get("event") {
                    usage.observe_stream_event(ev);
                }
            }
            Some("result") => {
                if let Some(u) = v.get("usage") {
                    usage.observe_result(u);
                }
            }
            _ => {}
        }
    }
    usage.finish(limit)
}

// ---------- the concrete turn handle (FR-2) ----------

pub struct TurnHandle {
    child: Arc<crate::process_util::OwnedChild>,
    interrupted: Arc<AtomicBool>,
    /// session-questions FR-2: the turn's stdin writer. Lives for the whole turn;
    /// None once the turn ends (closing it is what lets the CLI exit). ALL writes
    /// go through this mutex — never while holding the session registry (a blocking
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
        self.kill();
    }

    /// Immediate tree kill: a stop never waits on a grace period, and the
    /// reader's EOF then settles the turn exactly once.
    fn kill(&self) {
        let _ = self.child.terminate();
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
        if decision == PermissionDecision::Cancel {
            return ControlAck::NotPending;
        }
        // FR-10: removal from the pending map IS the exactly-once claim.
        let claimed = claim_pending(&self.pending_permissions, id);
        let Some(q) = claimed else {
            return ControlAck::NotPending;
        };
        let payload = match decision {
            PermissionDecision::Allow => allow_tool_response(&q.request_id, &q.input),
            PermissionDecision::Deny => deny_response(&q.request_id, PERMISSION_DENY_MSG),
            PermissionDecision::Cancel => return ControlAck::NotPending,
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

impl RuntimePort for ClaudeCodeAdapter {
    fn preflight(&self, ctx: &TurnContext) -> Result<(), AppError> {
        if !ctx.execution.account_authenticated {
            return Err(AppError::new(
                ErrorCode::AccountNotAuthenticated,
                "this session's account is not signed in — use Re-login in the Accounts modal",
            ));
        }
        Ok(())
    }

    fn begin_turn(
        &self,
        ctx: TurnContext,
        sink: Arc<dyn RuntimeEventSink>,
    ) -> Result<Arc<dyn TurnControl>, AppError> {
        begin_native_turn(ctx, sink, |program, argv| (program, argv))
    }
}

/// The whole native turn start behind `ClaudeCodeAdapter::begin_turn`.
/// `launch` sees the resolved `(program, argv)` and returns what is actually
/// executed — identity in production; a test swaps only the executable.
pub(super) fn begin_native_turn(
    ctx: TurnContext,
    sink: Arc<dyn RuntimeEventSink>,
    launch: impl FnOnce(String, Vec<String>) -> (String, Vec<String>),
) -> Result<Arc<dyn TurnControl>, AppError> {
    let args = turn_args(
        &ctx.model_id,
        ctx.resume.as_deref(),
        ctx.effort.as_deref(),
        &ctx.permission_mode,
        ctx.system_prompt.as_deref(),
        &ctx.extra_args,
        ctx.response_mode,
    );
    let (program, argv) =
        claude_invocation(&ctx.runtime, &ctx.cwd, args, ctx.worktree_distro.as_deref());
    let (program, argv) = launch(program, argv);
    let mut command = crate::process_util::spawn(program)
        .args(argv)
        .envs(ctx.execution.environment.clone())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if ctx.runtime != "wsl" {
        command = command.current_dir(&ctx.cwd);
    }
    let child = Arc::new(command.start_owned().map_err(|error| {
        AppError::new(
            ErrorCode::SpawnFailed,
            format!("could not start claude: {error}"),
        )
    })?);
    let mut writer = child.take_stdin().ok_or_else(|| {
        AppError::new(ErrorCode::RuntimeUnavailable, "Claude input is unavailable")
    })?;
    writer
        .write_all(user_line(&ctx.text).as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|_| {
            AppError::new(
                ErrorCode::RuntimeUnavailable,
                "could not deliver prompt to Claude",
            )
        })?;
    let stdin = Arc::new(Mutex::new(Some(writer)));
    let mut frames = child.take_frames().ok_or_else(|| {
        AppError::new(
            ErrorCode::RuntimeUnavailable,
            "Claude output is unavailable",
        )
    })?;
    let pending_questions = Arc::new(Mutex::new(HashMap::new()));
    let pending_permissions = Arc::new(Mutex::new(HashMap::new()));
    let interrupted = Arc::new(AtomicBool::new(false));
    let handle = Arc::new(TurnHandle {
        child: child.clone(),
        interrupted: interrupted.clone(),
        stdin: stdin.clone(),
        pending_questions: pending_questions.clone(),
        pending_permissions: pending_permissions.clone(),
    });
    let env = NativeStream::new(ctx.clone(), sink);
    env.publish(RuntimeEvent::PromptDelivered(ctx.response_mode));
    if let Some(error) = env.failure() {
        return Err(error);
    }
    std::thread::spawn(move || {
        crate::session::stream::run_reader(
            &env,
            &ctx,
            || frames.read_frame(),
            child,
            interrupted,
            stdin,
            pending_questions,
            pending_permissions,
        )
    });
    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::*;

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

    /// claude-process-adapter FR-7: `/compact`'s context figure is decoded by
    /// the adapter with the turn's own rules — last parent request wins,
    /// subagent requests never count, `result.usage` only as a last resort.
    #[test]
    fn compact_usage_uses_the_last_parent_request_and_ignores_subagents() {
        let lines = [
            r#"{"type":"stream_event","parent_tool_use_id":"toolu_sub","event":{"type":"message_start","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":900000}}}}"#,
            r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":12000}}}}"#,
            r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_delta","usage":{"output_tokens":90}}}"#,
            "not json",
            r#"{"type":"result","usage":{"input_tokens":5,"cache_read_input_tokens":3400000,"output_tokens":100}}"#,
        ];
        assert_eq!(
            compact_usage(lines.map(String::from), 200_000),
            Some(12_100)
        );
        let only_result = [r#"{"type":"result","usage":{"input_tokens":7,"output_tokens":3}}"#];
        assert_eq!(
            compact_usage(only_result.map(String::from), 200_000),
            Some(10)
        );
        assert_eq!(compact_usage(std::iter::empty(), 200_000), None);
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
