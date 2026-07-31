// contract/common.ts — shared vocabulary for all Francois feature contracts.
// Feature contracts (contract/<feature-id>.ts) import from this file and never redefine these types.
// Specs reference these names verbatim.

// ---------- primitives ----------

export type SessionId = string; // uuid v4
export type AgentId = string; // uuid v4
export type BlockId = string; // uuid v4 — one conversation block (message, tool call, …)
/** uuid v4, or the reserved 'default' (the built-in account, multi-account FR-2). */
export type AccountId = string;

/** Every fallible IPC call resolves to this — never throws across IPC. */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppError };

export interface AppError {
  code: ErrorCode;
  message: string; // human-readable, safe to render
  detail?: unknown;
}

export type ErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_RUNNING'
  | 'SESSION_ALREADY_RUNNING'
  | 'SPAWN_FAILED'
  | 'INVALID_INPUT'
  | 'GIT_ERROR'
  | 'NOT_A_GIT_REPO'
  | 'PTY_ERROR'
  | 'MCP_ERROR'
  | 'SKILL_ERROR'
  | 'AGENT_NOT_FOUND'
  | 'APP_NOT_RUNNING' // CLI companion: no app instance to talk to
  | 'USAGE_UNAVAILABLE' // usage bar: the CLI ran but returned no parseable meters
  | 'QUESTION_NOT_PENDING' // session-questions: answer arrived for a question that is not pending
  | 'PERMISSION_NOT_PENDING' // permission-guardrails: decision arrived for an ask that is not pending
  | 'SETTINGS_WRITE_FAILED' // permission-guardrails: settings.json could not be read-merged-written
  | 'RULE_NOT_FOUND' // permission-guardrails: editor mutation addressed an unknown rule id
  | 'PROJECT_NOT_FOUND' // projects: a projectId that is not in the registry
  | 'PROJECT_DUPLICATE_ROOT' // projects: another project already owns that normalized root
  | 'PROJECT_ROOT_MISSING' // projects: the project's root no longer exists on disk
  | 'STANDARDS_WRITE_FAILED' // projects: CLAUDE.md could not be read-merged-written
  | 'REMOTE_CONTROL_FAILED' // remote-control: the host process died, or published no URL before the deadline
  | 'WORKTREE_BRANCH_IN_USE' // session-worktree: the branch is already checked out at another path (detail: { path })
  | 'WORKTREE_CREATE_FAILED' // session-worktree: prune/add failed; the core reversed what it did (FR-11)
  | 'WORKTREE_DIRTY' // session-worktree: removal refused: uncommitted changes or unpushed commits (FR-19)
  | 'WORKTREE_NOT_FOUND' // session-worktree: no worktree registered at that path
  | 'ATTACHMENT_TOO_LARGE' // session-attachments FR-8: over the 10 MiB cap (detail: { bytes, cap })
  | 'ATTACHMENT_IS_DIRECTORY' // session-attachments FR-8: folders are refused, not walked
  | 'ATTACHMENT_NOT_FOUND' // session-attachments: release addressed an unknown attachment id
  | 'ATTACHMENT_IO_FAILED' // session-attachments: copy/write/delete failed (detail: { path })
  | 'ACCOUNT_NOT_FOUND' // multi-account: an accountId that is not in the registry
  | 'ACCOUNT_NOT_REMOVABLE' // multi-account: attempted removal of the built-in 'default' account
  | 'ACCOUNT_DUPLICATE' // multi-account: login identity matches an already-registered account (FR-14)
  | 'ACCOUNT_LOGIN_FAILED' // multi-account: login timed out or the PTY exited without an identity (FR-15)
  | 'ACCOUNT_NOT_AUTHENTICATED' // multi-account: a turn's account has no credentials on disk (FR-22)
  | 'UPDATE_CHECK_FAILED' // self-update: the npm registry was unreachable or unparseable (FR-6)
  | 'UPDATE_APPLY_FAILED' // self-update: npm/temp dir/spawn failed, or method is 'manual' (FR-18)
  | 'UPDATE_BLOCKED' // self-update: sessions are running (detail: { running: number }) (FR-12)
  | 'INTERNAL';

// ---------- sessions ----------

export type SessionStatus = 'running' | 'idle' | 'done' | 'error';

/**
 * Permission mode a session's claude turns run with (`claude --permission-mode`).
 * 'default' passes NO flag — the turn inherits the user's own ~/.claude settings
 * (permissions.defaultMode / allow rules), which is the pre-feature behavior.
 * The CLI's `auto`/`dontAsk` modes are deliberately not offered: `auto` aborts
 * headless (-p) runs on repeated classifier blocks, `dontAsk` needs a paired
 * allowedTools list.
 */
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';

/** Where the claude CLI runs for a session: natively, or inside WSL (Windows only). */
export type ClaudeRuntime = 'native' | 'wsl';

export interface ModelInfo {
  id: string; // e.g. 'claude-sonnet-5'
  label: string; // display label, e.g. 'Sonnet 5'
  /** short factual summary derived from /v1/models (context/output/capabilities). */
  brief?: string;
  /** max input tokens (real context window) from /v1/models. */
  contextTokens?: number;
  /** effort levels this model supports, subset of low/medium/high/xhigh/max (empty = none). */
  efforts?: string[];
}

export interface SessionMeta {
  id: SessionId;
  name: string; // defaults to basename(cwd)
  cwd: string; // absolute path
  model: ModelInfo;
  status: SessionStatus;
  contextUsedTokens: number;
  contextLimitTokens: number;
  startedAt: number; // epoch ms
  lastActivityAt: number; // epoch ms
  errorMessage?: string; // set when status === 'error'
  /** Permission mode for this session's turns; 'default' = inherit ~/.claude settings. */
  permissionMode: PermissionMode;
  /** CLI runtime for this session; 'wsl' spawns `wsl.exe -- claude …` (Windows only). */
  runtime: ClaudeRuntime;
  /**
   * The project this session was created under; absent when unlinked (projects FR-18).
   * Set at creation ONLY — editing a project's defaults never changes a session
   * (projects FR-24). Cleared, with a session.meta emission, when that project is
   * removed (projects FR-9). A persisted value that no longer resolves to a registry
   * entry is dropped on load.
   */
  projectId?: ProjectId;
  /** Present ⇔ this session runs in a Francois-created or Francois-adopted git worktree. */
  worktree?: SessionWorktree;
  /**
   * The account this session's every claude spawn runs under (multi-account FR-19/FR-21).
   * Set at creation ONLY — never re-derived or changed afterwards, except when the account
   * is removed (FR-9) or a persisted value no longer resolves (FR-10), both of which fall
   * back to 'default'. Required: persisted sessions without it load as 'default'.
   */
  accountId: AccountId;
}

/** Worktree provenance for a session created with isolation (session-worktree FR-12). */
export interface SessionWorktree {
  branch: string; // the checked-out branch, verbatim
  baseRef: string; // the ref it was forked from; echoed verbatim, ignored when createdBranch is false
  path: string; // absolute worktree path, in the HOST's dialect (FR-10)
  sourceRepoRoot: string; // absolute root of the repo this tree belongs to, host dialect
  createdBranch: boolean; // false ⇒ the branch already existed, or the tree was adopted (FR-5)
  fetched: boolean; // a fetch ran and succeeded (FR-7)
  fetchError?: string; // one-line reason; absent when fetched, or when there is no remote
}

// ---------- projects ----------

export type ProjectId = string; // uuid v4

/**
 * Session settings a project pre-fills into the new-session modal (projects §5.1).
 * Every field is optional: an absent field means "inherit" — the modal keeps its
 * pre-feature default for that control. Defaults are a SNAPSHOT — they are copied onto
 * the session at creation and never re-applied afterwards (projects FR-24).
 */
export interface ProjectDefaults {
  modelId?: string;
  /** low | medium | high | xhigh | max — nominally one the chosen model advertises. */
  effort?: string;
  permissionMode?: PermissionMode;
  runtime?: ClaudeRuntime;
  allowGit?: boolean;
  /** A removed account falls back to the isDefault account in the modal (multi-account FR-20). */
  accountId?: AccountId;
}

// ---------- subagents ----------

export type AgentStatus = 'running' | 'idle' | 'done' | 'error';

export interface AgentInfo {
  id: AgentId;
  sessionId: SessionId;
  name: string; // e.g. 'test-writer'
  task: string; // one-line task description
  status: AgentStatus;
  /** epoch ms when the agent was first minted (real anchor for the elapsed timer). */
  startedAt: number;
  /** epoch ms when it reached done/error; absent while running (freezes the timer). */
  endedAt?: number;
  /**
   * true when the dispatch was asynchronous (async-agents FR-2). For these, the dispatch's
   * tool_result is a spawn ack and never sets `endedAt` (FR-5) — the elapsed clock keeps running.
   */
  background: boolean;
  /** Label of the newest AgentStep (async-agents FR-10); absent until the first step. */
  lastActivity?: string;
  /** Total steps ever observed for this agent — may exceed the 200-step trail window (FR-12). */
  stepCount: number;
}

// ---------- agent activity trail ----------
// async-agents §5: AgentStep rides on SessionEvent (agent.step), so it is shared
// vocabulary and lives here. contract/async-agents.ts re-exports it.

export type AgentStepKind =
  | 'text' // the subagent said something
  | 'tool' // the subagent called a tool
  | 'notice'; // lifecycle marker minted by the engine (dispatch / completion / kill / turn end)

export interface AgentStep {
  /** Strictly increasing per agent, starting at 1 — stable sort key and React key (FR-12). */
  seq: number;
  kind: AgentStepKind;
  /** epoch ms the step was observed. */
  at: number;
  /** Tool name for kind 'tool' (e.g. 'Read'); absent for the other kinds. */
  tool?: string;
  /** One line: tool summary, text excerpt, or notice text. Never empty. */
  label: string;
  /** kind 'tool' only: the derived meta once the step's tool_result arrived; absent while open. */
  meta?: string;
}

// ---------- workflows ----------
// workflow-panel §5: a run of the harness's `Workflow` tool — the multi-agent
// orchestration script the assistant dispatches during a turn. WorkflowRun rides
// on SessionEvent (workflow.update), so it is shared vocabulary and lives here.

export type WorkflowRunId = string; // uuid v4 — minted by the core, not the harness

export type WorkflowStatus = 'running' | 'done' | 'error';

/** One phase declared in the script's `meta.phases` block. */
export interface WorkflowPhaseInfo {
  title: string;
  /** The phase's one-line `detail`, when the script declared one. */
  detail?: string;
}

export interface WorkflowRun {
  id: WorkflowRunId;
  sessionId: SessionId;
  /** `meta.name` from the script — else the saved-workflow name, else the script file's stem. */
  name: string;
  /** `meta.description`; empty when the dispatch carried no script to read it from. */
  description: string;
  status: WorkflowStatus;
  /** epoch ms the dispatch was first seen (anchor for the elapsed timer). */
  startedAt: number;
  /** epoch ms it reached done/error; absent while running (freezes the timer). */
  endedAt?: number;
  /**
   * The phases the script declared, in order. Empty when the dispatch named a
   * saved workflow (no script text to parse) — the panel then shows none rather
   * than inventing progress the stream never reported.
   */
  phases: WorkflowPhaseInfo[];
  /** The harness run id (`wf_…`) parsed out of the dispatch ack; absent until it lands. */
  runId?: string;
  /** One line of the newest thing observed for this run (the ack, or the completion notice). */
  lastActivity?: string;
}

// ---------- MCP ----------

export type McpStatus = 'connected' | 'connecting' | 'error';

/** Which Claude Code config declares an MCP server (mirrors `claude mcp list` scopes). */
export type McpScope =
  | 'project' // <cwd>/.mcp.json (checked into the repo)
  | 'local' //  ~/.claude.json → projects[cwd].mcpServers (private to this machine)
  | 'user'; //  ~/.claude.json → top-level mcpServers (global)

export interface McpServerInfo {
  name: string;
  status: McpStatus;
  toolCount?: number; // present when connected
  errorMessage?: string; // present when status === 'error', e.g. 'timeout'
  scope?: McpScope; // config scope this server is declared in (absent for runtime-only updates)
}

// ---------- skills ----------

/** Where an invocable comes from. */
export type SkillScope =
  | 'project' // <cwd>/.claude/{skills,commands}
  | 'user' //   ~/.claude/{skills,commands}
  | 'plugin'; // an enabled (installed) or marketplace (available) plugin

/** SKILL.md skill vs. a slash-command markdown file — both invoked as /<name>. */
export type SkillKind = 'skill' | 'command';

export interface SkillInfo {
  name: string;
  description: string; // one-line purpose, e.g. 'read & parse PDFs'
  installed: boolean; // installed/active (✦) vs available-to-enable (◇)
  scope?: SkillScope; // where it was discovered
  kind?: SkillKind; // skill (SKILL.md) or command (*.md)
  pluginId?: string; // for plugin entries: '<plugin>@<marketplace>' (enabling target)
}

// ---------- interactive commands ----------
// Card payloads for slash-command responses rendered in the SESSION transcript.
// Emitted by the engine via the command.started / command.output events below;
// rendered by conversation-view as CommandConversationBlock
// (contract/interactive-commands.ts). Spec: specs/interactive-commands.md §5.

/** One plan-limit meter parsed from the CLI's /usage output. */
export interface UsageMeter {
  label: string; // e.g. 'Current session', 'Current week (all models)'
  percentUsed: number; // 0–100 integer
  resetsAt: string; // verbatim reset text, e.g. 'Jul 22, 5:29pm (Europe/Paris)'
}

export interface HelpEntry {
  command: string; // without the leading '/', e.g. 'usage'
  description: string;
}

export type CommandCard =
  /** /usage & /cost, parsed. meters non-empty; tail = remaining lines, preformatted. */
  | { kind: 'usage'; command: 'usage' | 'cost'; meters: UsageMeter[]; tail: string }
  /** /context. percentUsed/usedLabel/limitLabel null when the tokens line didn't parse. */
  | {
      kind: 'context';
      percentUsed: number | null;
      usedLabel: string | null; // e.g. '26.4k'
      limitLabel: string | null; // e.g. '200k'
      body: string; // normalized markdown, preformatted
    }
  /** /model bare. currentId is a snapshot; the live marker derives from SessionMeta. */
  | { kind: 'model'; models: ModelInfo[]; currentId: string }
  /** /status. */
  | { kind: 'status'; meta: SessionMeta }
  /** /help. */
  | { kind: 'help'; entries: HelpEntry[] }
  /** Dim one-liner: unknown command, unavailable command, probe failure, model switch ack. */
  | { kind: 'notice'; text: string }
  /** Generic CLI-local output that fits no richer card. */
  | { kind: 'text'; command: string; text: string };

// ---------- session questions ----------
// Shared vocabulary for session-questions (the SessionEvent union below needs
// these, and this file never imports from feature files — spec §5.3 placement
// rule). contract/session-questions.ts re-exports them. Shapes mirror the CLI's
// AskUserQuestion tool input verbatim.

export interface QuestionOption {
  label: string; // display text, also the canonical answer value
  description: string; // what choosing it means
  preview?: string; // optional monospace preview content
}

export interface SessionQuestion {
  question: string; // full question text — also the key in the answers map
  header: string; // short chip label (nominally ≤ 12 chars; render verbatim)
  options: QuestionOption[]; // 2–4 in practice; render whatever arrives
  multiSelect: boolean; // true → answers joined with ', '
}

// ---------- permission guardrails ----------
// Shared vocabulary for permission-guardrails (the SessionEvent union below
// needs both types — same placement rule as SessionQuestion).
// contract/permission-guardrails.ts re-exports them. Spec §5.2.

/** Where a permission rule is written. 'local' = <cwd>/.claude/settings.local.json. */
export type PermissionTier = 'local' | 'global';

/** The three effect buckets of Claude Code's `permissions` settings object. */
export type PermissionEffect = 'allow' | 'deny' | 'ask';

/** A gated tool call parked on the stdio control channel (FR-2..FR-5). */
export interface PermissionAsk {
  toolName: string; // verbatim from the control request, e.g. 'Bash'
  summary: string; // one-line human rendering (command / path / url); '' when none
  inputJson: string; // whole tool input, pretty JSON, truncated to 4000 chars
  cwd: string; // the session's working directory
  pattern: string; // the Claude rule an "always" decision would write, e.g. 'Bash(npm test:*)'
  patternLabel: string; // human reading of that pattern, e.g. 'npm test (any arguments)'
}

/** One permission rule as it exists on disk (FR-16/FR-17). */
export interface PermissionRule {
  id: string; // `${tier}|${effect}|${pattern}` — derived, never stored, stable across reads
  pattern: string; // raw Claude pattern
  effect: PermissionEffect;
  tier: PermissionTier;
  /** false ⇔ parked in the Francois-owned francois-permissions.json sidecar (FR-15). */
  enabled: boolean;
  label: string; // human reading of the pattern
}

// ---------- slash menu ----------
// Shared vocabulary for slash-menu (the SessionEvent union below needs it —
// same placement rule as SessionQuestion). contract/slash-menu.ts re-exports.

export type SlashCommandSource = 'builtin' | 'skill' | 'cli';

export interface SlashCommandInfo {
  name: string; // without the leading '/'; rendering adds it
  description: string; // '' when the source provides none (cli)
  source: SlashCommandSource;
  /** skill entries only: the SkillInfo scope, shown as the source tag. */
  scope?: 'project' | 'user' | 'plugin';
}

// ---------- session event stream ----------
// Emitted by session-engine on channel 'francois:session:event'.
// The session-engine spec is the authority on emission semantics; consumers
// (conversation-view, agents-panel, mcp-panel, sessions-sidebar, app-shell)
// must use these member names.

export type SessionEvent =
  | { type: 'session.meta'; meta: SessionMeta } // full snapshot (created/updated)
  | { type: 'session.status'; sessionId: SessionId; status: SessionStatus }
  | { type: 'session.removed'; sessionId: SessionId }
  | { type: 'message.user'; sessionId: SessionId; blockId: BlockId; text: string }
  | { type: 'assistant.delta'; sessionId: SessionId; blockId: BlockId; text: string } // streamed partial
  | { type: 'assistant.done'; sessionId: SessionId; blockId: BlockId }
  | { type: 'tool.start'; sessionId: SessionId; blockId: BlockId; tool: string; summary: string } // e.g. tool 'Read', summary 'src/auth/middleware.ts'
  | { type: 'tool.done'; sessionId: SessionId; blockId: BlockId; meta: string } // e.g. '128 lines', '+34 −19'
  | { type: 'command.started'; sessionId: SessionId; blockId: BlockId; command: string } // interactive-commands: side-spawn began (loading card)
  | { type: 'command.output'; sessionId: SessionId; blockId: BlockId; card: CommandCard } // interactive-commands: card ready (creates or finalizes the block)
  | { type: 'question.asked'; sessionId: SessionId; blockId: BlockId; questions: SessionQuestion[] } // session-questions FR-6: a question parked the turn
  | { type: 'question.resolved'; sessionId: SessionId; blockId: BlockId; state: 'answered' | 'cancelled'; answers?: Record<string, string> } // session-questions FR-11/13: exactly one per asked
  | { type: 'permission.asked'; sessionId: SessionId; blockId: BlockId; ask: PermissionAsk } // permission-guardrails FR-2: a gated tool call parked the turn
  | { type: 'permission.resolved'; sessionId: SessionId; blockId: BlockId; state: 'allowed' | 'denied' | 'cancelled'; rule?: PermissionRule } // permission-guardrails FR-8/10: exactly one per asked
  | { type: 'session.commands'; sessionId: SessionId; commands: SlashCommandInfo[] } // slash-menu FR-2: merged registry after an init changed the cli set
  | { type: 'agent.update'; agent: AgentInfo }
  | { type: 'agent.step'; sessionId: SessionId; agentId: AgentId; step: AgentStep } // async-agents FR-10: a trail step was appended, or an existing seq re-emitted with meta filled
  | { type: 'workflow.update'; run: WorkflowRun } // workflow-panel FR-3: a run was minted, acked, or reached a terminal state
  | { type: 'mcp.update'; sessionId: SessionId; server: McpServerInfo }
  | { type: 'context.usage'; sessionId: SessionId; usedTokens: number; limitTokens: number }
  | { type: 'session.resumeFailed'; sessionId: SessionId } // a --resume turn was rejected; the core continued on a fresh thread (durable-sessions FR-9/14)
  | { type: 'session.cleared'; sessionId: SessionId } // /clear: transcript wiped + context reset (full reset)
  | { type: 'session.error'; sessionId: SessionId; error: AppError };
