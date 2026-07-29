// contract/common.ts — shared vocabulary for all Francois feature contracts.
// Feature contracts (contract/<feature-id>.ts) import from this file and never redefine these types.
// Specs reference these names verbatim.

// ---------- primitives ----------

export type SessionId = string; // uuid v4
export type AgentId = string; // uuid v4
export type BlockId = string; // uuid v4 — one conversation block (message, tool call, …)

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
  | 'PLUGIN_NOT_FOUND' // plugin-system: pluginId is not in the registry
  | 'PLUGIN_ALREADY_INSTALLED' // plugin-system: manifest.id collides with an installed plugin (FR-2)
  | 'PLUGIN_MANIFEST_INVALID' // plugin-system: missing/unparseable/schema-violating manifest, or an unsafe tree (FR-1/6/7)
  | 'PLUGIN_SOURCE_UNREACHABLE' // plugin-system: clone/registry/tarball fetch failed, or integrity mismatch (FR-3/4)
  | 'PLUGIN_RUNTIME_ERROR' // plugin-system: the isolate threw, timed out, or blew a limit (FR-20)
  | 'PLUGIN_CONSENT_REQUIRED' // plugin-system: a widening update was applied without consented:true (FR-14)
  | 'PLUGIN_INJECTION_NOT_PENDING' // plugin-system: a decision arrived for a request that is not pending (FR-57)
  | 'PLUGIN_STORE_WRITE_FAILED' // plugin-system: plugins.json could not be written (FR-79)
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

// ---------- plugin system ----------
// Shared vocabulary for plugin-system (the SessionEvent union below needs
// PluginInjectionRequest/PluginInjectionState, and MessageOrigin rides on
// message.user — and common.ts never imports from feature files, the same
// placement rule session-questions §5.3 and permission-guardrails use).
// contract/plugin-system.ts re-exports them. Spec: specs/plugin-system.md §5.1.

/** Why a user message exists when the human did not type it (plugin-system FR-58). */
export interface MessageOrigin {
  kind: 'plugin';
  pluginId: string;
  /** manifest.name at send time — a snapshot, so attribution survives uninstall. */
  pluginName: string;
}

/**
 * A plugin's REQUEST to send a prompt into a session (plugin-system FR-53).
 * Minting one sends nothing: every injection is confirmed by a human.
 */
export interface PluginInjectionRequest {
  requestId: string; // uuid v4
  pluginId: string;
  pluginName: string;
  sessionId: SessionId;
  /** The EXACT text that would be sent. Trimmed, ≤ 8000 chars, control chars stripped (FR-54). */
  prompt: string;
  requestedAt: number; // epoch ms
  expiresAt: number; // epoch ms — requestedAt + 600_000 (FR-55)
}

export type PluginInjectionState = 'approved' | 'denied' | 'expired';

// ---------- session event stream ----------
// Emitted by session-engine on channel 'francois:session:event'.
// The session-engine spec is the authority on emission semantics; consumers
// (conversation-view, agents-panel, mcp-panel, sessions-sidebar, app-shell)
// must use these member names.

export type SessionEvent =
  | { type: 'session.meta'; meta: SessionMeta } // full snapshot (created/updated)
  | { type: 'session.status'; sessionId: SessionId; status: SessionStatus }
  | { type: 'session.removed'; sessionId: SessionId }
  | { type: 'message.user'; sessionId: SessionId; blockId: BlockId; text: string; origin?: MessageOrigin } // plugin-system FR-58: origin set iff an approved plugin injection produced it
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
  | { type: 'plugin.injection.asked'; sessionId: SessionId; blockId: BlockId; request: PluginInjectionRequest } // plugin-system FR-53: a plugin asked to send a prompt into this session
  | { type: 'plugin.injection.resolved'; sessionId: SessionId; blockId: BlockId; state: PluginInjectionState } // plugin-system FR-55/57: exactly one per asked
  | { type: 'session.commands'; sessionId: SessionId; commands: SlashCommandInfo[] } // slash-menu FR-2: merged registry after an init changed the cli set
  | { type: 'agent.update'; agent: AgentInfo }
  | { type: 'agent.step'; sessionId: SessionId; agentId: AgentId; step: AgentStep } // async-agents FR-10: a trail step was appended, or an existing seq re-emitted with meta filled
  | { type: 'mcp.update'; sessionId: SessionId; server: McpServerInfo }
  | { type: 'context.usage'; sessionId: SessionId; usedTokens: number; limitTokens: number }
  | { type: 'session.resumeFailed'; sessionId: SessionId } // a --resume turn was rejected; the core continued on a fresh thread (durable-sessions FR-9/14)
  | { type: 'session.cleared'; sessionId: SessionId } // /clear: transcript wiped + context reset (full reset)
  | { type: 'session.error'; sessionId: SessionId; error: AppError };
