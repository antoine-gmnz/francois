// thinking-blocks (IMPROVEMENTS C1): reducer + routing + turn membership for
// the ThinkingConversationBlock, through the real transcript reducer.

import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../../../contract/common';
import type { ConversationBlock } from '../../../contract/conversation-view';
import {
  applySessionEvent,
  RENDER_WINDOW,
  transcriptReducer,
  windowStartIndex,
  type ConversationEventSetters,
  type TranscriptAction,
  type TranscriptState,
} from './conversation-blocks';
import { thinkingExpandable, thinkingLabel } from './thinking-blocks';
import { groupTurns, turnIsStreaming } from './transcript-turns';

const S0: TranscriptState = { blocks: [], windowSize: RENDER_WINDOW };

function run(actions: TranscriptAction[], from: TranscriptState = S0): TranscriptState {
  return actions.reduce(transcriptReducer, from);
}

function setters(): ConversationEventSetters {
  return {
    setStatus: vi.fn(),
    setErrorMessage: vi.fn(),
    setResumeFailed: vi.fn(),
    setLimitNotice: vi.fn(),
    setPinned: vi.fn(),
    setCommands: vi.fn(),
    patchUsage: vi.fn(),
    setHasMore: vi.fn(),
  };
}

const assistant = (blockId: string): ConversationBlock => ({
  kind: 'assistant',
  blockId,
  isStreaming: false,
  glyph: '●',
  glyphColor: '#8b93a3',
  bodyColor: '#c3c9d4',
  text: 'answer',
});

describe('transcriptReducer — thinking blocks', () => {
  it('thinkingStart inserts a streaming, empty thinking block; replay is a no-op', () => {
    const s1 = run([{ t: 'thinkingStart', blockId: 'k1' }]);
    expect(s1.blocks).toEqual([{ kind: 'thinking', blockId: 'k1', isStreaming: true, text: '' }]);
    expect(transcriptReducer(s1, { t: 'thinkingStart', blockId: 'k1' })).toBe(s1);
  });

  it('thinkingDone settles the block in place with its complete text', () => {
    const s = run([
      { t: 'thinkingStart', blockId: 'k1' },
      { t: 'delta', blockId: 'a1', text: 'hi', offset: 0 },
      { t: 'thinkingDone', blockId: 'k1', text: 'weighing it' },
    ]);
    expect(s.blocks.map((b) => b.blockId)).toEqual(['k1', 'a1']);
    expect(s.blocks[0]).toEqual({ kind: 'thinking', blockId: 'k1', isStreaming: false, text: 'weighing it' });
  });

  it('a replayed thinkingDone returns the same state', () => {
    const s = run([
      { t: 'thinkingStart', blockId: 'k1' },
      { t: 'thinkingDone', blockId: 'k1', text: 'x' },
    ]);
    expect(transcriptReducer(s, { t: 'thinkingDone', blockId: 'k1', text: 'x' })).toBe(s);
  });

  it('a thinkingDone for an unseen block inserts it settled', () => {
    const s = run([{ t: 'thinkingDone', blockId: 'k9', text: 'late' }]);
    expect(s.blocks).toEqual([{ kind: 'thinking', blockId: 'k9', isStreaming: false, text: 'late' }]);
  });

  it('an empty thinkingDone removes the block (redacted thinking — matches the core dropping it)', () => {
    const s = run([
      { t: 'thinkingStart', blockId: 'k1' },
      { t: 'thinkingDone', blockId: 'k1', text: '' },
    ]);
    expect(s.blocks).toEqual([]);
    expect(run([{ t: 'thinkingDone', blockId: 'k2', text: '' }]).blocks).toEqual([]);
  });

  it('never touches a non-thinking block that shares the id', () => {
    const s = run([{ t: 'seed', blocks: [assistant('x')] }]);
    expect(transcriptReducer(s, { t: 'thinkingDone', blockId: 'x', text: 'nope' })).toBe(s);
    expect(transcriptReducer(s, { t: 'thinkingStart', blockId: 'x' })).toBe(s);
  });

  it('keeps a seeded block\'s `at` when it settles', () => {
    const s = run([
      { t: 'seed', blocks: [{ kind: 'thinking', blockId: 'k1', isStreaming: true, text: '', at: 42 }] },
      { t: 'thinkingDone', blockId: 'k1', text: 'done' },
    ]);
    expect(s.blocks[0]).toMatchObject({ at: 42, isStreaming: false, text: 'done' });
  });
});

describe('applySessionEvent — thinking.start / thinking.done', () => {
  it('routes both events to the reducer', () => {
    const actions: TranscriptAction[] = [];
    const dispatch = (a: TranscriptAction) => actions.push(a);
    const start: SessionEvent = { type: 'thinking.start', sessionId: 's1', blockId: 'k1' };
    const done: SessionEvent = { type: 'thinking.done', sessionId: 's1', blockId: 'k1', text: 't' };
    applySessionEvent(dispatch, setters(), start);
    applySessionEvent(dispatch, setters(), done);
    expect(actions).toEqual([
      { t: 'thinkingStart', blockId: 'k1' },
      { t: 'thinkingDone', blockId: 'k1', text: 't' },
    ]);
  });
});

describe('thinking blocks inside turns', () => {
  it('a thought joins the reply it precedes instead of splitting it into a card', () => {
    const blocks: ConversationBlock[] = [
      { kind: 'user', blockId: 'u1', isStreaming: false, text: 'go' },
      { kind: 'thinking', blockId: 'k1', isStreaming: false, text: 'hmm' },
      assistant('a1'),
    ];
    const items = groupTurns(blocks);
    expect(items.map((i) => i.kind)).toEqual(['turn', 'turn']);
    const reply = items[1]!;
    expect(reply.kind === 'turn' && reply.blocks.map((b) => b.blockId)).toEqual(['k1', 'a1']);
  });

  it('a live thought makes its turn stream', () => {
    const items = groupTurns([{ kind: 'thinking', blockId: 'k1', isStreaming: true, text: '' }]);
    const turn = items[0]!;
    expect(turn.kind === 'turn' && turnIsStreaming(turn)).toBe(true);
  });

  it('the render window never cuts between a thought and its reply', () => {
    const blocks: ConversationBlock[] = [
      { kind: 'user', blockId: 'u1', isStreaming: false, text: 'go' },
      { kind: 'thinking', blockId: 'k1', isStreaming: false, text: 'hmm' },
      assistant('a1'),
    ];
    expect(windowStartIndex(blocks, 1)).toBe(1);
  });
});

describe('thinking disclosure helpers', () => {
  it('a live block says it is thinking and cannot open', () => {
    const b = { kind: 'thinking', blockId: 'k', isStreaming: true, text: '' } as const;
    expect(thinkingLabel(b)).toBe('Thinking…');
    expect(thinkingExpandable(b)).toBe(false);
  });
  it('a settled block with text opens', () => {
    const b = { kind: 'thinking', blockId: 'k', isStreaming: false, text: 'x' } as const;
    expect(thinkingLabel(b)).toBe('Thinking');
    expect(thinkingExpandable(b)).toBe(true);
  });
});
