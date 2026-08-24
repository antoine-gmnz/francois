//! The Francois agent loop's orchestration (specs/multi-provider-openai.md
//! §3/§4/§6/§7/§9): `OpenAiAdapter`/`FrancoisTurnHandle` (the `SessionAdapter`/
//! `TurnControl` implementations, seam FR-1..FR-10) and the round-trip loop
//! that wires the sibling modules together — `gate` (FR-9..FR-13),
//! `tools` (FR-14/FR-15), `wire` (FR-3..FR-7), `thread` (FR-16/FR-17),
//! `skills` (FR-23..FR-27) and `blocks` (the loop's own pure decision +
//! block-emission helpers).
//!
//! **The permission park.** The Claude path answers a gated call over a pipe;
//! this runtime has no pipe, so the loop thread blocks on a `Condvar` per
//! parked ask until `TurnControl::decide_permission` claims and decides it
//! (mirrors `session/stdio.rs`'s park half exactly — build the ask, buffer +
//! persist the pending card, emit `permission.asked`, refresh the parked
//! status) or `interrupt`/`kill` wakes every currently-parked wait so the loop
//! can unwind (FR-8). Removal from `pending` is the SAME exactly-once claim
//! discipline the Claude path's pending maps use (`stdio::claim_pending`,
//! reused here).
//!
//! **No async runtime.** `ureq` (blocking) is this crate's only HTTP client;
//! the loop runs on a spawned `std::thread`, the same shape
//! `ClaudeCodeAdapter::begin_turn` already uses for its NDJSON reader.

use super::*;
use crate::session::*;

use crate::ipc::AppError;
use crate::permissions::PermissionRule;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// FR-19: the exact first-turn notice text, once per session, before the
/// first assistant delta.
const FIRST_TURN_NOTICE: &str =
    "Francois runs its own agent loop on this provider — tool use and formatting differ from Claude Code.";

pub(crate) struct OpenAiAdapter;

impl SessionAdapter for OpenAiAdapter {
    fn agent_runtime(&self) -> AgentRuntime {
        AgentRuntime::Francois
    }

    /// FR-2: unknown account, wrong kind, or no endpoint payload are ALL
    /// exactly what `endpoint_of` returns `None` for — one check covers the
    /// whole preflight, no I/O. A missing key is deliberately not checked
    /// here (loopback servers need none); it surfaces as the endpoint's own
    /// 401 at request time.
    fn preflight(&self, app: &AppHandle, ctx: &TurnContext) -> Result<(), AppError> {
        if crate::account::endpoint_of(app, &ctx.account_id).is_none() {
            return Err(not_an_endpoint_error());
        }
        Ok(())
    }

    fn begin_turn(
        &self,
        app: &AppHandle,
        ctx: TurnContext,
    ) -> Result<Arc<dyn TurnControl>, AppError> {
        let Some((endpoint, config_dir)) = crate::account::endpoint_of(app, &ctx.account_id) else {
            return Err(not_an_endpoint_error());
        };
        let handle = Arc::new(FrancoisTurnHandle {
            interrupted: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        });
        let thread_handle = handle.clone();
        let app2 = app.clone();
        std::thread::spawn(move || {
            run_loop(app2, thread_handle, ctx, endpoint.base_url, config_dir)
        });
        Ok(handle)
    }

    /// FR-18: an account's `endpoint.modelIds` override replaces the fetch
    /// entirely; otherwise `GET <baseUrl>/models` (`account::probe`, FR-8/9/10
    /// of multi-provider-endpoint), a 401 marks the account auth-failed, and a
    /// failed fetch with no override returns an empty list — never the
    /// Anthropic catalog.
    fn models(&self, app: &AppHandle, account_id: &str) -> Vec<ModelInfo> {
        let Some((endpoint, config_dir)) = crate::account::endpoint_of(app, account_id) else {
            return Vec::new();
        };
        if let Some(ids) = &endpoint.model_ids {
            return resolve_models(Some(ids), Vec::new());
        }
        let key = crate::account::read_key(&config_dir);
        let fetched = match crate::account::probe(&endpoint.base_url, key.as_deref()) {
            Ok(probe) => probe.models,
            Err((code, _msg)) => {
                if code == "ACCOUNT_ENDPOINT_UNAUTHORIZED" {
                    crate::account::mark_auth_failed(app, account_id);
                }
                Vec::new()
            }
        };
        resolve_models(None, fetched)
    }
}

fn not_an_endpoint_error() -> AppError {
    AppError {
        code: "INVALID_INPUT".into(),
        message: "this session's account is not an OpenAI-compatible endpoint".into(),
        detail: None,
    }
}

/// FR-18's pure half: an override replaces the fetch outright; otherwise the
/// fetched catalog (already empty on a failed probe) is filled with
/// `contextTokens` from `OPENAI_CONTEXT_FALLBACK`.
fn resolve_models(override_ids: Option<&[String]>, fetched: Vec<ModelInfo>) -> Vec<ModelInfo> {
    match override_ids {
        Some(ids) => ids.iter().map(|id| model_with_context(id)).collect(),
        None => fetched
            .into_iter()
            .map(|m| {
                let context_tokens = Some(wire::context_tokens_for(&m.id));
                ModelInfo {
                    context_tokens,
                    ..m
                }
            })
            .collect(),
    }
}

fn model_with_context(id: &str) -> ModelInfo {
    ModelInfo {
        context_tokens: Some(wire::context_tokens_for(id)),
        ..model(id, id)
    }
}

// ---------- the parked ask ----------

/// One tool call parked on a permission card, waiting for
/// `TurnControl::decide_permission` (or `interrupt`) to resolve it. `pattern`
/// is the FR-11 peek `pending_permission_pattern` reads; `state`/`cv` are the
/// park itself — this runtime's answer to "no pipe to answer over".
struct ParkedAsk {
    pattern: String,
    state: Mutex<ParkState>,
    cv: Condvar,
}

#[derive(Clone, Copy)]
enum ParkState {
    Pending,
    Decided(PermissionDecision),
}

/// FR-2/FR-8: the `TurnControl` this runtime's turns hand back. No `Child`, no
/// stdin — `interrupted` gates the round-trip loop and every wait,
/// `pending` is the (single) parked-ask map, keyed by block id.
struct FrancoisTurnHandle {
    interrupted: Arc<AtomicBool>,
    pending: Arc<Mutex<HashMap<String, Arc<ParkedAsk>>>>,
}

impl TurnControl for FrancoisTurnHandle {
    fn interrupt(&self) {
        self.interrupted.store(true, Ordering::SeqCst);
        // Wake every currently-parked wait so it can notice the flag and
        // unwind (FR-8) — a wait that started AFTER this runs still observes
        // the flag on its own first check, so no wakeup is required for it.
        for entry in self.pending.lock().unwrap().values() {
            entry.cv.notify_all();
        }
    }

    fn kill(&self) {
        // FR-2: there is no child process to kill — same signal as interrupt.
        self.interrupt();
    }

    /// This runtime has no AskUserQuestion channel — no id is ever pending.
    fn answer_question(&self, _id: &str, _answers: &Value) -> ControlAck {
        ControlAck::NotPending
    }

    fn decide_permission(&self, id: &str, decision: PermissionDecision) -> ControlAck {
        // Removal IS the exactly-once claim (same discipline as the Claude
        // path's pending maps) — reused from stdio.rs rather than
        // reimplemented.
        let Some(entry) = claim_pending(&self.pending, id) else {
            return ControlAck::NotPending;
        };
        *entry.state.lock().unwrap() = ParkState::Decided(decision);
        entry.cv.notify_all();
        ControlAck::Applied
    }

    fn pending_permission_pattern(&self, id: &str) -> Option<String> {
        self.pending
            .lock()
            .unwrap()
            .get(id)
            .map(|e| e.pattern.clone())
    }

    fn pending_counts(&self) -> PendingCounts {
        PendingCounts {
            questions: 0,
            permissions: self.pending.lock().unwrap().len(),
        }
    }

    fn drain_pending(&self) -> (Vec<String>, Vec<String>) {
        let ids: Vec<String> = {
            let mut m = self.pending.lock().unwrap();
            m.drain().map(|(k, _)| k).collect()
        };
        (Vec::new(), ids)
    }
}

impl FrancoisTurnHandle {
    /// FR-9/FR-10/FR-12: evaluate the gate; `Ask` parks. Returns the tool
    /// result string, or `None` when the turn was interrupted while parked —
    /// the caller then abandons this call (FR-8: its `tool_calls` entry stays
    /// unanswered and `drop_unanswered_tool_calls` removes it before save).
    fn resolve_and_run(
        &self,
        app: &AppHandle,
        session_id: &str,
        cwd: &str,
        permission_mode: &str,
        tool: FrancoisTool,
        input: &Value,
    ) -> Option<String> {
        let rules = current_rules(app, session_id);
        match gate::evaluate(tool, input, cwd, permission_mode, &rules) {
            gate::GateDecision::Allow => Some(self.execute(tool, input, cwd)),
            gate::GateDecision::Deny(msg) => Some(msg),
            gate::GateDecision::Ask => match self.park(app, session_id, cwd, tool, input) {
                Some(PermissionDecision::Allow) => Some(self.execute(tool, input, cwd)),
                Some(PermissionDecision::Deny) => Some(gate::DENY_MESSAGE.to_string()),
                None => None,
            },
        }
    }

    fn execute(&self, tool: FrancoisTool, input: &Value, cwd: &str) -> String {
        let resolved = resolved_path_for(tool, input, cwd);
        super::tools::execute(tool, resolved.as_deref(), Path::new(cwd), input)
    }

    /// The park itself: mirrors `session/stdio.rs::handle_control_request`'s
    /// permission branch (build the ask, park the pending entry, buffer +
    /// persist the pending card, emit `permission.asked`, refresh the parked
    /// status), then blocks on the ask's own `Condvar` until it is decided
    /// (claimed by `decide_permission`) or `interrupted` is observed.
    fn park(
        &self,
        app: &AppHandle,
        session_id: &str,
        cwd: &str,
        tool: FrancoisTool,
        input: &Value,
    ) -> Option<PermissionDecision> {
        let ask = crate::permissions::build_ask(tool.as_str(), input, cwd);
        let block_id = uuid();
        let entry = Arc::new(ParkedAsk {
            pattern: ask.pattern.clone(),
            state: Mutex::new(ParkState::Pending),
            cv: Condvar::new(),
        });
        self.pending
            .lock()
            .unwrap()
            .insert(block_id.clone(), entry.clone());

        let ask_value = serde_json::to_value(&ask).unwrap_or_else(|_| json!({}));
        let block = app
            .state::<Engine>()
            .with_session_mut(session_id, |s| {
                s.buf_permission(&block_id, ask_value);
                s.block_buffer.last().cloned()
            })
            .flatten();
        if let Some(b) = &block {
            append_transcript(app, session_id, b);
        }
        emit(
            app,
            SessionEvent::PermissionAsked {
                session_id: session_id.to_string(),
                block_id: block_id.clone(),
                ask,
            },
        );
        refresh_parked_status(app, session_id);

        let mut guard = entry.state.lock().unwrap();
        loop {
            if let ParkState::Decided(d) = &*guard {
                return Some(*d);
            }
            if self.interrupted.load(Ordering::SeqCst) {
                return None;
            }
            // Bounded poll as a backstop against the classic
            // notify-before-wait race (interrupt fires between insert and
            // the first lock of `guard`) — `interrupted` is re-checked every
            // tick regardless of whether a notify was ever delivered.
            let (g, _timeout) = entry
                .cv
                .wait_timeout(guard, Duration::from_millis(100))
                .unwrap();
            guard = g;
        }
    }

    /// FR-9..FR-13/§7: run one accumulated tool call end to end — buffer the
    /// tool block immediately (mirrors Claude's own block-before-gate
    /// ordering), gate it, execute or park, then finalize the block. `None`
    /// only when interrupted while parked.
    fn process_tool_call(
        &self,
        app: &AppHandle,
        session_id: &str,
        cwd: &str,
        permission_mode: &str,
        call: &wire::ToolCall,
    ) -> Option<String> {
        let block_id = uuid();
        if let Some(err) = super::blocks::tool_call_error(call) {
            super::blocks::emit_tool_block(app, session_id, &block_id, &call.name, "");
            super::blocks::finish_tool_block(app, session_id, &block_id, cwd, &call.name, "error");
            return Some(err);
        }
        // tool_call_error already proved both of these succeed.
        let tool = FrancoisTool::from_str(&call.name).expect("checked by tool_call_error");
        let input = call
            .arguments
            .as_ref()
            .expect("checked by tool_call_error")
            .clone();

        let summary = tool_summary(tool.as_str(), &input, cwd);
        super::blocks::emit_tool_block(app, session_id, &block_id, tool.as_str(), &summary);
        match self.resolve_and_run(app, session_id, cwd, permission_mode, tool, &input) {
            Some(result) => {
                let meta = tool_meta(tool.as_str(), &input, &result);
                super::blocks::finish_tool_block(
                    app,
                    session_id,
                    &block_id,
                    cwd,
                    tool.as_str(),
                    &meta,
                );
                Some(result)
            }
            None => {
                super::blocks::finish_tool_block(
                    app,
                    session_id,
                    &block_id,
                    cwd,
                    tool.as_str(),
                    "cancelled",
                );
                None
            }
        }
    }
}

// ---------- pure decision helpers (unit-tested below) ----------
//
// The round-trip cap / context refusal / tool-call-error / thread-shape /
// request-message helpers live in `blocks.rs` alongside the transcript
// block-emission helpers they pair with in the loop below.

/// The path-shaped argument of a call, using the same key names `gate.rs`'s
/// own (private, unreachable from here) `path_arg` reads — both built on the
/// shared `permissions::path_key`. `Grep`/`Glob` default an omitted/empty
/// `path` to `cwd` itself (mirrors `gate::path_arg` exactly — `wire.rs`
/// declares `path` optional on those two, "Defaults to the session's working
/// directory."), so `resolved_path_for` below never comes back `None` for
/// them and `tools::execute` never falls through to its internal-error
/// string for a call the gate already approved.
fn path_arg_of<'a>(tool: FrancoisTool, input: &'a Value, cwd: &'a str) -> Option<&'a str> {
    let keys = crate::permissions::path_key(tool.as_str())?;
    let found = keys.iter().find_map(|k| {
        input
            .get(*k)
            .and_then(|v| v.as_str())
            .filter(|p| !p.is_empty())
    });
    found.or_else(|| matches!(tool, FrancoisTool::Grep | FrancoisTool::Glob).then_some(cwd))
}

/// FR-13: resolve a path tool's argument against `cwd`, already validated by
/// `gate::evaluate`'s own containment check — `None` for `Bash` (FR-13's one
/// exception) and for anything that fails to resolve (defensive; `tools::execute`
/// treats a missing resolved path as its own internal-error string, never a panic).
fn resolved_path_for(tool: FrancoisTool, input: &Value, cwd: &str) -> Option<PathBuf> {
    if tool == FrancoisTool::Bash {
        return None;
    }
    let raw = path_arg_of(tool, input, cwd)?;
    gate::resolve_in_cwd(Path::new(cwd), raw).ok()
}

/// FR-9: the rules `permission-guardrails` already resolves for this session,
/// reused as-is — no endpoint special case (an endpoint account's config dir
/// carries no mirrored `~/.claude`, so its global tier starts empty).
fn current_rules(app: &AppHandle, session_id: &str) -> Vec<PermissionRule> {
    let engine = app.state::<Engine>();
    match crate::permissions::tiers_for(&engine, session_id) {
        Some((local, global)) => crate::permissions::list_rules(&local, global.as_deref()),
        None => Vec::new(),
    }
}

// ---------- the round-trip loop ----------
//
// Its transcript block-emission helpers (`emit_tool_block`,
// `finish_tool_block`, `buf_assistant_delta`, `finalize_open_text`) live in
// `blocks.rs`, called below as `super::blocks::…`.

enum LoopOutcome {
    Success,
    Interrupted,
    CapHit,
    ContextExceeded,
    StreamCut,
    Error(&'static str, String),
}

/// FR-3..FR-8/FR-16/FR-17/FR-19/FR-23/FR-25: the whole turn, on its own
/// thread. Loads the persisted thread, injects the fresh (never-persisted)
/// skill block, emits the first-turn notice, then drives the Chat Completions
/// round-trip loop until the assistant stops, the loop is interrupted, or one
/// of FR-6/FR-7/§7's failure cases ends it.
fn run_loop(
    app: AppHandle,
    handle: Arc<FrancoisTurnHandle>,
    ctx: TurnContext,
    base_url: String,
    config_dir: String,
) {
    let TurnContext {
        session_id,
        text,
        cwd,
        model_id,
        permission_mode,
        account_id,
        response_mode,
        ..
    } = ctx;

    // FR-16/FR-17: resume anchor. FR-19: "first turn" = nothing persisted yet.
    let loaded = thread::load_thread(&app, &session_id);
    let is_first_turn = loaded.is_empty();
    let mut messages = loaded;
    messages.push(thread::ThreadMessage {
        role: "user".into(),
        content: Some(text),
        tool_calls: None,
        tool_call_id: None,
    });

    // FR-23/FR-25: rebuilt fresh every turn, never persisted into `messages`.
    let skill_block = super::skills::build_skill_block(&app, &cwd);

    if is_first_turn {
        finalize_command_block(
            &app,
            &session_id,
            &uuid(),
            "notice",
            &CommandCard::Notice {
                text: FIRST_TURN_NOTICE.into(),
            },
        );
    }

    let ctx_limit = wire::context_tokens_for(&model_id);
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .build();

    let mut last_prompt_tokens: Option<u64> = None;
    let mut round: u32 = 0;
    let outcome = loop {
        round += 1;
        if super::blocks::round_trip_cap_hit(round) {
            break LoopOutcome::CapHit;
        }
        if handle.interrupted.load(Ordering::SeqCst) {
            break LoopOutcome::Interrupted;
        }
        if super::blocks::context_exceeded(last_prompt_tokens, ctx_limit) {
            break LoopOutcome::ContextExceeded;
        }

        let skill_text = if skill_block.is_available() {
            skill_block.text.as_str()
        } else {
            ""
        };
        let request_messages =
            super::blocks::build_request_messages(skill_text, response_mode, &messages);
        let body = wire::request_body(&model_id, &request_messages);
        // FR-3: read per request, never held in session state.
        let key = crate::account::read_key(&config_dir);
        let mut req = agent.post(&format!("{base_url}/chat/completions"));
        if let Some(k) = &key {
            req = req.set("Authorization", &format!("Bearer {k}"));
        }
        let response = match req.send_json(body) {
            Ok(r) => r,
            Err(e) => {
                let (code, msg) = wire::map_http_error(e);
                if code == "ACCOUNT_NOT_AUTHENTICATED" {
                    crate::account::mark_auth_failed(&app, &account_id);
                }
                break LoopOutcome::Error(code, msg);
            }
        };

        let reader = std::io::BufReader::new(response.into_reader());
        let mut assistant_text = String::new();
        let mut text_block_id: Option<String> = None;
        let mut tool_calls: Vec<wire::ToolCall> = Vec::new();
        let mut got_terminal = false;
        let mut round_usage: Option<u64> = None;

        let io_result = wire::decode_sse(reader, |ev| match ev {
            wire::StreamEvent::TextDelta { text, offset } => {
                if text_block_id.is_none() {
                    text_block_id = Some(uuid());
                }
                let block_id = text_block_id.clone().unwrap();
                assistant_text.push_str(&text);
                super::blocks::buf_assistant_delta(
                    &app,
                    &session_id,
                    &block_id,
                    &text,
                    &assistant_text,
                );
                emit(
                    &app,
                    SessionEvent::AssistantDelta {
                        session_id: session_id.clone(),
                        block_id,
                        text,
                        offset,
                    },
                );
            }
            wire::StreamEvent::Done { text } => {
                assistant_text = text;
                got_terminal = true;
            }
            wire::StreamEvent::ToolCalls(calls) => {
                tool_calls = calls;
                got_terminal = true;
            }
            wire::StreamEvent::Usage { prompt_tokens } => {
                round_usage = Some(prompt_tokens);
            }
            wire::StreamEvent::StreamDone => {}
        });

        // §7: a stream cut mid-block — the partial text still closes, the
        // turn ends PROVIDER_REQUEST_FAILED, and (below) the thread file is
        // never written for this turn.
        if io_result.is_err() || !got_terminal {
            if let Some(block_id) = &text_block_id {
                finalize_text_block(&app, &session_id, block_id, assistant_text.clone());
            }
            break LoopOutcome::StreamCut;
        }

        if let Some(prompt_tokens) = round_usage {
            let used = prompt_tokens.min(ctx_limit);
            update_used(&app, &session_id, used);
            emit(
                &app,
                SessionEvent::ContextUsage {
                    session_id: session_id.clone(),
                    used_tokens: used,
                    limit_tokens: ctx_limit,
                },
            );
            last_prompt_tokens = Some(prompt_tokens);
        }

        if tool_calls.is_empty() {
            // finish_reason: "stop" — the turn is complete.
            super::blocks::finalize_open_text(&app, &session_id, &text_block_id, &assistant_text);
            messages.push(thread::ThreadMessage {
                role: "assistant".into(),
                content: Some(assistant_text),
                tool_calls: None,
                tool_call_id: None,
            });
            break LoopOutcome::Success;
        }

        // FR-5: text ahead of a tool call in the same response still gets
        // its own finished block before the tool_calls round begins.
        super::blocks::finalize_open_text(&app, &session_id, &text_block_id, &assistant_text);
        messages.push(thread::ThreadMessage {
            role: "assistant".into(),
            content: if assistant_text.is_empty() {
                None
            } else {
                Some(assistant_text)
            },
            tool_calls: Some(
                tool_calls
                    .iter()
                    .map(super::blocks::thread_tool_call)
                    .collect(),
            ),
            tool_call_id: None,
        });

        let mut interrupted_mid_round = false;
        for call in &tool_calls {
            match handle.process_tool_call(&app, &session_id, &cwd, &permission_mode, call) {
                Some(result) => messages.push(thread::ThreadMessage {
                    role: "tool".into(),
                    content: Some(result),
                    tool_calls: None,
                    tool_call_id: Some(call.id.clone()),
                }),
                None => {
                    interrupted_mid_round = true;
                    break;
                }
            }
        }
        if interrupted_mid_round {
            break LoopOutcome::Interrupted;
        }
        // else: next round-trip.
    };

    // FR-8/§9: an interrupted/failed turn may leave a dangling tool_calls
    // entry — dropped before saving, never after a stream cut (§7).
    if !matches!(outcome, LoopOutcome::StreamCut) {
        let cleaned = thread::drop_unanswered_tool_calls(&messages);
        thread::save_thread(&app, &session_id, &cleaned);
    }

    match outcome {
        LoopOutcome::Success | LoopOutcome::Interrupted => {
            finish_turn(&app, &session_id, false, None);
        }
        LoopOutcome::CapHit => {
            let engine = app.state::<Engine>();
            persist(&app, &engine);
            fail_session(
                &app,
                &session_id,
                "PROVIDER_REQUEST_FAILED",
                &format!(
                    "this turn hit its {}-round-trip cap without finishing.",
                    wire::MAX_ROUND_TRIPS
                ),
            );
        }
        LoopOutcome::ContextExceeded => {
            let engine = app.state::<Engine>();
            persist(&app, &engine);
            fail_session(
                &app,
                &session_id,
                "PROVIDER_CONTEXT_EXCEEDED",
                "this conversation is over the model's context window — start a new session to continue.",
            );
        }
        LoopOutcome::StreamCut => {
            let engine = app.state::<Engine>();
            persist(&app, &engine);
            fail_session(
                &app,
                &session_id,
                "PROVIDER_REQUEST_FAILED",
                "the connection was interrupted mid-response.",
            );
        }
        LoopOutcome::Error(code, msg) => {
            let engine = app.state::<Engine>();
            persist(&app, &engine);
            fail_session(&app, &session_id, code, &msg);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering as TestOrdering};

    // ---------- resolved_path_for / path_arg_of (FR-13) ----------
    //
    // round_trip_cap_hit / context_exceeded / tool_call_error /
    // thread_tool_call / build_request_messages moved to blocks.rs along
    // with the tests that cover them.

    fn temp_cwd(label: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, TestOrdering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "francois-oai-runner-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolved_path_for_bash_is_always_none() {
        assert_eq!(
            resolved_path_for(FrancoisTool::Bash, &json!({ "command": "ls" }), "/repo"),
            None
        );
    }

    #[test]
    fn resolved_path_for_a_path_tool_resolves_inside_cwd() {
        let cwd = temp_cwd("resolve");
        std::fs::write(cwd.join("a.ts"), b"x").unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();
        let resolved = resolved_path_for(
            FrancoisTool::Read,
            &json!({ "file_path": cwd.join("a.ts").to_string_lossy() }),
            &cwd_str,
        )
        .expect("resolves inside cwd");
        assert!(resolved.starts_with(std::fs::canonicalize(&cwd).unwrap()));
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn resolved_path_for_returns_none_without_a_path_argument() {
        let cwd = temp_cwd("no-path-arg");
        let cwd_str = cwd.to_string_lossy().to_string();
        assert_eq!(
            resolved_path_for(FrancoisTool::Read, &json!({}), &cwd_str),
            None
        );
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn path_arg_of_defaults_grep_and_glob_to_cwd_when_omitted() {
        let cwd = "/repo/session-cwd";
        for tool in [FrancoisTool::Grep, FrancoisTool::Glob] {
            assert_eq!(
                path_arg_of(tool, &json!({}), cwd),
                Some(cwd),
                "{tool} with an omitted path must default to cwd"
            );
        }
        // Read still gets no default — file_path is required for it.
        assert_eq!(path_arg_of(FrancoisTool::Read, &json!({}), cwd), None);
    }

    #[test]
    fn resolved_path_for_grep_and_glob_with_no_path_argument_resolves_to_cwd() {
        // Before the fix this came back `None` for both tools, and
        // `tools::execute` fell through to its own internal-error string
        // instead of running the call.
        let cwd = temp_cwd("resolve-default");
        let cwd_str = cwd.to_string_lossy().to_string();
        for tool in [FrancoisTool::Grep, FrancoisTool::Glob] {
            let resolved = resolved_path_for(tool, &json!({}), &cwd_str)
                .unwrap_or_else(|| panic!("{tool} with no path argument must resolve to cwd"));
            assert!(resolved.starts_with(std::fs::canonicalize(&cwd).unwrap()));
        }
        std::fs::remove_dir_all(&cwd).ok();
    }

    // ---------- resolve_models (FR-18) ----------

    #[test]
    fn an_override_replaces_the_fetch_entirely_and_fills_context_tokens() {
        let out = resolve_models(
            Some(&["gpt-4o".to_string(), "mystery-model".to_string()]),
            vec![model("should-be-ignored", "should-be-ignored")],
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "gpt-4o");
        assert_eq!(out[0].context_tokens, Some(128_000));
        assert_eq!(out[1].id, "mystery-model");
        assert_eq!(out[1].context_tokens, Some(wire::OPENAI_CONTEXT_DEFAULT));
    }

    #[test]
    fn no_override_uses_the_fetched_catalog_with_context_tokens_filled() {
        let out = resolve_models(None, vec![model("gpt-4.1", "gpt-4.1")]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].context_tokens, Some(1_047_576));
    }

    #[test]
    fn a_failed_fetch_with_no_override_is_an_empty_list_not_the_anthropic_catalog() {
        let out = resolve_models(None, Vec::new());
        assert!(out.is_empty());
    }

    // ---------- OpenAiAdapter dispatch shape ----------

    #[test]
    fn the_adapter_reports_the_francois_runtime() {
        assert_eq!(OpenAiAdapter.agent_runtime(), AgentRuntime::Francois);
    }

    #[test]
    fn the_first_turn_notice_matches_fr19s_exact_wording() {
        assert_eq!(
            FIRST_TURN_NOTICE,
            "Francois runs its own agent loop on this provider — tool use and formatting differ from Claude Code."
        );
    }
}
