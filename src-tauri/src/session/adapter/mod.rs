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

pub(crate) mod capabilities;
mod claude_code;
pub(crate) mod codex;
mod grok;
mod openai;
/// Retired Pi dispatch rejects execution; saved runtime identities stay exact.
struct PiAdapter;

/// claude-process-adapter FR-7: Claude-shaped context decoding lives with the adapter.
pub(crate) use claude_code::context::ContextTracker;
pub(crate) use claude_code::ClaudeCodeAdapter;
// `session_compact` is a synchronous side-run, not a full turn: its spawn and
// decoding stay behind the adapter too (claude-process-adapter FR-6/FR-7).
pub(crate) use claude_code::run_compact;
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

pub(crate) use crate::session::application::{
    ControlAck, PendingCounts, PermissionDecision, TurnContext, TurnControl, TurnMode,
};
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
            // pi-provider-auth FR-1: closes the "no account kind maps to Pi
            // yet" gap `meta()`/`begin_turn`/`apply_model_switch` special-cased
            // (mod.rs/turn.rs/lifecycle.rs) — those call sites are left as-is
            // (harmless: they now agree with this arm for every REAL Pi
            // account, and still protect a fixture that forces `agent_runtime
            // = Pi` on a non-Pi account id). Pi owns its own RPC transport, so
            // it has no provider API protocol value (FR-2 of the seam spec).
            crate::account::AccountKind::Pi => (AgentRuntime::Pi, ProviderProtocol::Pi),
        }
    }
}

/// FR-1: what a turn spawn/connect reads off its session — snapshotted BEFORE
/// any I/O (under `Engine.sessions`, released immediately after), so no
/// adapter ever reaches back into the registry mid-spawn.
/// pi-models-metrics: widened from `pub(crate)` to `pub` — `session_create`/
/// `session_switch_model` (both `pub fn`, required for Tauri's command
/// registration) now take this directly as a `runtimeModel` parameter, and a
/// `pub fn` may not expose a less-visible type in its own signature.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[allow(dead_code)]
pub struct RuntimeModelRef {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
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

impl SessionAdapter for PiAdapter {
    fn agent_runtime(&self) -> AgentRuntime {
        AgentRuntime::Pi
    }
    fn preflight(&self, _app: &AppHandle, _ctx: &TurnContext) -> Result<(), AppError> {
        Err(crate::ipc::retired_pi_error())
    }
    fn begin_turn(
        &self,
        _app: &AppHandle,
        _ctx: TurnContext,
    ) -> Result<std::sync::Arc<dyn TurnControl>, AppError> {
        Err(crate::ipc::retired_pi_error())
    }
    fn models(&self, _app: &AppHandle, _account_id: &str) -> Vec<ModelInfo> {
        Vec::new()
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
        // pi-provider-auth FR-1.
        assert_eq!(
            AgentRuntime::from_account_kind(crate::account::AccountKind::Pi),
            (AgentRuntime::Pi, ProviderProtocol::Pi)
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
            scope: Default::default(),
            execution: Default::default(),
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
pub(crate) use capabilities::{capability_ceiling, check_capability};
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
    if runtime == AgentRuntime::Pi || !RUNTIME_CAPABILITIES.contains(&key) {
        return false;
    }
    let baseline = match runtime {
        AgentRuntime::ClaudeCode => {
            RUNTIME_CAPABILITIES[..10].contains(&key) || matches!(key, "modelSwitching" | "images")
        }
        AgentRuntime::Francois => {
            matches!(key, "skills" | "permissions" | "modelSwitching" | "images")
        }
        AgentRuntime::Codex => matches!(
            key,
            "interactiveCommands" | "usageBar" | "modelSwitching" | "images"
        ),
        AgentRuntime::Grok => matches!(key, "modelSwitching" | "images"),
        AgentRuntime::Pi => false,
    };
    match caps {
        Some(caps) => {
            validate_capabilities(caps).is_ok()
                && (baseline || runtime == AgentRuntime::Codex && key == "permissions")
                && caps.get(key).is_some_and(|s| s.available)
        }
        None => baseline,
    }
}
pub(crate) fn native_capabilities(runtime: AgentRuntime) -> RuntimeCapabilities {
    RUNTIME_CAPABILITIES
        .iter()
        .map(|key| {
            let available = capability_ceiling(runtime, key);
            (
                (*key).to_string(),
                CapabilityState {
                    available,
                    reason: (!available)
                        .then(|| "This native runtime does not support this control.".into()),
                },
            )
        })
        .collect()
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
    fn codex_exposes_francois_owned_interactive_commands() {
        assert!(resolve_capability(
            AgentRuntime::Codex,
            None,
            "interactiveCommands"
        ));
        assert!(!resolve_capability(
            AgentRuntime::Grok,
            None,
            "interactiveCommands"
        ));
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
mod retirement_tests {
    use super::*;
    #[test]
    fn retired_pi_rejects_every_stale_true_capability() {
        let caps = RUNTIME_CAPABILITIES
            .iter()
            .map(|key| {
                (
                    key.to_string(),
                    CapabilityState {
                        available: true,
                        reason: None,
                    },
                )
            })
            .collect();
        for key in RUNTIME_CAPABILITIES {
            assert!(
                !resolve_capability(AgentRuntime::Pi, Some(&caps), key),
                "{key}"
            );
        }
    }
}
