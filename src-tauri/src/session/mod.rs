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

mod agent_transcript;
mod agents;
mod attachments;
mod blocks;
mod commands;
mod control;
mod events;
mod interactive;
mod mcp;
mod models;
mod persistence;
mod remote;
mod remote_discovery;
mod skills;
mod slash;
mod spawn;
mod stdio;
mod stream;
mod tools;
mod turn;
mod usage_probe;
mod workflows;
mod worktree;

pub(crate) use agent_transcript::*;
pub(crate) use agents::*;
pub(crate) use attachments::*;
pub(crate) use blocks::*;
pub(crate) use commands::*;
pub(crate) use control::*;
pub(crate) use events::*;
pub(crate) use interactive::*;
pub(crate) use mcp::*;
pub(crate) use models::*;
pub(crate) use persistence::*;
pub(crate) use remote::*;
pub(crate) use remote_discovery::*;
pub(crate) use skills::*;
pub(crate) use slash::*;
pub(crate) use spawn::*;
pub(crate) use stdio::*;
pub(crate) use stream::*;
pub(crate) use tools::*;
pub(crate) use turn::*;
pub(crate) use usage_probe::*;
pub(crate) use workflows::*;
pub(crate) use worktree::*;

#[cfg(test)]
mod testutil;

// permission-guardrails: the settings.json / rule-pattern half of the feature
// lives in permissions.rs; this file owns only the control-channel wiring
// (parking an ask, writing the control_response) — spec §6.
use crate::permissions::PermissionAsk;
// usage-bar §6: the /usage meter grammar + stream-json answer extraction now live
// in usage.rs so the usage bar and this card path share ONE grammar. Behavior here
// is unchanged — these are the same functions, imported instead of defined.
use crate::usage::{parse_meter_line, probe_answer, synthetic_text, UsageMeter};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const EVENT_CHANNEL: &str = "francois://session/event";
/// agent-tab §5: the `agents` domain event stream (`agent.block`). Separate from
/// the session stream because AgentBlock builds on conversation-view's block
/// types while contract/common.ts (which owns SessionEvent) is import-free.
const AGENT_EVENT_CHANNEL: &str = "francois://agents/event";
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
    ask: PermissionAsk,
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
}

impl BufBlock {
    /// §8 dedup: every `buf_*` append (below) and `parse_persisted_block`
    /// (persistence.rs) built the same 8-field literal by hand, differing in
    /// only 2-4 fields each. This is the shared shape — `text`/`tool`/`summary`
    /// empty, `meta`/`card` absent, not streaming — callers override just what
    /// differs via `BufBlock { field: value, ..BufBlock::new(id, kind) }`.
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
        }
    }
}

pub(crate) struct TurnHandle {
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
    /// A sibling of `pending_questions` with the SAME claim-to-resolve discipline
    /// (FR-10) — kept separate because the two resolve to different events.
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
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
    runtime: String,         // contract ClaudeRuntime; "native" | "wsl"
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
    queue: VecDeque<(String, String)>, // (client blockId, text)
    claude_session_id: Option<String>,
    current: Option<TurnHandle>,
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
    // slash-menu FR-2: the CLI's slash_commands captured from the latest
    // stream-json init (bare names, init order). In-memory only — never
    // persisted; a fresh app relearns it on the next turn (spec §6).
    cli_commands: Vec<String>,
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
        claude_session_id: Option<String>,
        block_buffer: Vec<BufBlock>,
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
            runtime,
            allow_git,
            project_id,
            worktree,
            worktree_distro,
            account_id,
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
            attachments: Vec::new(),
            mcp: HashMap::new(),
            workflows: HashMap::new(),
            workflow_order: Vec::new(),
            workflow_by_tool: HashMap::new(),
            cli_commands: Vec::new(),
        }
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
            runtime: self.runtime.clone(),
            project_id: self.project_id.clone(),
            worktree: self.worktree.clone(),
            account_id: self.account_id.clone(),
        }
    }

    fn buf_user(&mut self, block_id: &str, text: String) {
        self.block_buffer.push(BufBlock {
            text,
            ..BufBlock::new(block_id, BlockKind::User)
        });
    }

    fn buf_assistant(&mut self, block_id: &str, text: String) {
        self.block_buffer.push(BufBlock {
            text,
            ..BufBlock::new(block_id, BlockKind::Assistant)
        });
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
    }

    /// interactive-commands FR-6: append a pending command block (loading card).
    fn buf_command_pending(&mut self, block_id: &str, command: &str) {
        self.block_buffer.push(BufBlock {
            tool: command.into(),
            streaming: true,
            ..BufBlock::new(block_id, BlockKind::Command)
        });
    }

    /// interactive-commands FR-9/20: finalize the pending command block in place, or
    /// append a finalized one when the flow had no command.started (instant cards).
    fn buf_command_output(&mut self, block_id: &str, command: &str, card: Value) {
        if let Some(b) = self
            .block_buffer
            .iter_mut()
            .find(|b| b.block_id == block_id)
        {
            b.card = Some(card);
            b.streaming = false;
        } else {
            self.block_buffer.push(BufBlock {
                tool: command.into(),
                card: Some(card),
                ..BufBlock::new(block_id, BlockKind::Command)
            });
        }
    }

    /// session-questions FR-6: append a pending question block. `card` reuse: for
    /// Question blocks it holds `{ questions, state, answers? }`.
    fn buf_question(&mut self, block_id: &str, questions: Value) {
        self.block_buffer.push(BufBlock {
            card: Some(serde_json::json!({ "questions": questions, "state": "pending" })),
            streaming: true,
            ..BufBlock::new(block_id, BlockKind::Question)
        });
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
        Some(b.clone())
    }

    /// permission-guardrails FR-2: append a pending permission block. `card`
    /// reuse (as for Question blocks): it holds `{ ask, state, rule? }`.
    fn buf_permission(&mut self, block_id: &str, ask: Value) {
        self.block_buffer.push(BufBlock {
            card: Some(serde_json::json!({ "ask": ask, "state": "pending" })),
            streaming: true,
            ..BufBlock::new(block_id, BlockKind::Permission)
        });
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
        Some(b.clone())
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

    fn buf_tool_done(&mut self, block_id: &str, meta: String) {
        if let Some(b) = self
            .block_buffer
            .iter_mut()
            .find(|b| b.block_id == block_id)
        {
            b.meta = Some(meta);
            b.streaming = false;
        }
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
                turn.interrupted.store(true, Ordering::SeqCst);
                {
                    let mut p = turn.pending_questions.lock().unwrap();
                    for (bid, _) in p.drain() {
                        orphaned.push((s.id.clone(), bid));
                    }
                }
                {
                    // permission-guardrails FR-10 (§7 #8): the same synchronous
                    // drain for parked approval cards.
                    let mut p = turn.pending_permissions.lock().unwrap();
                    for (bid, _) in p.drain() {
                        orphaned_perms.push((s.id.clone(), bid));
                    }
                }
                let _ = turn.child.lock().unwrap().kill();
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
}
