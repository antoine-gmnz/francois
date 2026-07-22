// contract/conversation-view.ts — conversation-view (SESSION tab, main pane [2]).
// Authored from specs/conversation-view.md §5. Imports shared vocabulary from
// common.ts; never redefines it. Also the single source of the block glyph map
// and the pure formatters (mirrored in the Rust core for getTranscript).
//
// Physical Tauri binding: `francois:conversation:getTranscript` → command
// `conversation_get_transcript`.

import type { SessionId, BlockId, Result } from './common';
import type { CommandConversationBlock } from './interactive-commands';

// ---------- francois:conversation:getTranscript ----------

export interface GetTranscriptRequest {
  sessionId: SessionId;
}

export type ConversationGlyph = '●' | '⧉' | '⌕' | '✎' | '⇉' | '';
export type ConversationBlockKind = 'user' | 'assistant' | 'tool' | 'subagent' | 'command';

interface ConversationBlockBase {
  blockId: BlockId;
  isStreaming: boolean;
}

export interface UserConversationBlock extends ConversationBlockBase {
  kind: 'user';
  text: string;
  queued: boolean;
}

export interface AssistantConversationBlock extends ConversationBlockBase {
  kind: 'assistant';
  glyph: '●';
  glyphColor: '#868a93' | '#c8a15a';
  bodyColor: '#c4c7ce' | '#dfe2e8';
  text: string;
}

export interface ToolConversationBlock extends ConversationBlockBase {
  kind: 'tool';
  tool: string;
  glyph: '⧉' | '⌕' | '✎' | '●';
  glyphColor: '#868a93' | '#7fa07a';
  bodyColor: '#868a93';
  summary: string;
  meta?: string;
}

export interface SubagentConversationBlock extends ConversationBlockBase {
  kind: 'subagent';
  glyph: '⇉';
  glyphColor: '#c8a15a';
  bodyColor: '#b9bcc4';
  agentName: string;
  meta?: string;
}

export type ConversationBlock =
  | UserConversationBlock
  | AssistantConversationBlock
  | ToolConversationBlock
  | SubagentConversationBlock
  | CommandConversationBlock; // interactive-commands (contract/interactive-commands.ts)

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
    ? { glyphColor: '#c8a15a', bodyColor: '#dfe2e8' }
    : { glyphColor: '#868a93', bodyColor: '#c4c7ce' };
}

/**
 * Tool names that dispatch a subagent. Claude Code's stock CLI uses `Task`;
 * some harnesses expose it as `Agent`. Mirrored in Rust (is_subagent_tool).
 */
export const SUBAGENT_TOOLS = ['Task', 'Agent'] as const;
export function isSubagentTool(tool: string): boolean {
  return (SUBAGENT_TOOLS as readonly string[]).includes(tool);
}

/** Classify a live `tool.start` (tool + summary) into a tool/subagent block core. */
export function classifyToolStart(
  tool: string,
  summary: string,
  blockId: BlockId,
): ToolConversationBlock | SubagentConversationBlock {
  if (isSubagentTool(tool)) {
    return {
      kind: 'subagent',
      blockId,
      isStreaming: true,
      glyph: '⇉',
      glyphColor: '#c8a15a',
      bodyColor: '#b9bcc4',
      agentName: summary,
    };
  }
  let glyph: ToolConversationBlock['glyph'] = '●';
  let glyphColor: ToolConversationBlock['glyphColor'] = '#868a93';
  if (tool === 'Read') {
    glyph = '⧉';
  } else if (tool === 'Grep' || tool === 'Search') {
    glyph = '⌕';
  } else if (tool === 'Edit' || tool === 'Write') {
    glyph = '✎';
    glyphColor = '#7fa07a';
  }
  return { kind: 'tool', blockId, isStreaming: true, tool, glyph, glyphColor, bodyColor: '#868a93', summary };
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
