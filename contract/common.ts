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
  | { type: 'agent.update'; agent: AgentInfo }
  | { type: 'mcp.update'; sessionId: SessionId; server: McpServerInfo }
  | { type: 'context.usage'; sessionId: SessionId; usedTokens: number; limitTokens: number }
  | { type: 'session.resumeFailed'; sessionId: SessionId } // a --resume turn was rejected; the core continued on a fresh thread (durable-sessions FR-9/14)
  | { type: 'session.error'; sessionId: SessionId; error: AppError };
