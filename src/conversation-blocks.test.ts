// interactive-commands FR-20/21 — transcript apply rules for command.started /
// command.output, live current-model derivation, the high-usage meter threshold,
// and the model-card switch error path. Pure logic only (no DOM).

import { describe, expect, it, vi } from 'vitest';
import type { CommandCard, Result, SessionQuestion } from '../contract/common';
import type { CommandConversationBlock } from '../contract/interactive-commands';
import type { QuestionConversationBlock } from '../contract/session-questions';
import { classifyToolStart, type ConversationBlock } from '../contract/conversation-view';
import {
  cardHeaderLabel,
  commandFromCard,
  isClearCommand,
  liveCurrentModelId,
  meterFillColor,
  switchModelFromCard,
  transcriptReducer,
  type TranscriptState,
} from './conversation-blocks';

const S0: TranscriptState = { blocks: [] };

const usageCard: CommandCard = {
  kind: 'usage',
  command: 'usage',
  meters: [{ label: 'Current session', percentUsed: 14, resetsAt: 'Jul 22, 5:29pm (Europe/Paris)' }],
  tail: '',
};
const costCard: CommandCard = { ...usageCard, command: 'cost' };
const noticeCard: CommandCard = { kind: 'notice', text: 'a usage check is already running' };

function commandBlock(s: TranscriptState, blockId: string): CommandConversationBlock {
  const b = s.blocks.find((x) => x.blockId === blockId);
  if (!b || b.kind !== 'command') throw new Error(`no command block ${blockId}`);
  return b;
}

describe('transcriptReducer — command.started (FR-20)', () => {
  it('inserts a pending command block at the end', () => {
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: '/usage', queued: false };
    const s = transcriptReducer({ blocks: [user] }, { t: 'commandStarted', blockId: 'c1', command: 'usage' });
    expect(s.blocks).toHaveLength(2);
    expect(s.blocks[1]).toEqual({ kind: 'command', blockId: 'c1', isStreaming: true, command: 'usage' });
    expect(commandBlock(s, 'c1').card).toBeUndefined();
  });

  it('is idempotent on replay (existing blockId → same state)', () => {
    const s1 = transcriptReducer(S0, { t: 'commandStarted', blockId: 'c1', command: 'usage' });
    const s2 = transcriptReducer(s1, { t: 'commandStarted', blockId: 'c1', command: 'usage' });
    expect(s2).toBe(s1); // no-op, not a duplicate insert
    expect(s2.blocks).toHaveLength(1);
  });
});

describe('transcriptReducer — command.output (FR-20)', () => {
  it('upserts the card onto a pending block and clears isStreaming', () => {
    const s1 = transcriptReducer(S0, { t: 'commandStarted', blockId: 'c1', command: 'usage' });
    const s2 = transcriptReducer(s1, { t: 'commandOutput', blockId: 'c1', card: usageCard });
    expect(s2.blocks).toHaveLength(1);
    const b = commandBlock(s2, 'c1');
    expect(b.isStreaming).toBe(false);
    expect(b.card).toEqual(usageCard);
    expect(b.command).toBe('usage'); // preserved from command.started
  });

  it('is idempotent on replay (same card, still one block)', () => {
    const s1 = transcriptReducer(S0, { t: 'commandStarted', blockId: 'c1', command: 'cost' });
    const s2 = transcriptReducer(s1, { t: 'commandOutput', blockId: 'c1', card: costCard });
    const s3 = transcriptReducer(s2, { t: 'commandOutput', blockId: 'c1', card: costCard });
    expect(s3.blocks).toHaveLength(1);
    expect(commandBlock(s3, 'c1')).toEqual(commandBlock(s2, 'c1'));
  });

  it('inserts the block when unseen — output without started (FR-11/13 instant cards)', () => {
    const s = transcriptReducer(S0, { t: 'commandOutput', blockId: 'c9', card: noticeCard });
    expect(s.blocks).toHaveLength(1);
    const b = commandBlock(s, 'c9');
    expect(b.isStreaming).toBe(false);
    expect(b.card).toEqual(noticeCard);
    expect(b.command).toBe(''); // notice cards carry no command token
  });

  it('derives the inserted block command from the card', () => {
    const s = transcriptReducer(S0, { t: 'commandOutput', blockId: 'c2', card: costCard });
    expect(commandBlock(s, 'c2').command).toBe('cost');
  });

  it('is a no-op when the blockId belongs to a non-command block', () => {
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi', queued: false };
    const s1: TranscriptState = { blocks: [user] };
    const s2 = transcriptReducer(s1, { t: 'commandOutput', blockId: 'u1', card: noticeCard });
    expect(s2).toBe(s1);
  });
});

describe('commandFromCard', () => {
  it('maps every card kind to its command token', () => {
    expect(commandFromCard(usageCard)).toBe('usage');
    expect(commandFromCard(costCard)).toBe('cost');
    expect(commandFromCard({ kind: 'context', percentUsed: null, usedLabel: null, limitLabel: null, body: '' })).toBe('context');
    expect(commandFromCard({ kind: 'model', models: [], currentId: 'x' })).toBe('model');
    expect(commandFromCard({ kind: 'help', entries: [] })).toBe('help');
    expect(commandFromCard(noticeCard)).toBe('');
    expect(commandFromCard({ kind: 'text', command: 'frobnicate', text: 'Unknown' })).toBe('frobnicate');
  });
});

describe('liveCurrentModelId (FR-21)', () => {
  it('prefers the live store model id over the card snapshot', () => {
    expect(liveCurrentModelId('claude-opus-4', 'claude-sonnet-5')).toBe('claude-opus-4');
  });
  it('falls back to the snapshot when the session is gone from the store', () => {
    expect(liveCurrentModelId(undefined, 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });
});

describe('meterFillColor (§8 high-usage threshold)', () => {
  it('is gold below 80% and error red at ≥ 80%', () => {
    expect(meterFillColor(0)).toBe('var(--accent)');
    expect(meterFillColor(79)).toBe('var(--accent)');
    expect(meterFillColor(80)).toBe('var(--error)');
    expect(meterFillColor(100)).toBe('var(--error)');
  });
});

describe('switchModelFromCard (FR-21 error path)', () => {
  const ok: Result<unknown> = { ok: true, data: null };
  const fail: Result<unknown> = { ok: false, error: { code: 'SESSION_NOT_RUNNING', message: 'session has ended' } };

  it('does not invoke switchModel for the current row', async () => {
    const switchModel = vi.fn(async () => ok);
    await switchModelFromCard({
      disabled: false,
      currentId: 'a',
      modelId: 'a',
      switchModel,
      setError: vi.fn(),
      schedule: vi.fn(),
    });
    expect(switchModel).not.toHaveBeenCalled();
  });

  it('does not invoke switchModel when the session is done/error (disabled)', async () => {
    const switchModel = vi.fn(async () => ok);
    await switchModelFromCard({
      disabled: true,
      currentId: 'a',
      modelId: 'b',
      switchModel,
      setError: vi.fn(),
      schedule: vi.fn(),
    });
    expect(switchModel).not.toHaveBeenCalled();
  });

  it('on ok: true clears any stale error and never shows one (only-null calls)', async () => {
    const setError = vi.fn();
    const schedule = vi.fn();
    await switchModelFromCard({
      disabled: false,
      currentId: 'a',
      modelId: 'b',
      switchModel: vi.fn(async () => ok),
      setError,
      schedule,
    });
    // Every call is a clear (null) — a stale error from a prior failed attempt
    // must not survive a subsequent successful switch.
    expect(setError.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(setError.mock.calls.every((c) => c[0] === null)).toBe(true);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('on ok: false clears the stale error first, then shows the message and schedules a 4s clear', async () => {
    const setError = vi.fn();
    const schedule = vi.fn();
    await switchModelFromCard({
      disabled: false,
      currentId: 'a',
      modelId: 'b',
      switchModel: vi.fn(async () => fail),
      setError,
      schedule,
    });
    expect(setError.mock.calls[0]).toEqual([null]); // stale-error clear at attempt start
    expect(setError).toHaveBeenCalledWith('session has ended');
    expect(schedule).toHaveBeenCalledTimes(1);
    const [clear, ms] = schedule.mock.calls[0] as [() => void, number];
    expect(ms).toBe(4000);
    clear();
    expect(setError).toHaveBeenLastCalledWith(null);
  });

  it('catches a transport-level rejection and routes it through setError + 4s clear', async () => {
    const setError = vi.fn();
    const schedule = vi.fn();
    await switchModelFromCard({
      disabled: false,
      currentId: 'a',
      modelId: 'b',
      switchModel: vi.fn(async () => {
        throw new Error('ipc bridge lost');
      }),
      setError,
      schedule,
    });
    expect(setError).toHaveBeenCalledWith('ipc bridge lost');
    expect(schedule).toHaveBeenCalledTimes(1);
    const [clear, ms] = schedule.mock.calls[0] as [() => void, number];
    expect(ms).toBe(4000);
    clear();
    expect(setError).toHaveBeenLastCalledWith(null);
  });

  it('stringifies a non-Error rejection', async () => {
    const setError = vi.fn();
    await switchModelFromCard({
      disabled: false,
      currentId: 'a',
      modelId: 'b',
      switchModel: vi.fn(async () => {
        // eslint-disable-next-line no-throw-literal
        throw 'boom';
      }),
      setError,
      schedule: vi.fn(),
    });
    expect(setError).toHaveBeenCalledWith('boom');
  });
});

describe('cardHeaderLabel (§8 header, OUTPUT fallback)', () => {
  it('prefers the card-derived command over the block command', () => {
    expect(cardHeaderLabel(costCard, 'usage')).toBe('COST');
  });

  it('falls back to the block command while pending (no card)', () => {
    expect(cardHeaderLabel(undefined, 'usage')).toBe('USAGE');
  });

  it("falls back to 'OUTPUT' when both resolve empty (text card with command: '')", () => {
    expect(cardHeaderLabel({ kind: 'text', command: '', text: 'raw CLI output' }, '')).toBe('OUTPUT');
  });
});

describe('transcriptReducer — question.asked / question.resolved (session-questions FR-16)', () => {
  const questions: SessionQuestion[] = [
    {
      question: 'Which color do you prefer?',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'The color red' },
        { label: 'Blue', description: 'The color blue' },
      ],
    },
  ];

  function questionBlock(s: TranscriptState, blockId: string): QuestionConversationBlock {
    const b = s.blocks.find((x) => x.blockId === blockId);
    if (!b || b.kind !== 'question') throw new Error(`no question block ${blockId}`);
    return b;
  }

  it('questionAsked inserts a pending block at the end (FR-15: isStreaming iff pending)', () => {
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'go', queued: false };
    const s = transcriptReducer({ blocks: [user] }, { t: 'questionAsked', blockId: 'q1', questions });
    expect(s.blocks).toHaveLength(2);
    expect(s.blocks[1]).toEqual({ kind: 'question', blockId: 'q1', isStreaming: true, questions, state: 'pending' });
    expect(questionBlock(s, 'q1')).not.toHaveProperty('answers');
  });

  it('questionAsked is idempotent on replay (existing blockId → same state)', () => {
    const s1 = transcriptReducer(S0, { t: 'questionAsked', blockId: 'q1', questions });
    const s2 = transcriptReducer(s1, { t: 'questionAsked', blockId: 'q1', questions });
    expect(s2).toBe(s1); // no-op, not a duplicate insert
  });

  it('questionResolved answered: updates state + answers in place, clears isStreaming', () => {
    const answers = { 'Which color do you prefer?': 'Blue' };
    const s1 = transcriptReducer(S0, { t: 'questionAsked', blockId: 'q1', questions });
    const s2 = transcriptReducer(s1, { t: 'questionResolved', blockId: 'q1', state: 'answered', answers });
    expect(s2.blocks).toHaveLength(1);
    expect(questionBlock(s2, 'q1')).toEqual({
      kind: 'question',
      blockId: 'q1',
      isStreaming: false,
      questions,
      state: 'answered',
      answers,
    });
  });

  it('questionResolved cancelled: no answers property on the block', () => {
    const s1 = transcriptReducer(S0, { t: 'questionAsked', blockId: 'q1', questions });
    const s2 = transcriptReducer(s1, { t: 'questionResolved', blockId: 'q1', state: 'cancelled' });
    const b = questionBlock(s2, 'q1');
    expect(b.state).toBe('cancelled');
    expect(b.isStreaming).toBe(false);
    expect(b).not.toHaveProperty('answers');
  });

  it('questionResolved is idempotent on replay', () => {
    const answers = { 'Which color do you prefer?': 'Blue' };
    const s1 = transcriptReducer(S0, { t: 'questionAsked', blockId: 'q1', questions });
    const s2 = transcriptReducer(s1, { t: 'questionResolved', blockId: 'q1', state: 'answered', answers });
    const s3 = transcriptReducer(s2, { t: 'questionResolved', blockId: 'q1', state: 'answered', answers });
    expect(s3.blocks).toEqual(s2.blocks);
  });

  it('resolve before insert (out-of-order) inserts the resolved block', () => {
    const answers = { 'Which color do you prefer?': 'Red' };
    const s = transcriptReducer(S0, { t: 'questionResolved', blockId: 'q1', state: 'answered', answers });
    expect(s.blocks).toHaveLength(1);
    expect(questionBlock(s, 'q1')).toEqual({
      kind: 'question',
      blockId: 'q1',
      isStreaming: false,
      questions: [],
      state: 'answered',
      answers,
    });
  });

  it('a late questionAsked fills the questions of a resolved-first block without reviving it', () => {
    const s1 = transcriptReducer(S0, { t: 'questionResolved', blockId: 'q1', state: 'cancelled' });
    const s2 = transcriptReducer(s1, { t: 'questionAsked', blockId: 'q1', questions });
    expect(s2.blocks).toHaveLength(1);
    const b = questionBlock(s2, 'q1');
    expect(b.questions).toEqual(questions); // verbatim content restored…
    expect(b.state).toBe('cancelled'); // …but the resolution stands
    expect(b.isStreaming).toBe(false);
  });

  it('questionAsked is a no-op when the blockId belongs to a non-question block', () => {
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi', queued: false };
    const s1: TranscriptState = { blocks: [user] };
    const s2 = transcriptReducer(s1, { t: 'questionAsked', blockId: 'u1', questions });
    expect(s2).toBe(s1);
  });

  it('questionResolved is a no-op when the blockId belongs to a non-question block', () => {
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi', queued: false };
    const s1: TranscriptState = { blocks: [user] };
    const s2 = transcriptReducer(s1, { t: 'questionResolved', blockId: 'u1', state: 'cancelled' });
    expect(s2).toBe(s1);
  });
});

describe('isClearCommand (/clear full-reset detector)', () => {
  it('is true for the bare command (trimmed, case-insensitive)', () => {
    expect(isClearCommand('/clear')).toBe(true);
    expect(isClearCommand('  /clear  ')).toBe(true);
    expect(isClearCommand('/CLEAR')).toBe(true);
    expect(isClearCommand('/Clear\n')).toBe(true);
  });

  it('is false for anything with an argument or a different token', () => {
    expect(isClearCommand('/clear foo')).toBe(false);
    expect(isClearCommand('/cleared')).toBe(false);
    expect(isClearCommand('clear')).toBe(false);
    expect(isClearCommand('/clearx')).toBe(false);
    expect(isClearCommand('')).toBe(false);
    expect(isClearCommand('/clear now')).toBe(false);
  });
});

describe('transcriptReducer — legacy actions (conversation-view FR-10 behavior identity)', () => {
  const user = (blockId: string, text: string, queued: boolean): ConversationBlock => ({
    kind: 'user',
    blockId,
    isStreaming: false,
    text,
    queued,
  });

  describe('seed', () => {
    it('replaces the whole block list (hydration)', () => {
      const s1: TranscriptState = { blocks: [user('u1', 'old', false)] };
      const seeded = [user('u2', 'restored', false)];
      const s2 = transcriptReducer(s1, { t: 'seed', blocks: seeded });
      expect(s2.blocks).toEqual(seeded);
    });
  });

  describe('optimisticUser', () => {
    it('appends a queued user block', () => {
      const s = transcriptReducer(S0, { t: 'optimisticUser', blockId: 'u1', text: 'hi' });
      expect(s.blocks).toEqual([{ kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi', queued: true }]);
    });

    it('guards against duplicates (existing blockId → same state)', () => {
      const s1 = transcriptReducer(S0, { t: 'optimisticUser', blockId: 'u1', text: 'hi' });
      const s2 = transcriptReducer(s1, { t: 'optimisticUser', blockId: 'u1', text: 'hi again' });
      expect(s2).toBe(s1); // no-op, not a duplicate insert
    });
  });

  describe('msgUser', () => {
    it('upserts onto the optimistic block and clears the queued flag (echo)', () => {
      const s1 = transcriptReducer(S0, { t: 'optimisticUser', blockId: 'u1', text: 'hi' });
      const s2 = transcriptReducer(s1, { t: 'msgUser', blockId: 'u1', text: 'hi' });
      expect(s2.blocks).toEqual([{ kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi', queued: false }]);
    });

    it('inserts when unseen (echo without an optimistic block)', () => {
      const s = transcriptReducer(S0, { t: 'msgUser', blockId: 'u1', text: 'hi' });
      expect(s.blocks).toEqual([{ kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi', queued: false }]);
    });

    it('is idempotent on replay', () => {
      const s1 = transcriptReducer(S0, { t: 'msgUser', blockId: 'u1', text: 'hi' });
      const s2 = transcriptReducer(s1, { t: 'msgUser', blockId: 'u1', text: 'hi' });
      expect(s2.blocks).toHaveLength(1);
      expect(s2.blocks).toEqual(s1.blocks);
    });

    it('is a no-op when the blockId belongs to a non-user block', () => {
      const s1 = transcriptReducer(S0, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'src/a.ts' });
      const s2 = transcriptReducer(s1, { t: 'msgUser', blockId: 't1', text: 'hi' });
      expect(s2).toBe(s1);
    });
  });

  describe('delta', () => {
    it('inserts a streaming assistant block when unseen', () => {
      const s = transcriptReducer(S0, { t: 'delta', blockId: 'a1', text: 'Hel' });
      expect(s.blocks).toEqual([
        {
          kind: 'assistant',
          blockId: 'a1',
          isStreaming: true,
          glyph: '●',
          glyphColor: '#c8a15a',
          bodyColor: '#dfe2e8',
          text: 'Hel',
        },
      ]);
    });

    it('appends onto the open block', () => {
      const s1 = transcriptReducer(S0, { t: 'delta', blockId: 'a1', text: 'Hel' });
      const s2 = transcriptReducer(s1, { t: 'delta', blockId: 'a1', text: 'lo' });
      expect(s2.blocks).toHaveLength(1);
      const b = s2.blocks[0];
      if (b.kind !== 'assistant') throw new Error('expected assistant block');
      expect(b.text).toBe('Hello');
      expect(b.isStreaming).toBe(true);
    });
  });

  describe('assistantDone', () => {
    it('finalizes the block with the settled colors', () => {
      const s1 = transcriptReducer(S0, { t: 'delta', blockId: 'a1', text: 'Hello' });
      const s2 = transcriptReducer(s1, { t: 'assistantDone', blockId: 'a1' });
      expect(s2.blocks).toEqual([
        {
          kind: 'assistant',
          blockId: 'a1',
          isStreaming: false,
          glyph: '●',
          glyphColor: '#868a93',
          bodyColor: '#c4c7ce',
          text: 'Hello',
        },
      ]);
    });

    it('is idempotent on replay', () => {
      const s1 = transcriptReducer(S0, { t: 'delta', blockId: 'a1', text: 'Hello' });
      const s2 = transcriptReducer(s1, { t: 'assistantDone', blockId: 'a1' });
      const s3 = transcriptReducer(s2, { t: 'assistantDone', blockId: 'a1' });
      expect(s3.blocks).toEqual(s2.blocks);
    });

    it('is a no-op for an unknown blockId', () => {
      expect(transcriptReducer(S0, { t: 'assistantDone', blockId: 'nope' })).toBe(S0);
    });
  });

  describe('toolStart', () => {
    it('inserts the classified tool block, streaming', () => {
      const s = transcriptReducer(S0, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'src/a.ts' });
      expect(s.blocks).toEqual([classifyToolStart('Read', 'src/a.ts', 't1')]);
      expect(s.blocks[0].isStreaming).toBe(true);
    });

    it('is idempotent on replay (existing blockId → same state)', () => {
      const s1 = transcriptReducer(S0, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'src/a.ts' });
      const s2 = transcriptReducer(s1, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'src/a.ts' });
      expect(s2).toBe(s1);
    });
  });

  describe('toolDone', () => {
    it('sets meta and clears isStreaming on a tool block', () => {
      const s1 = transcriptReducer(S0, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'src/a.ts' });
      const s2 = transcriptReducer(s1, { t: 'toolDone', blockId: 't1', meta: '412 lines' });
      const b = s2.blocks[0];
      if (b.kind !== 'tool') throw new Error('expected tool block');
      expect(b.meta).toBe('412 lines');
      expect(b.isStreaming).toBe(false);
    });

    it('finalizes subagent blocks too', () => {
      const s1 = transcriptReducer(S0, { t: 'toolStart', blockId: 't1', tool: 'Task', summary: 'explorer' });
      const s2 = transcriptReducer(s1, { t: 'toolDone', blockId: 't1', meta: 'done in 4s' });
      const b = s2.blocks[0];
      if (b.kind !== 'subagent') throw new Error('expected subagent block');
      expect(b.meta).toBe('done in 4s');
      expect(b.isStreaming).toBe(false);
    });

    it('is idempotent on replay', () => {
      const s1 = transcriptReducer(S0, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'src/a.ts' });
      const s2 = transcriptReducer(s1, { t: 'toolDone', blockId: 't1', meta: '412 lines' });
      const s3 = transcriptReducer(s2, { t: 'toolDone', blockId: 't1', meta: '412 lines' });
      expect(s3.blocks).toEqual(s2.blocks);
    });

    it('is a no-op for an unknown blockId', () => {
      expect(transcriptReducer(S0, { t: 'toolDone', blockId: 'nope', meta: 'x' })).toBe(S0);
    });
  });

  describe('clear', () => {
    it('drops every block (full reset from a non-empty state)', () => {
      const s1: TranscriptState = { blocks: [user('u1', 'hi', false), user('u2', 'there', false)] };
      const s2 = transcriptReducer(s1, { t: 'clear' });
      expect(s2).toEqual({ blocks: [] });
    });
  });

  describe('remove', () => {
    it('removes the block (optimistic rollback on send failure)', () => {
      const s1 = transcriptReducer(S0, { t: 'optimisticUser', blockId: 'u1', text: 'hi' });
      const s2 = transcriptReducer(s1, { t: 'remove', blockId: 'u1' });
      expect(s2.blocks).toEqual([]);
    });

    it('is a no-op for an unknown blockId (same state)', () => {
      const s1 = transcriptReducer(S0, { t: 'optimisticUser', blockId: 'u1', text: 'hi' });
      const s2 = transcriptReducer(s1, { t: 'remove', blockId: 'nope' });
      expect(s2).toBe(s1);
    });
  });
});
