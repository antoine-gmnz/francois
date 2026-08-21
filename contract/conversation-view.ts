// contract/conversation-view.ts — conversation-view (SESSION tab, main pane [2]).
// Authored from specs/conversation-view.md §5. Imports shared vocabulary from
// common.ts; never redefines it. Also the single source of the block glyph map
// and the pure formatters (mirrored in the Rust core for getTranscript).
//
// Physical Tauri binding: `francois:conversation:getTranscript` → command
// `conversation_get_transcript`.

import type { SessionId, BlockId, Result } from './common';
import type { CommandConversationBlock } from './interactive-commands';
import type { PermissionConversationBlock } from './permission-guardrails';
import type { QuestionConversationBlock } from './session-questions';

// ---------- francois:conversation:getTranscript ----------

export interface GetTranscriptRequest {
  sessionId: SessionId;
}

export type ConversationGlyph = '●' | '⧉' | '⌕' | '✎' | '⇉' | '';
export type ConversationBlockKind = 'user' | 'assistant' | 'tool' | 'subagent' | 'command' | 'question' | 'permission';

interface ConversationBlockBase {
  blockId: BlockId;
  isStreaming: boolean;
  /**
   * Design 9a: epoch ms the core appended this block. The turn header states
   * the clock time of a prompt and the wall duration of a reply, and both have
   * to survive quit/reopen — a render-time stamp would re-date the whole
   * transcript on every reload.
   *
   * OPTIONAL because transcripts written before this field exists are still
   * read back (persistence.rs skips nothing on a missing key). A block without
   * it renders its header without a clock rather than guessing one.
   */
  at?: number;
}

export interface UserConversationBlock extends ConversationBlockBase {
  kind: 'user';
  text: string;
  // `queued: boolean` REMOVED (transcript-perf FR-21) — a queued prompt is no
  // longer a transcript block; see session-engine.ts SessionUnqueue* + the
  // frontend's pending-queue strip (specs/transcript-perf.md §6).
}

export interface AssistantConversationBlock extends ConversationBlockBase {
  kind: 'assistant';
  glyph: '●';
  glyphColor: '#8b93a3' | '#c3f53f';
  bodyColor: '#c3c9d4' | '#e6e9ef';
  text: string;
}

export interface ToolConversationBlock extends ConversationBlockBase {
  kind: 'tool';
  tool: string;
  glyph: '⧉' | '⌕' | '✎' | '●';
  glyphColor: '#8b93a3' | '#8fbab8';
  bodyColor: '#8b93a3';
  summary: string;
  meta?: string;
}

export interface SubagentConversationBlock extends ConversationBlockBase {
  kind: 'subagent';
  glyph: '⇉';
  glyphColor: '#b39ede';
  bodyColor: '#c3c9d4';
  agentName: string;
  /**
   * The model the dispatch NAMED (the `Agent`/`Task` tool's `model` param) —
   * a subagent can run on a different one from the session that spawned it.
   * Absent when the dispatch named none, i.e. it inherits the session's model;
   * the banner then says nothing rather than guessing.
   */
  agentModel?: string;
  meta?: string;
}

export type ConversationBlock =
  | UserConversationBlock
  | AssistantConversationBlock
  | ToolConversationBlock
  | SubagentConversationBlock
  | CommandConversationBlock // interactive-commands (contract/interactive-commands.ts)
  | QuestionConversationBlock // session-questions (contract/session-questions.ts)
  | PermissionConversationBlock; // permission-guardrails (contract/permission-guardrails.ts)

// resolves Result<ConversationBlock[]>; error: SESSION_NOT_FOUND
export type GetTranscriptResponse = Result<ConversationBlock[]>;

// ---------- consumed (owned by session-engine) ----------

export interface SendMessageRequest {
  sessionId: SessionId;
  blockId: BlockId;
  text: string;
}

// ---------- shared classification (single source; Rust mirrors this) ----------

export function assistantColors(isStreaming: boolean): {
  glyphColor: AssistantConversationBlock['glyphColor'];
  bodyColor: AssistantConversationBlock['bodyColor'];
} {
  return isStreaming
    ? { glyphColor: '#c3f53f', bodyColor: '#e6e9ef' }
    : { glyphColor: '#8b93a3', bodyColor: '#c3c9d4' };
}

/**
 * Tool names that dispatch a subagent. Claude Code's stock CLI uses `Task`;
 * some harnesses expose it as `Agent`. Mirrored in Rust (is_subagent_tool).
 */
export const SUBAGENT_TOOLS = ['Task', 'Agent'] as const;
export function isSubagentTool(tool: string): boolean {
  return (SUBAGENT_TOOLS as readonly string[]).includes(tool);
}

/**
 * Classify a live `tool.start` (tool + summary) into a tool/subagent block core.
 * `model` is only ever set on a subagent dispatch that named one, and is ignored
 * for every other tool.
 */
export function classifyToolStart(
  tool: string,
  summary: string,
  blockId: BlockId,
  model?: string,
): ToolConversationBlock | SubagentConversationBlock {
  if (isSubagentTool(tool)) {
    const block: SubagentConversationBlock = {
      kind: 'subagent',
      blockId,
      isStreaming: true,
      glyph: '⇉',
      glyphColor: '#b39ede',
      bodyColor: '#c3c9d4',
      agentName: summary,
    };
    // Omitted, never undefined — the block shape mirrors the core's JSON, which
    // leaves the key out when the dispatch inherits the session's model.
    return model ? { ...block, agentModel: model } : block;
  }
  let glyph: ToolConversationBlock['glyph'] = '●';
  let glyphColor: ToolConversationBlock['glyphColor'] = '#8b93a3';
  if (tool === 'Read') {
    glyph = '⧉';
  } else if (tool === 'Grep' || tool === 'Search') {
    glyph = '⌕';
  } else if (tool === 'Edit' || tool === 'Write') {
    glyph = '✎';
    glyphColor = '#8fbab8';
  }
  return { kind: 'tool', blockId, isStreaming: true, tool, glyph, glyphColor, bodyColor: '#8b93a3', summary };
}

/** Body text prefix for a tool block: `Read  <summary>` (two spaces). */
export function toolBody(tool: string, summary: string): string {
  return `${tool}  ${summary}`;
}

// ---------- pure formatters (FR-4, FR-6) ----------

export function formatContextTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n >= 1_000_000) {
    const m = (n / 1_000_000).toFixed(1).replace(/\.0$/, '');
    return `${m}M`;
  }
  const k = (n / 1000).toFixed(1).replace(/\.0$/, '');
  return `${k}K`;
}

export function formatElapsed(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (x: number) => String(x).padStart(2, '0');
  if (elapsedMs < 3_600_000) {
    return `${pad(Math.floor(total / 60))}:${pad(s)}`;
  }
  return `${h}:${pad(m)}:${pad(s)}`;
}
