// contract/interactive-commands.ts — interactive commands (session view).
// Authored from specs/interactive-commands.md §5. Imports shared vocabulary from
// common.ts; never redefines it. The card payloads (CommandCard, UsageMeter,
// HelpEntry) and the command.started/command.output SessionEvent members live in
// common.ts — the engine emits them, conversation-view renders them.
//
// No new IPC channels: this feature rides on francois:session:send,
// francois:session:switchModel, francois:session:event, and
// francois:conversation:getTranscript.

import type { BlockId, CommandCard, HelpEntry } from './common';

/** Transcript block for a command response. Joins conversation-view's ConversationBlock union. */
export interface CommandConversationBlock {
  kind: 'command';
  blockId: BlockId;
  /** true from command.started until command.output (loading card). */
  isStreaming: boolean;
  /** Command token without the '/', '' when the source text wasn't a parsed command. */
  command: string;
  /** Absent while pending. */
  card?: CommandCard;
}

// ---------- canonical command sets (single source; Rust mirrors) ----------

/** Commands the core intercepts in session:send (spec FR-2) — these never spawn a turn. */
export const INTERCEPTED_COMMANDS = ['usage', 'cost', 'model', 'status', 'help'] as const;
export type InterceptedCommand = (typeof INTERCEPTED_COMMANDS)[number];

/** /help card contents (spec FR-15), in display order. */
export const HELP_ENTRIES: HelpEntry[] = [
  { command: 'usage', description: 'plan usage limits (session + weekly)' },
  { command: 'cost', description: 'alias of /usage' },
  { command: 'context', description: 'context window breakdown (runs on the session thread)' },
  { command: 'model', description: 'show or switch the session model' },
  { command: 'status', description: 'session snapshot (cwd, model, runtime, context)' },
  { command: 'help', description: 'this list' },
];

// ---------- command grammar (spec FR-1; single source, mirrored in Rust) ----------

/**
 * Detect a slash command in send text: trimmed, single-line `/token [arg]`.
 * Returns null for multiline input or a non-matching first token (→ normal turn).
 */
export function parseCommand(text: string): { command: string; arg?: string } | null {
  const t = text.trim();
  if (t.includes('\n')) return null;
  const m = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+(\S.*))?$/.exec(t);
  if (!m) return null;
  const arg = m[2]?.trim();
  return arg ? { command: m[1].toLowerCase(), arg } : { command: m[1].toLowerCase() };
}
