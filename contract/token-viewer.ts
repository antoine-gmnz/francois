// contract/token-viewer.ts — the session's context window, broken down by what
// fills it (specs/token-viewer.md). Source: Claude Code's `get_context_usage`
// stdio control request — the same data the Claude app's "Context" popover and
// `/context` render — asked of a short-lived `claude -p [--resume <thread>]`
// probe. No API turn is made; the CLI computes the breakdown locally.
//
// Channel: francois:session:contextBreakdown → Tauri command
// `session_context_breakdown`.
//
// Every row is classified on `kind` and keyed on `id` — never on the English
// `name`, never on the CLI's own colour names. A later CLI may add ids/kinds:
// unknown ids render as neutral rows, unknown kinds are dropped by the core.

import type { Result, SessionId } from './common';

/** What a row is. 'used' occupies the window; 'free' is what remains;
 *  'buffer' is the autocompact reserve; 'deferred' is out-of-window tool schemas. */
export type ContextRowKind = 'used' | 'free' | 'buffer' | 'deferred';

export interface ContextCategory {
  /** Stable CLI id, e.g. 'messages', 'system_tools', 'mcp_tools', 'system_prompt',
   *  'skills', 'mcp_instructions', 'custom_agents', 'memory_files',
   *  'autocompact_buffer', 'free_space', 'mcp_tools_deferred',
   *  'system_tools_deferred'. null when the CLI sent none (old CLI). */
  id: string | null;
  /** The CLI's English label, verbatim — display only. */
  name: string;
  tokens: number; // nonnegative integer
  kind: ContextRowKind;
}

export interface ContextMcpTool {
  name: string;
  serverName: string;
  tokens: number;
  /** false ⇔ deferred (schema not in the window). null when the CLI omits it. */
  isLoaded: boolean | null;
}

export interface ContextMemoryFile {
  /** Absolute path on the machine the CLI runs on (a WSL path for WSL sessions). */
  path: string;
  /** CLI's classification verbatim, e.g. 'Project', 'User', 'AutoMem'. */
  type: string;
  tokens: number;
}

export interface ContextAgent {
  agentType: string;
  /** e.g. 'plugin', 'userSettings', 'projectSettings' — verbatim. */
  source: string;
  tokens: number;
}

export interface ContextSkill {
  name: string;
  source: string;
  tokens: number;
}

export interface ContextBreakdown {
  /** Model id the CLI measured against. */
  model: string;
  /** Tokens in the window ('used' rows). */
  totalTokens: number;
  /** Window size. Positive. */
  maxTokens: number;
  /** 0–100, the CLI's own rounding of totalTokens / maxTokens. */
  percentage: number;
  /** In CLI order. Rows of an unknown kind are dropped. */
  categories: ContextCategory[];
  mcpTools: ContextMcpTool[];
  memoryFiles: ContextMemoryFile[];
  agents: ContextAgent[];
  /** From `skills.skillFrontmatter`; [] when absent. */
  skills: ContextSkill[];
  /** Token count at which auto-compact fires; null when unknown or disabled. */
  autoCompactThreshold: number | null;
}

export interface ContextBreakdownRequest {
  sessionId: SessionId;
  /** true = always probe (unless a turn is live); false = reuse a fresh cache. */
  refresh?: boolean;
}

export interface ContextBreakdownResponse {
  /** null ⇔ nothing measured yet AND no probe could run now (turn live). */
  breakdown: ContextBreakdown | null;
  /** epoch ms of the probe that produced `breakdown`; null with it. */
  measuredAt: number | null;
  /** true ⇔ a turn ended (or the model changed) after `measuredAt`, or a turn is
   *  live right now — the figures predate the conversation's current state. */
  stale: boolean;
}

/** Errors: SESSION_NOT_FOUND · CONTEXT_BREAKDOWN_UNAVAILABLE (non-Claude runtime,
 *  CLI refused the request — older CLI —, timeout, spawn failure; `message`
 *  says which, user-readable). */
export type SessionContextBreakdown = (
  req: ContextBreakdownRequest,
) => Promise<Result<ContextBreakdownResponse>>;
