// thinking-blocks (IMPROVEMENTS C1): the transcript rules for a
// ThinkingConversationBlock. Split out of conversation-blocks.ts (file-size
// cap); that reducer forwards its `thinkingStart` / `thinkingDone` actions here,
// and its SessionEvent handler table spreads THINKING_EVENT_HANDLERS.
//
// Same keyed-upsert discipline as every other rule: replaying an event is a
// no-op or an identical replace, and an out-of-order `done` inserts.

import type { SessionEvent } from '../../../contract/common';
import type { ConversationBlock, ThinkingConversationBlock } from '../../../contract/conversation-view';

export type ThinkingAction =
  | { t: 'thinkingStart'; blockId: string }
  // `text: ''` ⇒ the core dropped the block (redacted thinking with nothing to
  // show) — remove it here too, so the live view matches a reload.
  | { t: 'thinkingDone'; blockId: string; text: string };

function applyToBlocks(blocks: ConversationBlock[], a: ThinkingAction): ConversationBlock[] {
  const i = blocks.findIndex((b) => b.blockId === a.blockId);
  if (a.t === 'thinkingStart') {
    if (i !== -1) return blocks;
    const b: ThinkingConversationBlock = { kind: 'thinking', blockId: a.blockId, isStreaming: true, text: '' };
    return [...blocks, b];
  }
  const prev = i === -1 ? undefined : blocks[i];
  if (prev !== undefined && prev.kind !== 'thinking') return blocks;
  if (a.text === '') return prev === undefined ? blocks : blocks.filter((_, j) => j !== i);
  const settled: ThinkingConversationBlock = {
    kind: 'thinking',
    blockId: a.blockId,
    isStreaming: false,
    text: a.text,
    ...(prev?.at !== undefined ? { at: prev.at } : {}),
  };
  if (prev === undefined) return [...blocks, settled];
  if (!prev.isStreaming && prev.text === a.text) return blocks;
  const next = blocks.slice();
  next[i] = settled;
  return next;
}

/** Apply one thinking action; returns the SAME state object when nothing
 *  changed (a replayed event), like every other reducer rule. */
export function applyThinking<S extends { blocks: ConversationBlock[] }>(state: S, a: ThinkingAction): S {
  const blocks = applyToBlocks(state.blocks, a);
  return blocks === state.blocks ? state : { ...state, blocks };
}

type EventOf<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>;

/** The `thinking.*` rows of conversation-blocks.ts's SESSION_EVENT_HANDLERS. */
export const THINKING_EVENT_HANDLERS = {
  'thinking.start': (dispatch: (a: ThinkingAction) => void, _setters: unknown, e: EventOf<'thinking.start'>) =>
    dispatch({ t: 'thinkingStart', blockId: e.blockId }),
  'thinking.done': (dispatch: (a: ThinkingAction) => void, _setters: unknown, e: EventOf<'thinking.done'>) =>
    dispatch({ t: 'thinkingDone', blockId: e.blockId, text: e.text }),
};

/** What the disclosure row states. A live block has no text yet (the core
 *  sends it whole at the end), so it only says it is thinking. */
export function thinkingLabel(b: ThinkingConversationBlock): string {
  return b.isStreaming ? 'Thinking…' : 'Thinking';
}

/** Whether the row can open: only a settled block with something in it. */
export function thinkingExpandable(b: ThinkingConversationBlock): boolean {
  return !b.isStreaming && b.text !== '';
}
