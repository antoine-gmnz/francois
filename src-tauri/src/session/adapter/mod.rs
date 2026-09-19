//! The `SessionAdapter` seam (specs/multi-provider-seam.md FR-1..FR-10,
//! FR-11a/FR-13a/FR-14a): the trait boundary between the session engine and
//! whatever actually drives a turn. `ClaudeCodeAdapter` (claude_code.rs) is
//! the only real implementation today — it wraps the pre-existing
//! spawn/stdio/stream code with NO behavioural change. `adapter_for`
//! dispatches a session's `AgentRuntime` to its adapter; a future
//! `multi-provider-openai` adds a second implementation without touching the
//! engine, the commands, or any pane.
//!
//! This file owns the shared vocabulary (`AgentRuntime`, `ProviderProtocol`,
//! `TurnMode`, `TurnContext`, the two traits, `PendingCounts`/`ControlAck`/
//! `PermissionDecision`) and declares `claude_code`, the child that provides
//! the one real implementation — same "model in mod.rs, one concern per
//! child" shape the rest of this domain follows.

mod claude_code;
pub(crate) mod codex;
mod grok;
mod openai;
/// pi-runtime-distribution: installation discovery only (§5's
/// `francois:runtime:installation`) — NOT the RPC transport below, which
/// stays a deliberate stub.
pub(crate) mod pi;

/// The Pi transport is intentionally unavailable until the production runtime
/// is introduced. Keeping this adapter explicit makes dispatch exhaustive and
/// prevents an unknown runtime from falling back to Claude.
struct PiAdapter;

pub(crate) use claude_code::ClaudeCodeAdapter;
// `session_compact` (a synchronous side-spawn, not a full turn) and the
// argv-shaped unit tests still reach these directly — same "turn-shaped, not
// engine-shaped" reasoning `spawn.rs`'s module doc gives for keeping them out
// of the pure argv/env helpers.
pub(crate) use claude_code::{child_stdout_lines, spawn_claude};
/// multi-provider-codex FR-3: the `AgentRuntime::Codex` adapter.
pub(crate) use codex::CodexAdapter;
/// multi-provider-grok FR-3: the `AgentRuntime::Grok` adapter.
pub(crate) use grok::GrokAdapter;
/// display-openai-model-name FR-5: the OpenAI-shaped context-window table is
/// also the non-Anthropic id fallback `session::models::fallback_context`
/// reaches for — re-exported so that sibling domain module can name it
/// without `openai`/`wire` themselves needing to be crate-visible.
pub(crate) use openai::wire::context_tokens_for as openai_context_tokens_for;
/// multi-provider-openai FR-1: the real `AgentRuntime::Francois` adapter —
/// `UnavailableAdapter` is gone, not kept alongside it.
pub(crate) use openai::OpenAiAdapter;

use super::*;

use crate::ipc::AppError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::AppHandle;

/// Mirrors contract/common.ts `AgentRuntime` (multi-provider-seam FR-11a;
/// renames `SessionProvider` — same two members, honest name). Answers "who
/// owns the agent loop", NOT "which vendor's API": `ClaudeCode` is the Claude
/// Code CLI harness driving its own loop, `Francois` is our own loop in this
/// Rust core (added by `multi-provider-openai`). Which wire dialect the
/// endpoint speaks is the orthogonal `ProviderProtocol` below — see the
/// contract doc comment for the full reasoning (a future
/// Anthropic-API-through-our-own-loop cell is what a single collapsed enum
/// could not express).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum AgentRuntime {
    #[default]
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "francois")]
    Francois,
    /// multi-provider-codex FR-1: OpenAI's `codex` CLI driving its own loop.
    /// Pairs with `ProviderProtocol::Openai` exactly as `Francois` does — the
    /// two differ ONLY in who owns the loop, which is the cell a single
    /// collapsed enum could not name and the whole reason FR-11a split the axes.
    #[serde(rename = "codex")]
    Codex,
    /// multi-provider-grok FR-1: xAI's `grok` CLI driving its own loop —
    /// structurally the same cell as `Codex` (a vendor CLI, `ProviderProtocol::
    /// Openai` because the wire dialect underneath is an OpenAI-compatible one).
    #[serde(rename = "grok")]
    Grok,
    /// A session-scoped Pi child. Pi owns its RPC transport, so it has no
    /// provider API protocol value.
    #[serde(rename = "pi")]
    Pi,
}

/// Mirrors contract/common.ts `ProviderProtocol` (multi-provider-seam
/// FR-11a). Which wire dialect a session's endpoint speaks — orthogonal to
/// `AgentRuntime`: the Claude Code CLI honours `ANTHROPIC_BASE_URL`, so
/// `(ClaudeCode, Anthropic)` against a third-party endpoint is a real cell a
/// single collapsed enum could not name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ProviderProtocol {
    #[default]
    Anthropic,
    Openai,
    /// Explicit JSON null for Pi. This must remain distinct from a missing
    /// legacy field, which is migrated to `Anthropic` by persistence.
    Pi,
}

impl Serialize for ProviderProtocol {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Anthropic => serializer.serialize_str("anthropic"),
            Self::Openai => serializer.serialize_str("openai"),
            Self::Pi => serializer.serialize_none(),
        }
    }
}

impl<'de> Deserialize<'de> for ProviderProtocol {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = Option::<String>::deserialize(deserializer)?;
        match value.as_deref() {
            Some("anthropic") => Ok(Self::Anthropic),
            Some("openai") => Ok(Self::Openai),
            None => Ok(Self::Pi),
            Some(other) => Err(serde::de::Error::unknown_variant(
                other,
                &["anthropic", "openai"],
            )),
        }
    }
}

impl AgentRuntime {
    /// multi-provider-seam FR-13a: both axes are DERIVED from the account's
    /// kind at creation — `session_create` never accepts either directly.
    /// Exhaustive over `AccountKind`, so a third kind fails to compile here
    /// rather than falling back silently.
    pub fn from_account_kind(
        kind: crate::account::AccountKind,
    ) -> (AgentRuntime, ProviderProtocol) {
        match kind {
            crate::account::AccountKind::ClaudeCodeOauth => {
                (AgentRuntime::ClaudeCode, ProviderProtocol::Anthropic)
            }
            crate::account::AccountKind::OpenAiCompatible => {
                (AgentRuntime::Francois, ProviderProtocol::Openai)
            }
            // multi-provider-codex FR-2. Same protocol as the row above, and a
            // different runtime — the pair that makes the split load-bearing.
            crate::account::AccountKind::CodexCli => {
                (AgentRuntime::Codex, ProviderProtocol::Openai)
            }
            // multi-provider-grok FR-2: xAI's API is an OpenAI `/chat/completions`
            // dialect, so `Openai` is the honest protocol value even though the
            // vendor is neither Anthropic nor OpenAI.
            crate::account::AccountKind::GrokCli => (AgentRuntime::Grok, ProviderProtocol::Openai),
        }
    }
}

/// FR-1: what a turn spawn/connect reads off its session — snapshotted BEFORE
/// any I/O (under `Engine.sessions`, released immediately after), so no
/// adapter ever reaches back into the registry mid-spawn.
pub struct TurnContext {
    pub(crate) session_id: String,
    pub(crate) block_id: String,
    pub(crate) text: String,
    pub(crate) mode: TurnMode,
    pub(crate) cwd: String,
    pub(crate) model_id: String,
    pub(crate) effort: Option<String>,
    pub(crate) permission_mode: String,
    pub(crate) runtime: String,
    pub(crate) worktree_distro: Option<String>,
    pub(crate) account_id: String,
    /// Carried per FR-1's field list, even though `ClaudeCodeAdapter` does not
    /// read it directly today: the allowGit auto-approve fast path is decided
    /// deeper, in the control-channel handler, which still reads it live off
    /// `Session` (unchanged) rather than off this snapshot.
    #[allow(dead_code)]
    pub(crate) allow_git: bool,
    /// The resume anchor, already resolved per `mode` — `ResumeRetry` forces
    /// this `None` regardless of what `Session.claude_session_id` holds, so a
    /// still-good id is never dropped preemptively (a fresh init overwrites
    /// it on success).
    pub(crate) resume: Option<String>,
    /// session-profiles FR-13: the REPLACE-mode prompt, snapshotted at session
    /// creation and carried on EVERY turn — never re-read from the profile.
    pub(crate) system_prompt: Option<String>,
    /// session-profiles FR-12: raw extra argv tokens, appended last to the
    /// runtime's own argv. Empty when the session carries none.
    pub(crate) extra_args: Vec<String>,
    /// response-mode FR-5: the mode this turn was SPAWNED with, snapshotted with
    /// the rest. No adapter re-reads the session mid-turn, which is what makes
    /// FR-4's next-turn semantics uniform across runtimes.
    pub(crate) response_mode: crate::session::ResponseMode,
}

/// Immutable, lock-free snapshot used to establish a session-scoped runtime
/// connection. It deliberately carries no registry guard or credential.
#[allow(dead_code)]
#[derive(Clone)]
pub(crate) struct RuntimeConnectContext {
    pub(crate) session_id: String,
    pub(crate) cwd: String,
    pub(crate) runtime: String,
    pub(crate) worktree_distro: Option<String>,
    pub(crate) account_id: String,
    pub(crate) launch_policy: RuntimeLaunchPolicy,
    pub(crate) profile_snapshot: RuntimeProfileSnapshot,
    pub(crate) model: RuntimeModelRef,
    pub(crate) resume: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) struct RuntimeModelRef {
    #[serde(rename = "providerId")]
    pub(crate) provider_id: String,
    #[serde(rename = "modelId")]
    pub(crate) model_id: String,
}

/// Core-owned capability snapshot. A missing snapshot is intentionally
/// distinguishable from a map of enabled defaults, especially for Pi.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilityState {
    pub(crate) available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

pub type RuntimeCapabilities = BTreeMap<String, CapabilityState>;

/// Task 08 expands this message vocabulary further. pi-transcript-events FR-7
/// adds the one already-validated multimodal shape every session-scoped
/// runtime needs: the session's OWN attachment records, so an adapter can
/// resolve whichever ones its text actually references into its own wire
/// content — never a base64 blob built in the frontend and handed across IPC.
#[allow(dead_code)]
pub(crate) struct RuntimeSubmission {
    pub(crate) text: String,
    pub(crate) attachments: Vec<crate::session::attachments::Attachment>,
}

#[allow(dead_code)]
#[derive(Debug)]
pub(crate) struct SubmissionReceipt {
    pub(crate) request_id: String,
}

#[allow(dead_code)]
pub(crate) trait RuntimeSessionControl: Send + Sync {
    fn submit(&self, input: RuntimeSubmission) -> Result<SubmissionReceipt, AppError>;
    fn capabilities(&self) -> RuntimeCapabilities;
    fn cancel(&self) -> Result<(), AppError>;
    fn shutdown(&self) -> Result<(), AppError>;
}

#[derive(Clone, Copy, PartialEq)]
pub enum TurnMode {
    Normal,
    #[allow(dead_code)]
    Compact,
    /// Re-run of a turn whose `--resume` was rejected: skip re-buffering the
    /// user message; the caller has already cleared `claude_session_id` so it
    /// runs fresh (session-engine FR-9).
    ResumeRetry,
}

/// FR-2: pending-state introspection. `refresh_parked_status` derives
/// `awaiting_approval`/`awaiting_input` from this without knowing which
/// adapter it is talking to.
#[derive(Clone, Copy, Default)]
pub struct PendingCounts {
    pub(crate) questions: usize,
    pub(crate) permissions: usize,
}

/// FR-2: what `permissions_decide` hands to `TurnControl::decide_permission`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PermissionDecision {
    Allow,
    Deny,
}

/// The result of a `TurnControl::answer_question`/`decide_permission` call.
///
/// Richer than the bare `bool` the spec's FR-2 sketches, because the caller
/// (`session_answer_question`/`permissions_decide`) must tell "never pending"
/// (no event at all) apart from "pending, but the channel died between park
/// and decision" (a `cancelled` resolution is still owed, matching the
/// pre-refactor behavior). Both call sites match all three variants: the two
/// failure variants return the SAME `*_NOT_PENDING` error, and only
/// `ChannelClosed` resolves the card `cancelled` on its way out.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ControlAck {
    /// The id was never pending (unknown, or already resolved by a race).
    NotPending,
    /// The id was pending and the decision reached the control channel.
    Applied,
    /// The id was pending, but the channel is gone (the child died between
    /// park and decision) — the caller resolves it `cancelled`.
    ChannelClosed,
}

/// FR-2: replaces direct field access on the concrete turn handle, which
/// moves into `claude_code.rs` and is `pub(crate)` to it only. No command may
/// name a `Child`, a `ChildStdin`, or a pending map (FR-8) — everything reaches
/// the live turn through this trait.
pub(crate) trait TurnControl: Send + Sync {
    fn interrupt(&self);
    fn kill(&self);
    /// `id` is the caller's own tracking key for the ask — `blockId` at every
    /// call site today. The CLI's own `request_id` is an adapter-internal
    /// implementation detail the engine never sees.
    fn answer_question(&self, id: &str, answers: &Value) -> ControlAck;
    fn decide_permission(&self, id: &str, decision: PermissionDecision) -> ControlAck;
    /// permission-guardrails FR-7: the rule pattern a STILL-PENDING permission
    /// ask was parked with. A peek — it claims nothing, so `permissions_decide`
    /// can write an `*Always` rule before claiming (the spec'd order) without
    /// consuming the ask. `None` once the ask is resolved, or if it never was
    /// pending: that is the authorization gate on the rule write, and it must
    /// never be answered from the transcript buffer, whose resolved permission
    /// cards keep their `ask` (pattern included) for the life of the session.
    fn pending_permission_pattern(&self, id: &str) -> Option<String>;
    fn pending_counts(&self) -> PendingCounts;
    /// App-exit teardown only (`kill_all`): synchronously claim every pending
    /// ask so it can be resolved `cancelled` before the process is killed.
    /// Returns `(question block ids, permission block ids)`.
    fn drain_pending(&self) -> (Vec<String>, Vec<String>);
}

/// FR-1: the whole runner contract — turn start, the live control channel,
/// pending-state introspection, and the runtime's model catalog.
pub(crate) trait SessionAdapter: Send + Sync {
    /// Part of the runner contract per FR-1, and what the dispatch tests
    /// assert `adapter_for` on — production code routes BY runtime
    /// (`adapter_for`, FR-14a) rather than asking an adapter which one it
    /// is, so nothing outside the tests calls this yet.
    #[allow(dead_code)]
    fn agent_runtime(&self) -> AgentRuntime;
    /// Refuse a turn before any I/O.
    fn preflight(&self, app: &AppHandle, ctx: &TurnContext) -> Result<(), AppError>;
    /// Own spawning/connecting and starting the reader thread; the returned
    /// `TurnControl` becomes `Session.current`.
    fn begin_turn(
        &self,
        app: &AppHandle,
        ctx: TurnContext,
    ) -> Result<std::sync::Arc<dyn TurnControl>, AppError>;
    /// pi-rpc-sessions FR-1: `app` is threaded through (unlike `begin_turn`'s
    /// per-turn seam, which the engine already holds a lock-free snapshot
    /// for) because a session-scoped connection's own background reader must
    /// keep publishing `francois://session/event` runtime envelopes for the
    /// rest of its life, long after this call returns.
    #[allow(dead_code)]
    fn connect_session(
        &self,
        _app: &AppHandle,
        _ctx: RuntimeConnectContext,
    ) -> Result<std::sync::Arc<dyn RuntimeSessionControl>, AppError> {
        Err(runtime_unsupported())
    }
    fn models(&self, app: &AppHandle, account_id: &str) -> Vec<ModelInfo>;
}

#[allow(dead_code)]
fn runtime_unsupported() -> AppError {
    AppError::runtime(
        crate::ipc::RuntimeErrorCode::Unsupported,
        "this runtime does not support session connections",
    )
}

impl SessionAdapter for PiAdapter {
    fn agent_runtime(&self) -> AgentRuntime {
        AgentRuntime::Pi
    }
    fn preflight(&self, _app: &AppHandle, _ctx: &TurnContext) -> Result<(), AppError> {
        Err(AppError::runtime(
            crate::ipc::RuntimeErrorCode::Unavailable,
            "Pi runtime is not available in this build",
        ))
    }
    fn begin_turn(
        &self,
        _app: &AppHandle,
        _ctx: TurnContext,
    ) -> Result<std::sync::Arc<dyn TurnControl>, AppError> {
        Err(AppError::runtime(
            crate::ipc::RuntimeErrorCode::Unavailable,
            "Pi runtime is not available in this build",
        ))
    }
    fn models(&self, _app: &AppHandle, _account_id: &str) -> Vec<ModelInfo> {
        Vec::new()
    }

    /// pi-rpc-sessions FR-1/FR-4: the real, session-scoped seam — spawn the
    /// certified Pi child under the baseline launch policy and run the
    /// `get_state` handshake. `preflight`/`begin_turn` above stay
    /// unavailable: Pi does not use the per-turn `TurnControl` seam every
    /// other runtime does (a Pi child outlives a single turn), so nothing
    /// routes a Pi session through them today — see the module doc.
    fn connect_session(
        &self,
        app: &AppHandle,
        ctx: RuntimeConnectContext,
    ) -> Result<std::sync::Arc<dyn RuntimeSessionControl>, AppError> {
        Ok(pi::connect(app, ctx)? as std::sync::Arc<dyn RuntimeSessionControl>)
    }
}

static CLAUDE_CODE_ADAPTER: ClaudeCodeAdapter = ClaudeCodeAdapter;
static OPENAI_ADAPTER: OpenAiAdapter = OpenAiAdapter;
static CODEX_ADAPTER: CodexAdapter = CodexAdapter;
static GROK_ADAPTER: GrokAdapter = GrokAdapter;
static PI_ADAPTER: PiAdapter = PiAdapter;

/// FR-4/FR-14a: dispatch a session's `agentRuntime` ALONE to its adapter —
/// `protocol` is read inside the `francois` runtime to pick the wire codec,
/// never here.
pub fn adapter_for(runtime: AgentRuntime) -> &'static dyn SessionAdapter {
    match runtime {
        AgentRuntime::ClaudeCode => &CLAUDE_CODE_ADAPTER,
        AgentRuntime::Francois => &OPENAI_ADAPTER,
        AgentRuntime::Codex => &CODEX_ADAPTER,
        AgentRuntime::Grok => &GROK_ADAPTER,
        AgentRuntime::Pi => &PI_ADAPTER,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_runtime_serializes_to_the_contract_shape() {
        assert_eq!(
            serde_json::to_value(AgentRuntime::ClaudeCode).unwrap(),
            serde_json::json!("claude-code")
        );
        assert_eq!(
            serde_json::to_value(AgentRuntime::Francois).unwrap(),
            serde_json::json!("francois")
        );
        assert_eq!(
            serde_json::to_value(AgentRuntime::Codex).unwrap(),
            serde_json::json!("codex")
        );
        assert_eq!(
            serde_json::to_value(AgentRuntime::Grok).unwrap(),
            serde_json::json!("grok")
        );
        assert_eq!(
            serde_json::to_value(AgentRuntime::Pi).unwrap(),
            serde_json::json!("pi")
        );
        assert_eq!(AgentRuntime::default(), AgentRuntime::ClaudeCode);
    }

    #[test]
    fn provider_protocol_serializes_to_the_contract_shape() {
        assert_eq!(
            serde_json::to_value(ProviderProtocol::Anthropic).unwrap(),
            serde_json::json!("anthropic")
        );
        assert_eq!(
            serde_json::to_value(ProviderProtocol::Openai).unwrap(),
            serde_json::json!("openai")
        );
        assert_eq!(ProviderProtocol::default(), ProviderProtocol::Anthropic);
        assert_eq!(
            serde_json::to_value(ProviderProtocol::Pi).unwrap(),
            serde_json::Value::Null
        );
        assert_eq!(
            serde_json::from_value::<ProviderProtocol>(serde_json::Value::Null).unwrap(),
            ProviderProtocol::Pi
        );
    }

    #[test]
    fn from_account_kind_is_exhaustive_and_returns_the_pair() {
        assert_eq!(
            AgentRuntime::from_account_kind(crate::account::AccountKind::ClaudeCodeOauth),
            (AgentRuntime::ClaudeCode, ProviderProtocol::Anthropic)
        );
        assert_eq!(
            AgentRuntime::from_account_kind(crate::account::AccountKind::OpenAiCompatible),
            (AgentRuntime::Francois, ProviderProtocol::Openai)
        );
        assert_eq!(
            AgentRuntime::from_account_kind(crate::account::AccountKind::CodexCli),
            (AgentRuntime::Codex, ProviderProtocol::Openai)
        );
        // multi-provider-grok FR-2.
        assert_eq!(
            AgentRuntime::from_account_kind(crate::account::AccountKind::GrokCli),
            (AgentRuntime::Grok, ProviderProtocol::Openai)
        );
    }

    #[test]
    fn adapter_for_dispatches_by_runtime() {
        assert_eq!(
            adapter_for(AgentRuntime::ClaudeCode).agent_runtime(),
            AgentRuntime::ClaudeCode
        );
        assert_eq!(
            adapter_for(AgentRuntime::Francois).agent_runtime(),
            AgentRuntime::Francois
        );
        assert_eq!(
            adapter_for(AgentRuntime::Codex).agent_runtime(),
            AgentRuntime::Codex
        );
        // multi-provider-grok FR-3.
        assert_eq!(
            adapter_for(AgentRuntime::Grok).agent_runtime(),
            AgentRuntime::Grok
        );
        assert_eq!(
            adapter_for(AgentRuntime::Pi).agent_runtime(),
            AgentRuntime::Pi
        );
    }

    #[test]
    fn turn_context_carries_every_field_begin_turn_reads_off_a_session() {
        // FR-1: shape-only — a real call needs an AppHandle, which cannot be
        // built in a unit test (this crate wires up no such harness); the
        // engine-level `begin_turn` orchestration is covered where it lives,
        // against the pure ladder that builds this struct (session/turn.rs).
        let ctx = TurnContext {
            session_id: "s1".into(),
            block_id: "b1".into(),
            text: "hi".into(),
            mode: TurnMode::Normal,
            cwd: "/x".into(),
            model_id: "sonnet".into(),
            effort: None,
            permission_mode: "default".into(),
            runtime: "native".into(),
            worktree_distro: None,
            account_id: "default".into(),
            allow_git: false,
            resume: None,
            system_prompt: None,
            extra_args: Vec::new(),
            response_mode: crate::session::ResponseMode::Default,
        };
        assert_eq!(ctx.session_id, "s1");
        assert!(ctx.mode == TurnMode::Normal);
    }

    #[test]
    fn control_ack_variants_are_distinct() {
        assert_ne!(ControlAck::NotPending, ControlAck::Applied);
        assert_ne!(ControlAck::Applied, ControlAck::ChannelClosed);
        assert_ne!(ControlAck::NotPending, ControlAck::ChannelClosed);
    }
}

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct RuntimeLaunchPolicy {
    pub(crate) permission_mode: String,
    pub(crate) allow_git: bool,
}
#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct RuntimeProfileSnapshot {
    pub(crate) system_prompt: Option<String>,
    pub(crate) extra_args: Vec<String>,
}
impl RuntimeModelRef {
    pub(crate) fn validate(&self) -> Result<(), AppError> {
        if [&self.provider_id, &self.model_id]
            .iter()
            .any(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
        {
            return Err(AppError::runtime(
                crate::ipc::RuntimeErrorCode::InvalidInput,
                "invalid provider/model identity",
            ));
        }
        Ok(())
    }
}
impl RuntimeConnectContext {
    pub(crate) fn validate(self) -> Result<Self, AppError> {
        self.model.validate()?;
        if !std::path::Path::new(&self.cwd).is_absolute()
            || !crate::ipc::valid_correlation(&self.session_id)
        {
            return Err(AppError::runtime(
                crate::ipc::RuntimeErrorCode::InvalidInput,
                "invalid runtime connection snapshot",
            ));
        }
        Ok(self)
    }
}
pub(crate) const RUNTIME_CAPABILITIES: [&str; 17] = [
    "mcp",
    "subagents",
    "skills",
    "skillsInstall",
    "workflows",
    "interactiveCommands",
    "permissions",
    "remoteControl",
    "usageBar",
    "compaction",
    "steering",
    "followUps",
    "resumableSessions",
    "modelSwitching",
    "images",
    "contextMetrics",
    "costMetrics",
];
pub(crate) fn validate_capabilities(caps: &RuntimeCapabilities) -> Result<(), AppError> {
    if caps.len() != RUNTIME_CAPABILITIES.len()
        || RUNTIME_CAPABILITIES.iter().any(|key| {
            caps.get(*key).is_none_or(|state| {
                state.available == state.reason.is_some()
                    || state.reason.as_ref().is_some_and(|r| {
                        !crate::ipc::safe_display(r, crate::ipc::MAX_CAPABILITY_REASON_BYTES)
                    })
            })
        })
    {
        return Err(AppError::runtime(
            crate::ipc::RuntimeErrorCode::InvalidInput,
            "invalid runtime capabilities",
        ));
    }
    Ok(())
}
pub(crate) fn resolve_capability(
    runtime: AgentRuntime,
    caps: Option<&RuntimeCapabilities>,
    key: &str,
) -> bool {
    if !RUNTIME_CAPABILITIES.contains(&key) {
        return false;
    }
    let baseline = match runtime {
        AgentRuntime::ClaudeCode => {
            RUNTIME_CAPABILITIES[..10].contains(&key) || matches!(key, "modelSwitching" | "images")
        }
        AgentRuntime::Francois => {
            matches!(key, "skills" | "permissions" | "modelSwitching" | "images")
        }
        AgentRuntime::Codex | AgentRuntime::Grok => matches!(key, "modelSwitching" | "images"),
        AgentRuntime::Pi => false,
    };
    match caps {
        Some(caps) => {
            validate_capabilities(caps).is_ok()
                && (runtime == AgentRuntime::Pi || baseline)
                && caps.get(key).is_some_and(|s| s.available)
        }
        None => baseline,
    }
}
#[cfg(test)]
mod boundary_tests {
    use super::*;
    #[test]
    fn capability_reasons_are_bounded_safe_display_text() {
        let mut caps: RuntimeCapabilities = RUNTIME_CAPABILITIES
            .into_iter()
            .map(|k| {
                (
                    k.into(),
                    CapabilityState {
                        available: false,
                        reason: Some("Disabled".into()),
                    },
                )
            })
            .collect();
        caps.get_mut("mcp").unwrap().reason =
            Some("x".repeat(crate::ipc::MAX_CAPABILITY_REASON_BYTES + 1));
        assert!(validate_capabilities(&caps).is_err());
        caps.get_mut("mcp").unwrap().reason = Some("secret\nwire".into());
        assert!(validate_capabilities(&caps).is_err());
    }
    #[test]
    fn legacy_defaults_do_not_enable_unsupported_actions() {
        assert!(!resolve_capability(
            AgentRuntime::ClaudeCode,
            None,
            "steering"
        ));
        assert!(!resolve_capability(
            AgentRuntime::Codex,
            None,
            "permissions"
        ));
        assert!(!resolve_capability(AgentRuntime::Francois, None, "mcp"));
        let caps = RUNTIME_CAPABILITIES
            .into_iter()
            .map(|k| {
                (
                    k.into(),
                    CapabilityState {
                        available: true,
                        reason: None,
                    },
                )
            })
            .collect();
        assert!(!resolve_capability(AgentRuntime::Codex, Some(&caps), "mcp"));
    }
    #[test]
    fn missing_and_explicitly_disabled_snapshots() {
        assert!(resolve_capability(
            AgentRuntime::ClaudeCode,
            None,
            "permissions"
        ));
        assert!(!resolve_capability(AgentRuntime::Pi, None, "permissions"));
        let caps = RUNTIME_CAPABILITIES
            .into_iter()
            .map(|key| {
                (
                    key.into(),
                    CapabilityState {
                        available: false,
                        reason: Some("unavailable".into()),
                    },
                )
            })
            .collect();
        assert!(validate_capabilities(&caps).is_ok());
        assert!(!resolve_capability(
            AgentRuntime::ClaudeCode,
            Some(&caps),
            "permissions"
        ));
        assert!(validate_capabilities(&RuntimeCapabilities::new()).is_err());
    }
    #[test]
    fn exact_bounded_model_identifiers() {
        let model = RuntimeModelRef {
            provider_id: "provider".into(),
            model_id: "model:exact".into(),
        };
        assert!(model.validate().is_ok());
        assert!(RuntimeModelRef {
            provider_id: "".into(),
            ..model.clone()
        }
        .validate()
        .is_err());
        assert!(RuntimeModelRef {
            model_id: "x".repeat(257),
            ..model
        }
        .validate()
        .is_err());
    }
}

#[cfg(test)]
mod connect_snapshot_tests {
    use super::*;
    fn context(cwd: &str) -> RuntimeConnectContext {
        RuntimeConnectContext {
            session_id: uuid(),
            cwd: cwd.into(),
            runtime: "native".into(),
            worktree_distro: None,
            account_id: uuid(),
            launch_policy: RuntimeLaunchPolicy {
                permission_mode: "default".into(),
                allow_git: false,
            },
            profile_snapshot: RuntimeProfileSnapshot {
                system_prompt: Some("exact prompt".into()),
                extra_args: vec!["--exact".into()],
            },
            model: RuntimeModelRef {
                provider_id: "exact.provider".into(),
                model_id: "exact:model".into(),
            },
            resume: None,
        }
    }
    #[test]
    fn snapshot_requires_absolute_cwd_and_retains_launch_profile_and_model() {
        assert!(context("relative").validate().is_err());
        let ctx = context(env!("CARGO_MANIFEST_DIR")).validate().unwrap();
        assert_eq!(ctx.model.model_id, "exact:model");
        assert_eq!(
            ctx.profile_snapshot.system_prompt.as_deref(),
            Some("exact prompt")
        );
        assert_eq!(ctx.launch_policy.permission_mode, "default");
    }
}
