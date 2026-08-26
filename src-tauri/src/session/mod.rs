// session.rs — the Francois session engine (specs/session-engine.md).
//
// Owns the registry of Claude Code sessions, spawns `claude -p --output-format
// stream-json --input-format stream-json --permission-prompt-tool stdio
// --include-partial-messages --verbose` per turn (the turn text rides stdin as an
// NDJSON user line — session-questions), parses the NDJSON stream, and normalizes
// it to the SessionEvent stream on francois://session/event.
// Backend-only; every UI feature is a client of this engine.
//
// Build notes / honest v1 deviations (flagged for spec reconciliation):
//  * Primary path only (per-turn stream-json CLI). The SDK-sidecar escape hatch
//    is not built, so `done` status is unreachable in v1 (spec FR-2 anticipates
//    this) — sessions leave the live set only via `remove` or `error`.
//  * create-time spawn check = `claude --version` (catches "not found"). A live
//    auth failure surfaces on the first `send` as a turn error (session.error),
//    matching FR-19's lazy-error path rather than failing `create`.

mod adapter;
mod agent_transcript;
mod agents;
mod attachments;
mod blocks;
/// cloud-sessions: adopting a Claude Code on the web session. A CHILD of this
/// module on purpose — it constructs a `Session` (FR-10), and Rust lets a child
/// read its ancestor's private fields, so nothing here needs widened visibility.
mod cloud;
mod commands;
mod control;
mod env;
mod events;
mod interactive;
mod mcp;
mod mcp_approval;
mod models;
mod persistence;
mod remote;
mod remote_discovery;
/// response-mode FR-6: the closed `ResponseMode` enum and the CORE-OWNED
/// directive text. A child module rather than a top-level one because the
/// enum is a `Session`/`SessionMeta` field and nothing outside this domain
/// names it.
mod response_mode;
mod skills;
mod slash;
mod spawn;
// Deliberately NOT glob-exported below: its names (RUNNING, IDLE, is_busy) are
// generic, and `status::is_busy(..)` at the call site is what makes the check
// readable. The glob still brings the module path itself into scope.
pub(crate) mod status;
mod stdio;
/// command-inspect: the `StepDetail` capture record, its sidecar, and the
/// `conversation_step_detail` command — see the module doc for why capture is
/// adapter-agnostic (built through `build_step_detail`, written through
/// `SessionEnv::append_step_detail`).
mod step_detail;
mod stream;
mod tools;
/// transcript-scale FR-1/FR-2: the `block_buffer` eviction concern — split out
/// here per §Code layout once its logic + tests pushed this file past the
/// ~1000-line ceiling. A CHILD of this module on purpose, same rationale as
/// `cloud` above: it reads `BufBlock`'s private `streaming` field directly.
mod transcript_cap;
mod turn;
mod usage_probe;
mod workflow_details;
mod workflow_watch;
mod workflows;
mod worktree;

pub(crate) use adapter::*;
pub(crate) use agent_transcript::*;
pub(crate) use agents::*;
pub(crate) use attachments::*;
pub(crate) use blocks::*;
// A glob like every other domain here: `generate_handler!` needs several hidden
// items per command, so naming the three commands explicitly is not enough.
// Every name this module exports is `cloud_`/`Cloud`-prefixed or otherwise
// domain-specific for that reason — see cloud/mod.rs.
pub(crate) use cloud::*;
pub(crate) use commands::*;
pub(crate) use control::*;
pub(crate) use env::*;
pub(crate) use events::*;
pub(crate) use interactive::*;
pub(crate) use mcp::*;
pub(crate) use mcp_approval::*;
pub(crate) use models::*;
pub(crate) use persistence::*;
pub(crate) use remote::*;
pub(crate) use remote_discovery::*;
pub(crate) use response_mode::*;
pub(crate) use skills::*;
pub(crate) use slash::*;
pub(crate) use spawn::*;
pub(crate) use stdio::*;
pub(crate) use step_detail::*;
pub(crate) use stream::*;
pub(crate) use tools::*;
pub(crate) use transcript_cap::*;
pub(crate) use turn::*;
pub(crate) use usage_probe::*;
pub(crate) use workflow_details::*;
pub(crate) use workflow_watch::*;
pub(crate) use workflows::*;
pub(crate) use worktree::*;

#[cfg(test)]
mod testutil;

// session-profiles §6: the snapshot-at-creation profile identity SessionMeta
// carries (FR-16) — defined in the `profiles` domain, the same cross-domain
// pattern `project::SessionSeed` follows.
use crate::profiles::SessionProfileRef;
// usage-bar §6: the /usage meter grammar + stream-json answer extraction now live
// in usage.rs so the usage bar and this card path share ONE grammar. Behavior here
// is unchanged — these are the same functions, imported instead of defined.
use crate::usage::{parse_meter_line, probe_answer, synthetic_text, UsageMeter};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const EVENT_CHANNEL: &str = "francois://session/event";
/// agent-tab §5: the `agents` domain event stream (`agent.block`). Separate from
/// the session stream because AgentBlock builds on conversation-view's block
/// types while contract/common.ts (which owns SessionEvent) is import-free.
const AGENT_EVENT_CHANNEL: &str = "francois://agents/event";
/// workflow-details §5: the `workflows` domain event stream (`workflow.detail`).
/// Separate from the session stream for the same reason the agents one is —
/// WorkflowDetail builds on the agent-tab block vocabulary, while
/// contract/common.ts (which owns SessionEvent) is import-free.
const WORKFLOW_EVENT_CHANNEL: &str = "francois://workflows/event";
const QUEUE_CAP: usize = 20;
const DEFAULT_MODEL: &str = "sonnet";
/// interactive-commands FR-10: a /usage//cost probe is killed after this long.
/// Reused by the app-scoped usage-bar probe (usage.rs, usage-bar FR-8).
pub(crate) const PROBE_TIMEOUT_SECS: u64 = 30;

#[derive(Serialize, Clone)]
pub(crate) struct SessionMeta {
    id: String,
    name: String,
    cwd: String,
    model: ModelInfo,
    status: String, // running | idle | done | error
    #[serde(rename = "contextUsedTokens")]
    context_used_tokens: u64,
    #[serde(rename = "contextLimitTokens")]
    context_limit_tokens: u64,
    #[serde(rename = "startedAt")]
    started_at: u64,
    #[serde(rename = "lastActivityAt")]
    last_activity_at: u64,
    #[serde(rename = "errorMessage", skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
    #[serde(rename = "permissionMode")]
    permission_mode: String,
    /// rework-top-bar (design 11c): the epoch-ms stamp of the LAST permission-mode
    /// write — creation counts as the first one. The run chip's panel renders it as
    /// the `on since HH:MM` line under `bypass`, which is the one mode whose age is
    /// worth knowing before you walk away from it.
    #[serde(rename = "permissionModeSince")]
    permission_mode_since: u64,
    /// rework-top-bar (design 11c): the reasoning-effort level this session's next
    /// turn spawns with — ABSENT (never null) when the model runs at its own
    /// default, same omit-not-null convention as `projectId`. Already persisted on
    /// `Session`; it simply had no way onto the wire before the run chip needed it.
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    runtime: String,
    /// projects FR-18: the project this session was created under; ABSENT (never
    /// null) when unlinked, so a pre-projects frontend and a pre-projects
    /// sessions.json both read identically. Set at creation only (FR-19/FR-24);
    /// cleared — with a session.meta emission — when that project is removed (FR-9).
    #[serde(rename = "projectId", skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    /// session-worktree FR-12/FR-13: present iff this session runs in a
    /// Francois-created or Francois-adopted git worktree.
    #[serde(skip_serializing_if = "Option::is_none")]
    worktree: Option<SessionWorktree>,
    /// multi-account FR-19: the account EVERY claude spawn of this session runs
    /// under. REQUIRED on the wire (never omitted, unlike projectId): a session
    /// always has an account, and a persisted record without one loads as
    /// `default` (FR-10).
    #[serde(rename = "accountId")]
    account_id: String,
    /// cloud-sessions FR-10/FR-16: present ⇔ this session was ADOPTED from a
    /// Claude Code on the web session. Presence is the whole signal (it drives
    /// the `cloud` chip); same omit-not-null convention as `projectId`, so a
    /// pre-feature frontend reads an ordinary session.
    #[serde(skip_serializing_if = "Option::is_none")]
    cloud: Option<CloudProvenance>,
    /// multi-provider-seam FR-11a: who owns this session's agent loop.
    /// DERIVED from the session's account kind at creation and never
    /// re-derived. Required on the wire (never omitted): a persisted record
    /// without it loads as `AgentRuntime::ClaudeCode` (`AgentRuntime`'s
    /// `Default`).
    #[serde(rename = "agentRuntime")]
    agent_runtime: AgentRuntime,
    /// multi-provider-seam FR-11a: the wire dialect this session's endpoint
    /// speaks. Same derivation/persistence discipline as `agent_runtime`.
    protocol: ProviderProtocol,
    /// session-profiles FR-16: present ⇔ created from a profile; snapshot-only.
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<SessionProfileRef>,
    /// response-mode FR-1: how this session's NEXT turn is told to write.
    /// REQUIRED on the wire (never omitted, like `accountId`): every session has
    /// one, and a persisted record without the key loads as `default`.
    #[serde(rename = "responseMode")]
    response_mode: ResponseMode,
    /// session-settings-sheet FR-1: Francois auto-approves direct `git`/`gh`
    /// Bash calls for this session. REQUIRED on the wire (never omitted, like
    /// `accountId`/`responseMode`) — a persisted record without the key loads
    /// as `false`. Already persisted under this name (`session/persistence.rs`);
    /// this only widens `meta()` to project the field that was already there.
    #[serde(rename = "allowGit")]
    allow_git: bool,
}

#[derive(Serialize, Clone)]
pub struct AgentInfo {
    id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    name: String,
    task: String,
    status: String, // running | idle | done | error
    #[serde(rename = "startedAt")]
    started_at: u64,
    #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
    ended_at: Option<u64>,
    /// async-agents FR-2: true when the dispatch was asynchronous. For these the
    /// dispatch's tool_result is a spawn ack and NEVER stamps `ended_at` (FR-5).
    background: bool,
    /// async-agents FR-10: label of the newest AgentStep; absent until the first.
    #[serde(rename = "lastActivity", skip_serializing_if = "Option::is_none")]
    last_activity: Option<String>,
    /// async-agents FR-12: total steps ever observed — may exceed the trail window.
    #[serde(rename = "stepCount")]
    step_count: u32,
}

/// contract AgentStep (async-agents §5) — one entry of an agent's activity trail.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct AgentStep {
    /// Strictly increasing per agent, starting at 1 (FR-12).
    seq: u32,
    kind: String, // text | tool | notice
    at: u64,
    /// kind 'tool' only.
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
    label: String,
    /// kind 'tool' only, once the step's tool_result arrived.
    #[serde(skip_serializing_if = "Option::is_none")]
    meta: Option<String>,
}

/// async-agents FR-12: the trail is a bounded window; the oldest step is dropped
/// on overflow while `seq` and `step_count` keep growing.
const AGENT_TRAIL_CAP: usize = 200;

/// async-agents FR-9: one tool_use observed INSIDE a subagent. `seq` is spec §6's
/// `agent_inner_tools` value; `tool`/`input` ride along so the meta fill can reuse
/// the exact same `tool_meta` derivation as a top-level tool.done (§5.4).
#[derive(Clone)]
pub(crate) struct InnerTool {
    seq: u32,
    tool: String,
    input: Value,
    /// agent-tab FR-2: the transcript block minted for the same tool_use, so one
    /// `tool_result` fills the step's `meta` AND the block's in one pass.
    block_id: String,
}

/// What an async-agents state mutation asks its caller to emit, in order. Keeping
/// the mutation pure over `Session` is what makes the whole feature unit-testable:
/// the AppHandle wrappers only lock → mutate → drop the lock → emit.
#[derive(Clone)]
pub(crate) enum AgentEmission {
    Step {
        agent_id: String,
        step: AgentStep,
    },
    Update {
        agent: AgentInfo,
    },
    /// agent-tab FR-8: a transcript block was appended, or an existing one was
    /// re-emitted with its `meta` filled. Carries the serialized AgentBlock.
    Block {
        agent_id: String,
        block: Value,
    },
}

/// Tool names that dispatch a subagent. Claude Code's stock CLI uses `Task`;
/// some harnesses expose it as `Agent`. Mirrored in classifyToolStart (TS).
fn is_subagent_tool(tool: &str) -> bool {
    matches!(tool, "Task" | "Agent")
}

/// contract WorkflowRun (workflow-panel §5) — one dispatch of the harness's
/// `Workflow` tool, tracked from the stream. Everything here is derived from
/// the session's own NDJSON: the panel is read-only, so there is no verb that
/// can create or stop one.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct WorkflowRun {
    id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    name: String,
    description: String,
    status: String, // running | done | error
    #[serde(rename = "startedAt")]
    started_at: u64,
    #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
    ended_at: Option<u64>,
    phases: Vec<WorkflowPhaseInfo>,
    /// The harness run id (`wf_…`) from the dispatch ack; absent until it lands.
    #[serde(rename = "runId", skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    #[serde(rename = "lastActivity", skip_serializing_if = "Option::is_none")]
    last_activity: Option<String>,
    /// workflow-details FR-1/FR-2: the ack's `Transcript dir:`, kept only when it
    /// resolved to an existing directory. Absent ⇒ the pane [6] card is not
    /// clickable (FR-11) and this run has no detail to read.
    #[serde(rename = "transcriptDir", skip_serializing_if = "Option::is_none")]
    transcript_dir: Option<String>,
    /// workflow-details FR-24: how many asks are currently attributed to this
    /// run, so the panel can say `waiting on you` without subscribing to the
    /// detail stream. ABSENT (never 0) when nothing is blocking.
    #[serde(rename = "pendingAsks", skip_serializing_if = "Option::is_none")]
    pending_asks: Option<u32>,
}

/// contract WorkflowPhaseInfo — one entry of the script's `meta.phases`.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct WorkflowPhaseInfo {
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Serialize, Clone)]
pub(crate) struct McpServerInfo {
    name: String,
    status: String, // connected | connecting | error
    #[serde(rename = "toolCount", skip_serializing_if = "Option::is_none")]
    tool_count: Option<u32>,
    #[serde(rename = "errorMessage", skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<String>, // project | local | user — set by mcp_list; None on runtime updates
}

/// A parked AskUserQuestion awaiting its answer, keyed by blockId in the turn's
/// pending map (§6). `input` is the VERBATIM tool input — the allow response must
/// echo it unmodified plus the answers map (FR-11/FR-12).
pub(crate) struct PendingQuestion {
    request_id: String,
    input: Value,
}

/// A parked permission ask awaiting its decision, keyed by blockId in the turn's
/// pending map. `input` is the VERBATIM tool input — an allow response must echo
/// it unmodified (permission-guardrails FR-3).
pub(crate) struct PendingPermission {
    request_id: String,
    input: Value,
    /// permission-guardrails FR-7: the rule pattern this ask was parked with —
    /// what an `*Always` decision writes into settings.json. It lives HERE,
    /// with the pending entry, because being pending is what AUTHORIZES that
    /// write: this entry disappears the instant the ask is claimed, whereas the
    /// resolved transcript card keeps its `ask` (pattern included) forever.
    pattern: String,
}

// ---------- internal registry ----------

// In-memory transcript buffer (§6). Read by conversation-view's getTranscript
// channel; mirrors the ConversationBlock shape in contract/conversation-view.ts.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum BlockKind {
    User,
    Assistant,
    Tool,
    Subagent,
    Command,    // interactive-commands: a slash-command response card
    Question,   // session-questions: an AskUserQuestion card
    Permission, // permission-guardrails: a gated tool call awaiting approval
    /// agent-tab FR-4: an engine lifecycle marker inside a subagent's transcript
    /// (dispatch / completion / kill / turn end). Only ever buffered per agent —
    /// never in a session's own `block_buffer`.
    Notice,
}

#[derive(Clone)]
pub(crate) struct BufBlock {
    block_id: String,
    kind: BlockKind,
    text: String,
    // Field reuse per kind (precedent: the subagent name lives in `summary`):
    // `tool` holds the tool name for Tool blocks and the command token for Command blocks;
    // on a Subagent block `text` holds the model the dispatch named (empty ⇒ inherited).
    tool: String,
    summary: String,
    meta: Option<String>,
    /// interactive-commands: serialized CommandCard (Command kind; None while pending).
    card: Option<Value>,
    streaming: bool,
    /// design 9a: epoch ms this block was appended, mirrored to the contract's
    /// `ConversationBlockBase.at`. 0 means "unknown" — a block read back from a
    /// transcript written before the field existed — and is serialized as an
    /// ABSENT key rather than as an epoch that would render as 01:00.
    at: u64,
    /// command-inspect FR-1/FR-10: true iff a `StepDetail` record was written
    /// for this block at settle time. Only ever set on a `Tool` block —
    /// `classify_block` is what decides whether the kind even has a slot for
    /// it (`ToolConversationBlock` only; a `Subagent` block's contract type
    /// carries no `hasDetail` field, so the value there is inert).
    has_detail: bool,
}

impl BufBlock {
    /// §8 dedup: every `buf_*` append (below) and `parse_persisted_block`
    /// (persistence.rs) built the same 8-field literal by hand, differing in
    /// only 2-4 fields each. This is the shared shape — `text`/`tool`/`summary`
    /// empty, `meta`/`card` absent, not streaming — callers override just what
    /// differs via `BufBlock { field: value, ..BufBlock::new(id, kind) }`.
    ///
    /// `at` is stamped HERE, at construction, because that is the one moment
    /// every block passes through: a live append happens as the event lands,
    /// and a reload overrides the field with what the line carried.
    fn new(block_id: &str, kind: BlockKind) -> BufBlock {
        BufBlock {
            block_id: block_id.into(),
            kind,
            text: String::new(),
            tool: String::new(),
            summary: String::new(),
            meta: None,
            card: None,
            streaming: false,
            at: now_ms(),
            has_detail: false,
        }
    }
}

/// The single in-flight /usage-/cost side-spawn of a session (interactive-commands
/// FR-11). The child slot is filled once spawned; killed on session remove & app exit.
pub(crate) struct ProbeHandle {
    block_id: String,
    child: Arc<Mutex<Option<Child>>>,
}

impl ProbeHandle {
    fn kill(&self) {
        if let Some(c) = self.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    }
}

pub(crate) struct Session {
    id: String,
    name: String,
    cwd: String,
    model_id: String,
    status: String,
    context_used_tokens: u64,
    context_limit_tokens: u64,
    started_at: u64,
    last_activity_at: u64,
    error_message: Option<String>,
    effort: Option<String>,  // --effort level (None = model default)
    permission_mode: String, // contract PermissionMode; "default" = inherit ~/.claude settings
    /// rework-top-bar (design 11c): epoch ms of the last `permission_mode` write.
    /// Seeded at creation (and at load, from the persisted key) so the value is
    /// always a real instant rather than an "unknown" the frontend has to render
    /// around. NOT a `Session::new` parameter — every creation path wants the same
    /// thing, the session's own start.
    permission_mode_since: u64,
    runtime: String, // contract ClaudeRuntime; "native" | "wsl"
    /// When true, Francois auto-approves `git`/`gh` tool calls on the stdio
    /// control channel instead of denying them (NewSessionRequest.allowGit) —
    /// lets a session run git commit/push without bypassing every permission.
    allow_git: bool,
    /// projects FR-18/FR-19: the project this session belongs to, stored VERBATIM
    /// as `session_create` received it — the core does no auto-adoption and no
    /// default merging, so what the modal showed is exactly what was created.
    project_id: Option<String>,
    /// session-worktree FR-12: provenance when this session runs in a
    /// Francois-created or Francois-adopted git worktree.
    worktree: Option<SessionWorktree>,
    /// session-worktree FR-10: the `GitHost` this session's cwd/worktree was
    /// resolved under, captured ONCE at creation (`resolve_worktree`) — `None`
    /// for `Native`, `Some(distro)` for `Wsl(distro)`. Once `cwd` is replaced by
    /// the worktree path it may be a bare Linux path with no `\\wsl$\<distro>\…`
    /// prefix left to re-derive the distro from, so every git-routing / turn-spawn
    /// call site that used to call `GitHost::of(&cwd)` reuses this stored value
    /// instead (never re-derives it from `cwd`/`worktree.path`). Persisted
    /// alongside `worktree` (sibling `worktreeDistro` key, see persistence.rs) so
    /// it survives a restart.
    worktree_distro: Option<String>,
    /// multi-account FR-19: the account this session was created under, stored
    /// VERBATIM at creation and never re-derived. Only two things ever change
    /// it: the account being removed (FR-9) and a persisted value that no longer
    /// resolves (FR-10) — both fall back to `default`.
    account_id: String,
    /// cloud-sessions FR-10: set at adoption ONLY, never re-derived. Not a
    /// `Session::new` parameter on purpose — `cloud/adopt.rs` is the single
    /// writer, so no other creation path can accidentally claim provenance.
    cloud: Option<CloudProvenance>,
    /// multi-provider-seam FR-11a: DERIVED from the account's kind at creation
    /// (FR-13a) and never re-derived afterward — see
    /// `AgentRuntime::from_account_kind`.
    agent_runtime: AgentRuntime,
    /// multi-provider-seam FR-11a: the wire dialect, derived alongside
    /// `agent_runtime` from the same `from_account_kind` call and never
    /// re-derived afterward.
    protocol: ProviderProtocol,
    /// session-profiles FR-12/FR-13: REPLACE-mode prompt, snapshotted at
    /// creation and threaded through every turn's `turn_args` — never
    /// re-read from the profile (FR-16).
    system_prompt: Option<String>,
    /// session-profiles FR-12: raw extra argv tokens, appended last to every
    /// turn's `turn_args`. Empty when the session carries none.
    extra_args: Vec<String>,
    /// session-profiles FR-16: the profile identity this session was created
    /// from, if any — snapshot-only, never re-resolved.
    profile: Option<SessionProfileRef>,
    /// response-mode FR-1/FR-4: the mode the NEXT turn spawns with. Changing it
    /// signals no process and writes nothing to a running child — a turn keeps
    /// the mode it was snapshotted with (`TurnContext.response_mode`).
    response_mode: ResponseMode,
    /// response-mode FR-10: the mode the CURRENT thread has already been told
    /// about — CORE-PRIVATE state, never in `SessionMeta`, never in any payload,
    /// never in diagnostics. Only `codex`/`grok` read or write it (their threads
    /// carry history, so a directive already sent must not be repeated and a
    /// withdrawn one must be explicitly cleared, FR-11); `claude-code` and
    /// `francois` rebuild their directive per turn/request and leave this `None`
    /// forever. Reset to `None` whenever the thread anchor is cleared.
    response_mode_sent: Option<ResponseMode>,
    queue: VecDeque<(String, String)>, // (client blockId, text)
    claude_session_id: Option<String>,
    /// multi-provider-seam FR-2: the live turn, reached only through
    /// `TurnControl` — no field here ever names a `Child`, a `ChildStdin`, or
    /// a pending map. `Arc` (not `Box`, per the letter of the spec) because
    /// answering/deciding a parked ask must clone the handle out from under
    /// `Engine.sessions` BEFORE writing to the control channel — a blocking
    /// pipe write must never happen while the sessions lock is held.
    current: Option<Arc<dyn TurnControl>>,
    pending_probe: Option<ProbeHandle>, // interactive-commands FR-11: single in-flight side-spawn
    agents: HashMap<String, AgentInfo>,
    agent_order: Vec<String>, // first-seen order for agents_list (FR-7)
    // ---- async-agents §6 (none of this is serialized; cleared with the session) ----
    /// FR-1 correlation key: dispatch tool_use_id → agentId. Lives on the session
    /// (not the turn-local `tools` map) so FR-13/FR-16 reach it after the call closed.
    agent_by_tool: HashMap<String, String>,
    /// FR-12: the ≤200-step trail per agent.
    agent_steps: HashMap<String, VecDeque<AgentStep>>,
    /// FR-12: next `seq` per agent (1-based).
    agent_step_seq: HashMap<String, u32>,
    /// FR-9: per-agent inner tool index — deliberately separate from the parent
    /// turn's `tools` map so the two can never collide.
    agent_inner_tools: HashMap<String, HashMap<String, InnerTool>>,
    /// FR-5: the spawn ack's text, for FR-14 matching.
    agent_backend_ref: HashMap<String, String>,
    // ---- agent-tab §6 (in-memory, cleared with the session — never serialized) ----
    /// FR-5: the ≤400-block transcript window per agent, in the same BufBlock
    /// shape (and through the same classify_block serializer) as the session's
    /// own `block_buffer`.
    agent_blocks: HashMap<String, VecDeque<BufBlock>>,
    /// FR-5: next `blockId` ordinal per agent (1-based).
    agent_block_seq: HashMap<String, u32>,
    /// FR-5: blocks evicted past the window — the tab's `… N earlier blocks` row.
    agent_blocks_dropped: HashMap<String, u32>,
    block_buffer: Vec<BufBlock>, // §6: read by conversation-view's getTranscript
    /// transcript-scale FR-6: true once ANY block has ever been evicted from
    /// `block_buffer` (live, FR-2) or trimmed off the tail at load (FR-3) —
    /// monotonic, since the transcript is append-only and nothing evicted is
    /// ever un-evicted. This IS "a block older than the first held one exists
    /// in the persisted transcript" (`getTranscript`'s `hasMore` with no
    /// `before`), computed without re-reading the file.
    transcript_truncated: bool,
    /// session-attachments §6: the staged/sent refs of this session, persisted
    /// alongside the rest of the record in sessions.json so FR-17's start-up
    /// sweep survives a crash. The attachments DIR is never stored — it is
    /// derived from `cwd` + the session id (FR-2), which is what keeps a
    /// worktree session's files under the worktree.
    attachments: Vec<Attachment>,
    mcp: HashMap<String, McpServerInfo>,
    // ---- workflow-panel §6 (in-memory, cleared with the session — never persisted) ----
    /// FR-2: every `Workflow` dispatch seen this session, by run id.
    workflows: HashMap<String, WorkflowRun>,
    /// FR-7: first-seen order for `workflows_list`.
    workflow_order: Vec<String>,
    /// FR-2 correlation key: dispatch tool_use_id → run id. Session-scoped (not
    /// turn-local) so the ack and the completion notice both reach it after the
    /// tool call closed.
    workflow_by_tool: HashMap<String, String>,
    /// workflow-details FR-1: run id → the `Script file:` the dispatch ack named,
    /// kept only when it resolved to an existing file (FR-2). CORE-ONLY state —
    /// unlike `transcriptDir` it never rides on `WorkflowRun`, because nothing in
    /// the frontend addresses the script by path.
    workflow_scripts: HashMap<String, PathBuf>,
    // slash-menu FR-2: the CLI's slash_commands captured from the latest
    // stream-json init (bare names, init order). In-memory only — never
    // persisted; a fresh app relearns it on the next turn (spec §6).
    cli_commands: Vec<String>,
    /// multi-provider-grok FR-27: has THIS session already shown its
    /// once-per-session Windows sandbox notice? In-memory only, like `cloud`
    /// above — not a `Session::new` parameter, so no creation path can
    /// accidentally pre-set it, and a reload starts false again (a fresh
    /// reminder after a restart is honest, not a bug).
    grok_sandbox_notice_emitted: bool,
}

impl Session {
    /// Build a freshly-registered `Session`. Serves BOTH `session_create` (a
    /// brand-new session: zeroed usage, no resume anchor, empty transcript) and
    /// `load_persisted` (a reloaded record: its saved usage/resume-id/transcript,
    /// `started_at` reset to load time per FR-18's honest-clock choice) — the two
    /// literals were kept in lockstep by hand before this; now there is one.
    /// Every field NOT taken here (queue, current turn, agents, mcp, …) is
    /// in-memory-only run state that is always empty at construction.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        id: String,
        name: String,
        cwd: String,
        model_id: String,
        context_used_tokens: u64,
        context_limit_tokens: u64,
        started_at: u64,
        last_activity_at: u64,
        effort: Option<String>,
        permission_mode: String,
        runtime: String,
        allow_git: bool,
        project_id: Option<String>,
        worktree: Option<SessionWorktree>,
        worktree_distro: Option<String>,
        account_id: String,
        agent_runtime: AgentRuntime,
        protocol: ProviderProtocol,
        claude_session_id: Option<String>,
        block_buffer: Vec<BufBlock>,
        system_prompt: Option<String>,
        extra_args: Vec<String>,
        profile: Option<SessionProfileRef>,
        response_mode: ResponseMode,
    ) -> Session {
        Session {
            id,
            name,
            cwd,
            model_id,
            status: "idle".into(),
            context_used_tokens,
            context_limit_tokens,
            started_at,
            last_activity_at,
            error_message: None,
            effort,
            permission_mode,
            permission_mode_since: started_at,
            runtime,
            allow_git,
            project_id,
            worktree,
            worktree_distro,
            account_id,
            cloud: None,
            agent_runtime,
            protocol,
            system_prompt,
            extra_args,
            profile,
            response_mode,
            // response-mode FR-10: a brand-new session's thread has been told
            // nothing yet — the first turn is a fresh thread and sends whatever
            // the mode asks for.
            response_mode_sent: None,
            queue: VecDeque::new(),
            claude_session_id,
            current: None,
            pending_probe: None,
            agents: HashMap::new(),
            agent_order: Vec::new(),
            agent_by_tool: HashMap::new(),
            agent_steps: HashMap::new(),
            agent_step_seq: HashMap::new(),
            agent_inner_tools: HashMap::new(),
            agent_backend_ref: HashMap::new(),
            agent_blocks: HashMap::new(),
            agent_block_seq: HashMap::new(),
            agent_blocks_dropped: HashMap::new(),
            block_buffer,
            // transcript-scale: always false at fresh construction — both
            // `Session::new` callers (session_create, cloud adoption) pass an
            // empty or freshly-hydrated buffer that has never been trimmed.
            transcript_truncated: false,
            attachments: Vec::new(),
            mcp: HashMap::new(),
            workflows: HashMap::new(),
            workflow_order: Vec::new(),
            workflow_by_tool: HashMap::new(),
            workflow_scripts: HashMap::new(),
            cli_commands: Vec::new(),
            grok_sandbox_notice_emitted: false,
        }
    }

    /// multi-provider-grok FR-27: claim the once-per-session Windows sandbox
    /// notice. Returns `true` the FIRST time it is called on a session (and
    /// flips the flag so every later call returns `false`) — the caller emits
    /// the notice iff this returns `true`.
    fn claim_grok_sandbox_notice(&mut self) -> bool {
        if self.grok_sandbox_notice_emitted {
            return false;
        }
        self.grok_sandbox_notice_emitted = true;
        true
    }

    fn meta(&self) -> SessionMeta {
        let label = label_for(&self.model_id);
        SessionMeta {
            id: self.id.clone(),
            name: self.name.clone(),
            cwd: self.cwd.clone(),
            model: model(&self.model_id, &label),
            status: self.status.clone(),
            context_used_tokens: self.context_used_tokens,
            context_limit_tokens: self.context_limit_tokens,
            started_at: self.started_at,
            last_activity_at: self.last_activity_at,
            error_message: self.error_message.clone(),
            permission_mode: self.permission_mode.clone(),
            permission_mode_since: self.permission_mode_since,
            effort: self.effort.clone(),
            runtime: self.runtime.clone(),
            project_id: self.project_id.clone(),
            worktree: self.worktree.clone(),
            account_id: self.account_id.clone(),
            cloud: self.cloud.clone(),
            agent_runtime: self.agent_runtime,
            protocol: self.protocol,
            profile: self.profile.clone(),
            response_mode: self.response_mode,
            allow_git: self.allow_git,
        }
    }

    /// transcript-scale FR-1/FR-2: trim `block_buffer` to `TRANSCRIPT_BUFFER_CAP`,
    /// stopping at the oldest unsettled block — see `trim_transcript`. Called
    /// after every append AND after every mutation that can settle a block
    /// (finishing a stream, resolving an ask), since either can unblock an
    /// eviction that was previously pinned.
    fn trim_block_buffer(&mut self) {
        if trim_transcript(&mut self.block_buffer, TRANSCRIPT_BUFFER_CAP) {
            self.transcript_truncated = true;
        }
    }

    fn buf_user(&mut self, block_id: &str, text: String) {
        self.block_buffer.push(BufBlock {
            text,
            ..BufBlock::new(block_id, BlockKind::User)
        });
        self.trim_block_buffer();
    }

    fn buf_assistant(&mut self, block_id: &str, text: String) {
        self.block_buffer.push(BufBlock {
            text,
            ..BufBlock::new(block_id, BlockKind::Assistant)
        });
        self.trim_block_buffer();
    }

    /// conversation-view FR-10 / transcript-perf FR-22: an assistant block
    /// joins the buffer at its FIRST delta, not at `content_block_stop`.
    /// Before that it was invisible to `getTranscript`, so a view hydrating
    /// mid-block seeded a transcript with no in-flight block and then only
    /// saw the deltas that arrived after it — the answer rendered with its
    /// opening missing. Upsert, but APPEND rather than replace: a later
    /// delta pushes just its own `chunk` onto the existing block's text
    /// (amortized O(1), not O(block length) — transcript-perf FR-23), and
    /// only the first delta for a block-id ever pays for the full text, by
    /// seeding the new block with `accumulated` (so a block first observed
    /// mid-stream still carries its head). Searched from the end — it is
    /// the newest block in all but pathological interleavings.
    fn buf_assistant_streaming(&mut self, block_id: &str, chunk: &str, accumulated: &str) {
        if let Some(b) = self
            .block_buffer
            .iter_mut()
            .rev()
            .find(|b| b.block_id == block_id)
        {
            b.text.push_str(chunk);
            return;
        }
        self.block_buffer.push(BufBlock {
            text: accumulated.to_string(),
            streaming: true,
            ..BufBlock::new(block_id, BlockKind::Assistant)
        });
        self.trim_block_buffer();
    }

    /// Close a streaming assistant block: final text, streaming off. Returns the
    /// finalized block so the caller can persist it (durable-sessions FR-2).
    /// Falls back to an append when no streaming block exists — a stop with no
    /// deltas at all, which must still buffer whatever text it carries.
    fn finish_assistant(&mut self, block_id: &str, text: String) -> Option<BufBlock> {
        let out = match self
            .block_buffer
            .iter_mut()
            .rev()
            .find(|b| b.block_id == block_id)
        {
            Some(b) => {
                b.text = text;
                b.streaming = false;
                Some(b.clone())
            }
            None => {
                self.buf_assistant(block_id, text);
                self.block_buffer.last().cloned()
            }
        };
        // transcript-scale FR-2: settling this block may unblock an eviction
        // that was pinned on it (the None arm already trims via buf_assistant;
        // trimming again here is a cheap no-op in that case).
        self.trim_block_buffer();
        out
    }

    /// `model` is the one a subagent dispatch named (None ⇒ inherited, or not a
    /// dispatch at all); it rides the Subagent block's `text` per the field reuse
    /// documented on `BufBlock`, which also gets it persisted for free.
    fn buf_tool(
        &mut self,
        block_id: &str,
        tool: String,
        summary: String,
        is_task: bool,
        model: Option<String>,
    ) {
        let kind = if is_task {
            BlockKind::Subagent
        } else {
            BlockKind::Tool
        };
        self.block_buffer.push(BufBlock {
            tool,
            summary,
            text: if is_task {
                model.unwrap_or_default()
            } else {
                String::new()
            },
            streaming: true,
            ..BufBlock::new(block_id, kind)
        });
        self.trim_block_buffer();
    }

    /// interactive-commands FR-6: append a pending command block (loading card).
    fn buf_command_pending(&mut self, block_id: &str, command: &str) {
        self.block_buffer.push(BufBlock {
            tool: command.into(),
            streaming: true,
            ..BufBlock::new(block_id, BlockKind::Command)
        });
        self.trim_block_buffer();
    }

    /// interactive-commands FR-9/20: finalize the pending command block in place, or
    /// append a finalized one when the flow had no command.started (instant cards).
    /// Returns the finalized block so the caller can persist it — transcript-scale
    /// FR-2: the clone MUST be taken before `trim_block_buffer` runs below, because
    /// finalizing is exactly what can settle a block that was itself pinning
    /// eviction (a settled block over cap is evicted immediately); re-`find`ing by
    /// id after the trim would return `None` for that block and lose it from the
    /// persisted transcript entirely.
    fn buf_command_output(
        &mut self,
        block_id: &str,
        command: &str,
        card: Value,
    ) -> Option<BufBlock> {
        let out = match self
            .block_buffer
            .iter_mut()
            .find(|b| b.block_id == block_id)
        {
            Some(b) => {
                b.card = Some(card);
                b.streaming = false;
                Some(b.clone())
            }
            None => {
                let block = BufBlock {
                    tool: command.into(),
                    card: Some(card),
                    ..BufBlock::new(block_id, BlockKind::Command)
                };
                self.block_buffer.push(block.clone());
                Some(block)
            }
        };
        self.trim_block_buffer();
        out
    }

    /// session-questions FR-6: append a pending question block. `card` reuse: for
    /// Question blocks it holds `{ questions, state, answers? }`.
    fn buf_question(&mut self, block_id: &str, questions: Value) {
        self.block_buffer.push(BufBlock {
            card: Some(serde_json::json!({ "questions": questions, "state": "pending" })),
            streaming: true,
            ..BufBlock::new(block_id, BlockKind::Question)
        });
        self.trim_block_buffer();
    }

    /// session-questions FR-11/FR-13: flip a question block to its resolved state
    /// in place. Returns the updated block (for persistence) or None if unknown.
    fn buf_question_resolve(
        &mut self,
        block_id: &str,
        state: &str,
        answers: Option<&Value>,
    ) -> Option<BufBlock> {
        let b = self
            .block_buffer
            .iter_mut()
            .find(|b| b.block_id == block_id && b.kind == BlockKind::Question)?;
        if let Some(card) = b.card.as_mut() {
            card["state"] = Value::String(state.into());
            if let Some(a) = answers {
                card["answers"] = a.clone();
            }
        }
        b.streaming = false;
        let out = b.clone();
        // transcript-scale FR-2: this ask may have been the block pinning
        // eviction — resolving it can now let the buffer return to the cap.
        self.trim_block_buffer();
        Some(out)
    }

    /// permission-guardrails FR-2: append a pending permission block. `card`
    /// reuse (as for Question blocks): it holds `{ ask, state, rule? }`.
    fn buf_permission(&mut self, block_id: &str, ask: Value) {
        self.block_buffer.push(BufBlock {
            card: Some(serde_json::json!({ "ask": ask, "state": "pending" })),
            streaming: true,
            ..BufBlock::new(block_id, BlockKind::Permission)
        });
        self.trim_block_buffer();
    }

    /// permission-guardrails FR-8/FR-10: flip a permission block to its resolved
    /// state in place. Returns the updated block (for persistence) or None if
    /// unknown.
    fn buf_permission_resolve(
        &mut self,
        block_id: &str,
        state: &str,
        rule: Option<&Value>,
    ) -> Option<BufBlock> {
        let b = self
            .block_buffer
            .iter_mut()
            .find(|b| b.block_id == block_id && b.kind == BlockKind::Permission)?;
        if let Some(card) = b.card.as_mut() {
            card["state"] = Value::String(state.into());
            if let Some(r) = rule {
                card["rule"] = r.clone();
            }
        }
        b.streaming = false;
        let out = b.clone();
        // transcript-scale FR-2: same rationale as buf_question_resolve above.
        self.trim_block_buffer();
        Some(out)
    }

    /// interactive-commands FR-11: reserve the single in-flight probe slot.
    /// Returns the (still empty) child slot, or None if a probe is already pending.
    fn reserve_probe(&mut self, block_id: &str) -> Option<Arc<Mutex<Option<Child>>>> {
        if self.pending_probe.is_some() {
            return None;
        }
        let child = Arc::new(Mutex::new(None));
        self.pending_probe = Some(ProbeHandle {
            block_id: block_id.into(),
            child: child.clone(),
        });
        Some(child)
    }

    /// Returns the finalized block so the caller can persist it — same
    /// transcript-scale FR-2 rationale as `buf_command_output`: the clone is
    /// taken BEFORE `trim_block_buffer` runs, so a tool/subagent block that was
    /// itself pinning eviction is never evicted before its caller can persist it.
    ///
    /// `has_detail`: command-inspect FR-1/FR-10 — the caller must have already
    /// written the `StepDetail` sidecar record (if any) BEFORE calling this, so
    /// the finalized block and the `tool.done` event it feeds both carry the
    /// right flag on the FIRST — and only — line ever persisted for it.
    fn buf_tool_done(
        &mut self,
        block_id: &str,
        meta: String,
        has_detail: bool,
    ) -> Option<BufBlock> {
        let out = self
            .block_buffer
            .iter_mut()
            .find(|b| b.block_id == block_id)
            .map(|b| {
                b.meta = Some(meta);
                b.streaming = false;
                b.has_detail = has_detail;
                b.clone()
            });
        // transcript-scale FR-2: settling this tool/subagent block may unblock
        // an eviction pinned on it.
        self.trim_block_buffer();
        out
    }

    fn insert_agent(&mut self, a: AgentInfo) {
        if !self.agents.contains_key(&a.id) {
            self.agent_order.push(a.id.clone());
        }
        self.agents.insert(a.id.clone(), a);
    }
}

#[derive(Default)]
pub struct Engine {
    sessions: Mutex<HashMap<String, Session>>,
    /// workflow-details §6: run id → the incremental scan state of its run
    /// directory (per-file byte offsets + running aggregates, FR-5) and the
    /// `notify` watcher keeping it live (FR-6). Dropping an entry stops the
    /// watch. None of it is serialized.
    workflow_scans: Mutex<HashMap<String, ScanEntry>>,
    /// workflow-details FR-20..FR-26: run id → the asks currently attributed to
    /// it. ADDITIVE — the ask itself stays in the turn's `pending_questions` /
    /// `pending_permissions` map, keyed by the same blockId, and is still
    /// resolved by the existing commands under the existing exactly-once claim.
    workflow_asks: Mutex<HashMap<String, Vec<WorkflowPendingAsk>>>,
}

impl Engine {
    /// §8 dedup: the mechanical shape behind ~78 call sites —
    /// `app.state::<Engine>(); engine.sessions.lock().unwrap(); map.get_mut(id)`
    /// — collapsed into one helper. Locks, hands `f` the session, unlocks, returns
    /// what `f` returned; `None` when no such session exists.
    ///
    /// ONLY for the single-session, nothing-else-while-locked shape: `f` must not
    /// itself touch `Engine.sessions` (no reentrant locking), must not block, and
    /// must not emit — see the file-wide lock discipline documented on
    /// `TurnHandle`. A site that needs to do more than that while holding the
    /// session (iterate every session, take a second lock, emit, spawn a thread,
    /// …) does not fit this helper; leave it as a direct `.sessions.lock()`.
    pub(crate) fn with_session_mut<T>(
        &self,
        session_id: &str,
        f: impl FnOnce(&mut Session) -> T,
    ) -> Option<T> {
        let mut map = self.sessions.lock().unwrap();
        map.get_mut(session_id).map(f)
    }

    /// Read-only counterpart of `with_session_mut`, for sites that only read the
    /// session (same single-session, nothing-else-while-locked constraint).
    pub(crate) fn with_session<T>(
        &self,
        session_id: &str,
        f: impl FnOnce(&Session) -> T,
    ) -> Option<T> {
        let map = self.sessions.lock().unwrap();
        map.get(session_id).map(f)
    }

    /// The working directory of a session (used by the `diff` domain, FR-1). None if unknown.
    pub fn cwd_of(&self, session_id: &str) -> Option<String> {
        self.with_session(session_id, |s| s.cwd.clone())
    }

    /// projects FR-9: clear `project_id` on every session that referenced the
    /// removed project. Returns the fresh meta of each session that changed — one
    /// `session.meta` emission each. Nothing under the project's root is touched;
    /// the sessions themselves keep running, merely unlinked (§7 #15).
    pub(crate) fn clear_project(&self, project_id: &str) -> Vec<SessionMeta> {
        let mut map = self.sessions.lock().unwrap();
        map.values_mut()
            .filter(|s| s.project_id.as_deref() == Some(project_id))
            .map(|s| {
                s.project_id = None;
                s.meta()
            })
            .collect()
    }

    /// remote-control: everything the Remote Control host needs to spawn, in one
    /// lock — `(cwd, runtime, name, claudeSessionId, worktreeDistro)`. The name is
    /// the default remote session title; the claude session id (when present) is
    /// what lets the host resume the REAL thread, so the phone continues the same
    /// conversation. `worktreeDistro` (session-worktree FR-10) is the stored
    /// `GitHost`/distro to route the spawn to when this session runs in a WSL
    /// worktree, rather than re-deriving it from `cwd`.
    #[allow(clippy::type_complexity)]
    pub(crate) fn remote_target_of(
        &self,
        session_id: &str,
    ) -> Option<(
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
    )> {
        self.with_session(session_id, |s| {
            (
                s.cwd.clone(),
                s.runtime.clone(),
                s.name.clone(),
                s.claude_session_id.clone(),
                s.worktree_distro.clone(),
                // multi-account FR-21: the host spawns under the session's account.
                s.account_id.clone(),
            )
        })
    }

    /// The claude runtime ("native" | "wsl") of a session — used by the `shell`
    /// domain's per-session spawn matrix (wsl-filesystem FR-10/FR-11). None if unknown.
    pub fn runtime_of(&self, session_id: &str) -> Option<String> {
        self.with_session(session_id, |s| s.runtime.clone())
    }

    /// multi-account FR-21: the account a session's spawns run under — read by
    /// the `shell` domain, so a hand-typed `claude` in the SHELL tab matches the
    /// session it belongs to. None if unknown.
    pub fn account_of(&self, session_id: &str) -> Option<String> {
        self.with_session(session_id, |s| s.account_id.clone())
    }

    /// multi-account FR-9: repoint every session bound to the removed account
    /// onto `default`. Returns the fresh meta of each session that changed — one
    /// `session.meta` emission each. The sessions keep running; only their NEXT
    /// turn spawns on `default` (§7).
    pub(crate) fn clear_account(&self, account_id: &str) -> Vec<SessionMeta> {
        let mut map = self.sessions.lock().unwrap();
        map.values_mut()
            .filter(|s| s.account_id == account_id)
            .map(|s| {
                s.account_id = crate::account::DEFAULT_ACCOUNT_ID.to_string();
                s.meta()
            })
            .collect()
    }

    /// self-update FR-12: how many sessions are mid-turn. Read by
    /// `update::app_apply_update` BEFORE it touches the update state, so the two
    /// locks are never held together (see the LOCK ORDER note in update/mod.rs).
    pub fn running_count(&self) -> usize {
        self.sessions
            .lock()
            .unwrap()
            .values()
            // Parked sessions count: an update that restarts the app under a turn
            // waiting on an approval loses that turn just as surely as one that
            // restarts under a streaming turn.
            .filter(|s| status::is_busy(&s.status))
            .count()
    }

    /// multi-account FR-29: every account with at least one live session — the
    /// background usage tick probes exactly these, plus the isDefault account,
    /// and never an account with no sessions at all.
    pub fn live_account_ids(&self) -> Vec<String> {
        let map = self.sessions.lock().unwrap();
        let mut out: Vec<String> = Vec::new();
        for s in map.values() {
            if !out.contains(&s.account_id) {
                out.push(s.account_id.clone());
            }
        }
        out
    }
}

/// Kill every in-flight turn's child process (called on app exit).
pub fn kill_all(app: &AppHandle) {
    let Some(engine) = app.try_state::<Engine>() else {
        return;
    };
    // session-questions FR-13 (app-exit teardown, §7#5): drain every parked
    // question BEFORE killing its child, so the cancelled state is persisted
    // synchronously here — the reader threads may never get to run again. The
    // drain is the exactly-once claim; a reader that does run finds nothing.
    let mut orphaned: Vec<(String, String)> = Vec::new(); // (session_id, block_id)
    let mut orphaned_perms: Vec<(String, String)> = Vec::new(); // permission-guardrails FR-10
    {
        let map = engine.sessions.lock().unwrap();
        for s in map.values() {
            if let Some(turn) = &s.current {
                // multi-provider-seam FR-2/FR-8: reached only through
                // TurnControl — `drain_pending` is the exactly-once claim,
                // synchronous and under this same lock, exactly as the direct
                // map drains used to be.
                turn.interrupt();
                let (qs, perms) = turn.drain_pending();
                orphaned.extend(qs.into_iter().map(|bid| (s.id.clone(), bid)));
                orphaned_perms.extend(perms.into_iter().map(|bid| (s.id.clone(), bid)));
                turn.kill();
            }
            if let Some(p) = &s.pending_probe {
                p.kill(); // interactive-commands: probes die with the app
            }
        }
    }
    for (sid, bid) in orphaned {
        resolve_question(app, &sid, &bid, "cancelled", None);
    }
    for (sid, bid) in orphaned_perms {
        resolve_permission(app, &sid, &bid, "cancelled", None);
    }
    // workflow-details FR-6: no watch outlives the app. Dropped AFTER the drains
    // above, so their `workflow.detail` flushes still find their run.
    stop_all_workflow_watches(&engine);
}

// ---------- helpers ----------

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// session-rename FR-1 step 1+2: strip every C0/C1 control character (so a pasted
/// newline or tab can never reach `sessions.json` or a tab label), then trim.
/// Split out from the validator so `session_create` can ask "is this blank?"
/// without turning the blank case into an error (FR-2).
pub(crate) fn clean_session_name(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control() && !('\u{80}'..='\u{9f}').contains(c))
        .collect::<String>()
        .trim()
        .to_string()
}

/// session-rename FR-1: THE session-name validator, shared by `session_create`
/// (FR-2) and `session_rename` (FR-3). Cleans, then rejects an empty result or
/// one over 80 Unicode scalar values — counted in `chars()`, never bytes, so an
/// 80-emoji name is as valid as an 80-ascii one. All other Unicode is allowed.
pub(crate) fn validate_session_name(raw: &str) -> Result<String, (&'static str, &'static str)> {
    let name = clean_session_name(raw);
    if name.is_empty() {
        return Err(("INVALID_INPUT", "session name cannot be empty"));
    }
    if name.chars().count() > 80 {
        return Err(("INVALID_INPUT", "session name cannot exceed 80 characters"));
    }
    Ok(name)
}

fn basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::{test_engine_with, test_session};

    // ---------- session-rename FR-1: the shared name validator ----------

    #[test]
    fn name_validator_strips_control_characters_and_trims() {
        assert_eq!(
            validate_session_name("  api\n refactor\t ").unwrap(),
            "api refactor"
        );
        assert_eq!(validate_session_name("\u{7f}a\u{9f}b\r\n").unwrap(), "ab");
        // Stripping happens BEFORE the trim, so a control-only fringe still trims.
        assert_eq!(validate_session_name("\u{1}\u{2} x \u{3}").unwrap(), "x");
    }

    #[test]
    fn name_validator_rejects_an_empty_result() {
        for raw in ["", "   ", "\n\t\r", "\u{1}\u{9f}"] {
            let (code, msg) = validate_session_name(raw).unwrap_err();
            assert_eq!(code, "INVALID_INPUT");
            assert_eq!(msg, "session name cannot be empty");
        }
    }

    #[test]
    fn name_validator_caps_at_eighty_scalar_values() {
        let eighty = "é".repeat(80); // 160 bytes, 80 chars — accepted
        assert_eq!(validate_session_name(&eighty).unwrap(), eighty);

        let (code, msg) = validate_session_name(&"a".repeat(81)).unwrap_err();
        assert_eq!(code, "INVALID_INPUT");
        assert_eq!(msg, "session name cannot exceed 80 characters");

        // The cap applies to the CLEANED name: 81 chars of padding trims to 79.
        assert_eq!(
            validate_session_name(&format!("  {}  ", "a".repeat(79)))
                .unwrap()
                .chars()
                .count(),
            79
        );
    }

    #[test]
    fn name_validator_allows_all_other_unicode() {
        for raw in ["café ☕", "セッション", "🚀 ship it"] {
            assert_eq!(validate_session_name(raw).unwrap(), raw);
        }
    }

    #[test]
    fn subagent_tool_recognizes_task_and_agent() {
        assert!(is_subagent_tool("Task"));
        assert!(is_subagent_tool("Agent")); // this harness's subagent tool name
        assert!(!is_subagent_tool("Read"));
        assert!(!is_subagent_tool("Bash"));
    }

    #[test]
    fn with_session_mut_locks_mutates_and_returns_the_closure_value() {
        let engine = test_engine_with(test_session());
        let out = engine.with_session_mut("s1", |s| {
            s.name = "renamed".into();
            s.name.clone()
        });
        assert_eq!(out, Some("renamed".to_string()));
        assert_eq!(
            engine.with_session("s1", |s| s.name.clone()),
            Some("renamed".to_string())
        );
    }

    #[test]
    fn with_session_mut_and_with_session_are_none_for_unknown_id() {
        let engine = test_engine_with(test_session());
        assert_eq!(engine.with_session_mut("nope", |s| s.name.clone()), None);
        assert_eq!(engine.with_session("nope", |s| s.name.clone()), None);
    }

    // self-update FR-12: only `running` counts — an idle, done or errored
    // session is not work in flight and must not block an update.
    #[test]
    fn running_count_counts_only_mid_turn_sessions() {
        let engine = test_engine_with(test_session());
        assert_eq!(engine.running_count(), 0); // the fixture is idle
        engine.with_session_mut("s1", |s| s.status = "running".into());
        assert_eq!(engine.running_count(), 1);
        engine.with_session_mut("s1", |s| s.status = "error".into());
        assert_eq!(engine.running_count(), 0);
    }

    // ---------- transcript-scale FR-1/FR-2: bounded block_buffer ----------
    // `trim_transcript` itself (evict-from-head / noop-under-cap / stops-at-
    // unsettled-head) is unit-tested in transcript_cap.rs, next to the function
    // it covers. What's left here exercises Session's own buf_* methods, which
    // live in this file.

    #[test]
    fn appending_past_the_cap_evicts_from_the_session_buffer() {
        let mut s = test_session();
        for i in 0..(TRANSCRIPT_BUFFER_CAP + 10) {
            s.buf_user(&format!("b{i}"), "hi".into());
        }
        assert_eq!(s.block_buffer.len(), TRANSCRIPT_BUFFER_CAP);
        assert!(s.transcript_truncated);
        assert_eq!(s.block_buffer[0].block_id, "b10");
    }

    #[test]
    fn a_parked_permission_older_than_the_cap_survives_eviction_and_the_buffer_returns_to_the_cap_on_resolve(
    ) {
        let mut s = test_session();
        s.buf_permission("ask-1", serde_json::json!({ "tool": "Bash" }));
        for i in 0..(TRANSCRIPT_BUFFER_CAP + 20) {
            s.buf_user(&format!("b{i}"), "hi".into());
        }
        // The parked ask pins eviction: the buffer exceeds the cap and the ask
        // is still first (and still resolvable).
        assert!(s.block_buffer.len() > TRANSCRIPT_BUFFER_CAP);
        assert_eq!(s.block_buffer[0].block_id, "ask-1");

        let resolved = s.buf_permission_resolve("ask-1", "allowed", None);
        assert!(resolved.is_some());
        // Resolving it lets the buffer catch back up to the cap — the now-settled
        // ask is itself evictable like any other block once it's no longer parked.
        assert_eq!(s.block_buffer.len(), TRANSCRIPT_BUFFER_CAP);
        assert_eq!(s.block_buffer[0].block_id, "b20");
    }

    // Regression for the transcript-scale CRITICAL fix: `buf_tool_done` and
    // `buf_command_output` must return the finalized block even though
    // finalizing it is exactly what can unpin — and immediately evict — it.
    // Before the fix, callers re-`find`-by-id AFTER the mutator returned and
    // got `None` for precisely this case, silently dropping the block from the
    // persisted transcript.

    #[test]
    fn finishing_the_pinning_tool_block_still_returns_it_for_persistence() {
        let mut s = test_session();
        s.buf_tool("tool-1", "Bash".into(), "ls".into(), false, None);
        for i in 0..(TRANSCRIPT_BUFFER_CAP + 20) {
            s.buf_user(&format!("b{i}"), "hi".into());
        }
        // The still-running tool call pins eviction at the head.
        assert!(s.block_buffer.len() > TRANSCRIPT_BUFFER_CAP);
        assert_eq!(s.block_buffer[0].block_id, "tool-1");

        let done = s.buf_tool_done("tool-1", "3 lines".into(), false);
        assert_eq!(done.as_ref().map(|b| b.block_id.as_str()), Some("tool-1"));
        assert_eq!(done.unwrap().meta.as_deref(), Some("3 lines"));
        // Settling it unpins eviction, which catches back up to the cap in the
        // SAME call — the returned clone was captured before that happened.
        assert_eq!(s.block_buffer.len(), TRANSCRIPT_BUFFER_CAP);
        assert_eq!(s.block_buffer[0].block_id, "b20");
    }

    #[test]
    fn finishing_the_pinning_command_block_still_returns_it_for_persistence() {
        let mut s = test_session();
        s.buf_command_pending("cmd-1", "model");
        for i in 0..(TRANSCRIPT_BUFFER_CAP + 20) {
            s.buf_user(&format!("b{i}"), "hi".into());
        }
        assert!(s.block_buffer.len() > TRANSCRIPT_BUFFER_CAP);
        assert_eq!(s.block_buffer[0].block_id, "cmd-1");

        let done = s.buf_command_output(
            "cmd-1",
            "model",
            serde_json::json!({ "kind": "notice", "text": "model \u{2192} Opus" }),
        );
        assert_eq!(done.as_ref().map(|b| b.block_id.as_str()), Some("cmd-1"));
        assert_eq!(s.block_buffer.len(), TRANSCRIPT_BUFFER_CAP);
        assert_eq!(s.block_buffer[0].block_id, "b20");
    }
}
