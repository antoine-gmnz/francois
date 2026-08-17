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
mod codex;
mod openai;

pub(crate) use claude_code::ClaudeCodeAdapter;
// `session_compact` (a synchronous side-spawn, not a full turn) and the
// argv-shaped unit tests still reach these directly — same "turn-shaped, not
// engine-shaped" reasoning `spawn.rs`'s module doc gives for keeping them out
// of the pure argv/env helpers.
pub(crate) use claude_code::{child_stdout_lines, spawn_claude};
/// multi-provider-codex FR-3: the `AgentRuntime::Codex` adapter.
pub(crate) use codex::{codex_program, CodexAdapter};
/// multi-provider-openai FR-1: the real `AgentRuntime::Francois` adapter —
/// `UnavailableAdapter` is gone, not kept alongside it.
pub(crate) use openai::OpenAiAdapter;

use super::*;

use crate::ipc::AppError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
}

/// Mirrors contract/common.ts `ProviderProtocol` (multi-provider-seam
/// FR-11a). Which wire dialect a session's endpoint speaks — orthogonal to
/// `AgentRuntime`: the Claude Code CLI honours `ANTHROPIC_BASE_URL`, so
/// `(ClaudeCode, Anthropic)` against a third-party endpoint is a real cell a
/// single collapsed enum could not name.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ProviderProtocol {
    #[default]
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "openai")]
    Openai,
}

impl AgentRuntime {
    /// multi-provider-seam FR-13a: both axes are DERIVED from the account's
    /// kind at creation — `session_create` never accepts either directly.
    /// Exhaustive over `AccountKind`, so a third kind fails to compile here
    /// rather than falling back silently.
    pub(crate) fn from_account_kind(
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
        }
    }
}

/// FR-1: what a turn spawn/connect reads off its session — snapshotted BEFORE
/// any I/O (under `Engine.sessions`, released immediately after), so no
/// adapter ever reaches back into the registry mid-spawn.
pub(crate) struct TurnContext {
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
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum TurnMode {
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
pub(crate) struct PendingCounts {
    pub(crate) questions: usize,
    pub(crate) permissions: usize,
}

/// FR-2: what `permissions_decide` hands to `TurnControl::decide_permission`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PermissionDecision {
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
pub(crate) enum ControlAck {
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
    fn models(&self, app: &AppHandle, account_id: &str) -> Vec<ModelInfo>;
}

static CLAUDE_CODE_ADAPTER: ClaudeCodeAdapter = ClaudeCodeAdapter;
static OPENAI_ADAPTER: OpenAiAdapter = OpenAiAdapter;
static CODEX_ADAPTER: CodexAdapter = CodexAdapter;

/// FR-4/FR-14a: dispatch a session's `agentRuntime` ALONE to its adapter —
/// `protocol` is read inside the `francois` runtime to pick the wire codec,
/// never here.
pub(crate) fn adapter_for(runtime: AgentRuntime) -> &'static dyn SessionAdapter {
    match runtime {
        AgentRuntime::ClaudeCode => &CLAUDE_CODE_ADAPTER,
        AgentRuntime::Francois => &OPENAI_ADAPTER,
        AgentRuntime::Codex => &CODEX_ADAPTER,
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
