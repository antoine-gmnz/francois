// design 9a — the transcript reads as TURNS, not as a flat list of blocks.
// Pure grouping + header derivation only (no DOM): who spoke, how many steps
// the reply took, how long it ran, and how a tool call's `meta` becomes chips.

import { describe, expect, it } from 'vitest';
import type { ConversationBlock } from '../../../contract/conversation-view';
import type { PermissionConversationBlock } from '../../../contract/permission-guardrails';
import {
  formatClock,
  formatTurnDuration,
  groupTurns,
  toolResultChips,
  turnMeta,
  turnSpanMs,
  turnStartedAt,
  turnStepCount,
  type TranscriptTurn,
} from './transcript-turns';

function user(blockId: string, at?: number): ConversationBlock {
  return { kind: 'user', blockId, isStreaming: false, text: 'go', queued: false, ...(at !== undefined ? { at } : {}) };
}
function assistant(blockId: string, at?: number, isStreaming = false): ConversationBlock {
  return {
    kind: 'assistant',
    blockId,
    isStreaming,
    glyph: '●',
    glyphColor: '#8b93a3',
    bodyColor: '#c3c9d4',
    text: 'ok',
    ...(at !== undefined ? { at } : {}),
  };
}
function tool(blockId: string, at?: number, meta?: string): ConversationBlock {
  return {
    kind: 'tool',
    blockId,
    isStreaming: false,
    tool: 'Edit',
    glyph: '✎',
    glyphColor: '#8fbab8',
    bodyColor: '#8b93a3',
    summary: 'src/a.ts',
    ...(meta !== undefined ? { meta } : {}),
    ...(at !== undefined ? { at } : {}),
  };
}
function subagent(blockId: string, at?: number): ConversationBlock {
  return {
    kind: 'subagent',
    blockId,
    isStreaming: false,
    glyph: '⇉',
    glyphColor: '#b39ede',
    bodyColor: '#c3c9d4',
    agentName: 'explorer',
    ...(at !== undefined ? { at } : {}),
  };
}
function permission(blockId: string): PermissionConversationBlock {
  return {
    kind: 'permission',
    blockId,
    isStreaming: true,
    state: 'pending',
    ask: { toolName: 'Bash', summary: 'npm ci', inputJson: '', cwd: '', pattern: '', patternLabel: '' },
  };
}

const turnAt = (items: ReturnType<typeof groupTurns>, i: number): TranscriptTurn => {
  const item = items[i]!;
  if (item.kind !== 'turn') throw new Error(`item ${i} is a card, not a turn`);
  return item;
};

describe('groupTurns (design 9a: one gutter glyph + one header per turn)', () => {
  it('opens a user turn per prompt — two prompts never share a clock', () => {
    const items = groupTurns([user('u1'), user('u2')]);
    expect(items).toHaveLength(2);
    expect(turnAt(items, 0).role).toBe('user');
    expect(turnAt(items, 0).blocks.map((b) => b.blockId)).toEqual(['u1']);
    expect(turnAt(items, 1).blocks.map((b) => b.blockId)).toEqual(['u2']);
  });

  it('absorbs prose, tools and dispatches after a reply into ONE assistant turn', () => {
    const items = groupTurns([user('u1'), assistant('a1'), tool('t1'), tool('t2'), assistant('a2')]);
    expect(items).toHaveLength(2);
    const reply = turnAt(items, 1);
    expect(reply.role).toBe('assistant');
    expect(reply.turnId).toBe('a1');
    expect(reply.blocks.map((b) => b.blockId)).toEqual(['a1', 't1', 't2', 'a2']);
  });

  it('opens an assistant turn on a tool call that arrived before any prose', () => {
    const reply = turnAt(groupTurns([tool('t1'), assistant('a1')]), 0);
    expect(reply.role).toBe('assistant');
    expect(reply.turnId).toBe('t1');
  });

  it('a user prompt closes the open reply', () => {
    const items = groupTurns([assistant('a1'), user('u1'), assistant('a2')]);
    expect(items.map((i) => (i.kind === 'turn' ? i.turnId : i.block.blockId))).toEqual(['a1', 'u1', 'a2']);
  });

  it('renders a card at transcript level and closes the turn around it', () => {
    const items = groupTurns([assistant('a1'), permission('p1'), tool('t1')]);
    expect(items).toHaveLength(3);
    expect(items[1]).toEqual({ kind: 'card', block: permission('p1') });
    expect(turnAt(items, 2).blocks.map((b) => b.blockId)).toEqual(['t1']);
  });

  it('is a no-op on an empty transcript', () => {
    expect(groupTurns([])).toEqual([]);
  });
});

describe('turn header derivation', () => {
  it('counts tools and dispatches as steps, never prose', () => {
    const reply = turnAt(groupTurns([assistant('a1'), tool('t1'), subagent('s1'), assistant('a2')]), 0);
    expect(turnStepCount(reply)).toBe(2);
  });

  it('takes the start from the FIRST block that carries a time', () => {
    const reply = turnAt(groupTurns([assistant('a1'), tool('t1', 5_000)]), 0);
    expect(turnStartedAt(reply)).toBe(5_000);
  });

  it('has no start at all when nothing in the turn was timed', () => {
    const reply = turnAt(groupTurns([assistant('a1'), tool('t1')]), 0);
    expect(turnStartedAt(reply)).toBeNull();
    expect(turnSpanMs(reply, 9_000)).toBeNull();
  });

  it('spans first to last for a finished turn, ignoring `now`', () => {
    const reply = turnAt(groupTurns([assistant('a1', 1_000), tool('t1', 3_000)]), 0);
    expect(turnSpanMs(reply, 999_000)).toBe(2_000);
  });

  it('spans first to `now` while the turn is still streaming', () => {
    const reply = turnAt(groupTurns([assistant('a1', 1_000, true)]), 0);
    expect(turnSpanMs(reply, 4_000)).toBe(3_000);
  });

  it('never reports a negative span when a clock stepped backwards', () => {
    const reply = turnAt(groupTurns([assistant('a1', 5_000, true)]), 0);
    expect(turnSpanMs(reply, 1_000)).toBe(0);
  });

  it('states steps and duration together, and drops each half it cannot claim', () => {
    const timed = turnAt(groupTurns([assistant('a1', 0), tool('t1', 112_000)]), 0);
    expect(turnMeta(timed, 112_000)).toBe('1 step · 1m 52s');

    const untimed = turnAt(groupTurns([assistant('a1'), tool('t1'), tool('t2'), tool('t3')]), 0);
    expect(turnMeta(untimed, 0)).toBe('3 steps');

    const prose = turnAt(groupTurns([assistant('a1', 0), assistant('a2', 4_000)]), 0);
    expect(turnMeta(prose, 4_000)).toBe('4s');

    expect(turnMeta(turnAt(groupTurns([assistant('a1')]), 0), 0)).toBe('');
  });

  it('states a user prompt with no step count — a prompt has no steps', () => {
    expect(turnMeta(turnAt(groupTurns([user('u1', 0)]), 0), 60_000)).toBe('');
  });
});

describe('formatClock', () => {
  it('is a zero-padded 24h wall clock', () => {
    // Built from local parts so the assertion is timezone-independent.
    const at = new Date(2026, 7, 19, 9, 4).getTime();
    expect(formatClock(at)).toBe('09:04');
    expect(formatClock(new Date(2026, 7, 19, 23, 59).getTime())).toBe('23:59');
  });
});

describe('formatTurnDuration', () => {
  it('reads in the largest two units that are non-zero', () => {
    expect(formatTurnDuration(0)).toBe('0s');
    expect(formatTurnDuration(900)).toBe('0s');
    expect(formatTurnDuration(4_000)).toBe('4s');
    expect(formatTurnDuration(112_000)).toBe('1m 52s');
    expect(formatTurnDuration(120_000)).toBe('2m');
    expect(formatTurnDuration(3_840_000)).toBe('1h 4m');
    expect(formatTurnDuration(7_200_000)).toBe('2h');
  });
});

describe('toolResultChips (design 9a: a result is chips, not a trailing sentence)', () => {
  it('has nothing to show for a call that has not landed', () => {
    expect(toolResultChips(undefined)).toEqual([]);
    expect(toolResultChips('')).toEqual([]);
  });

  it('splits a line-change meta into an added and a removed chip', () => {
    expect(toolResultChips('+88 −140')).toEqual([
      { tone: 'add', text: '+88' },
      { tone: 'del', text: '−140' },
    ]);
  });

  it('reads an ASCII minus the same as the core’s U+2212', () => {
    expect(toolResultChips('+3 -1')).toEqual([
      { tone: 'add', text: '+3' },
      { tone: 'del', text: '−1' },
    ]);
  });

  it('marks a failure red and leaves an ordinary result quiet', () => {
    expect(toolResultChips('error')).toEqual([{ tone: 'error', text: 'error' }]);
    expect(toolResultChips('14 failed')).toEqual([{ tone: 'error', text: '14 failed' }]);
    expect(toolResultChips('12 lines')).toEqual([{ tone: 'plain', text: '12 lines' }]);
    expect(toolResultChips('no matches')).toEqual([{ tone: 'plain', text: 'no matches' }]);
  });

  it('keeps a multi-part result as one chip rather than fanning it out', () => {
    expect(toolResultChips('7 matches · 3 files')).toEqual([{ tone: 'plain', text: '7 matches · 3 files' }]);
  });
});
