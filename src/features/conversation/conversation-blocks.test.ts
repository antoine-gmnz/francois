// interactive-commands FR-20/21 — transcript apply rules for command.started /
// command.output, live current-model derivation, the high-usage meter threshold,
// and the model-card switch error path. Pure logic only (no DOM).

import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo, AgentStep, CommandCard, McpServerInfo, PermissionAsk, PermissionRule, Result, SessionEvent, SessionQuestion, WorkflowRun } from '../../../contract/common';
import type { CommandConversationBlock } from '../../../contract/interactive-commands';
import type { PermissionConversationBlock } from '../../../contract/permission-guardrails';
import type { QuestionConversationBlock } from '../../../contract/session-questions';
import { classifyToolStart, type ConversationBlock } from '../../../contract/conversation-view';
import {
  applySessionEvent,
  CARD_KIND_COMMAND,
  cardHeaderLabel,
  commandFromCard,
  compactBlocks,
  decideEarlierActivation,
  deriveShowSkeleton,
  drainDeltas,
  earlierRowLabel,
  earlierRowState,
  isClearCommand,
  isKnownEmptySession,
  isTranscriptRelevantEvent,
  liveCurrentModelId,
  mergeDelta,
  meterFillColor,
  pushDelta,
  readingWindowHint,
  RENDER_WINDOW,
  RESTORING_PLACEHOLDER,
  switchModelFromCard,
  transcriptReducer,
  TRANSCRIPT_TEXT_SELECT_STYLE,
  windowedBlocks,
  windowStartIndex,
  type ConversationEventSetters,
  type DeltaChunk,
  type TranscriptState,
} from './conversation-blocks';

const S0: TranscriptState = { blocks: [], windowSize: RENDER_WINDOW };

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
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: '/usage' };
    const s = transcriptReducer({ blocks: [user], windowSize: RENDER_WINDOW }, { t: 'commandStarted', blockId: 'c1', command: 'usage' });
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
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi' };
    const s1: TranscriptState = { blocks: [user], windowSize: RENDER_WINDOW };
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
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'go' };
    const s = transcriptReducer({ blocks: [user], windowSize: RENDER_WINDOW }, { t: 'questionAsked', blockId: 'q1', questions });
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
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi' };
    const s1: TranscriptState = { blocks: [user], windowSize: RENDER_WINDOW };
    const s2 = transcriptReducer(s1, { t: 'questionAsked', blockId: 'u1', questions });
    expect(s2).toBe(s1);
  });

  it('questionResolved is a no-op when the blockId belongs to a non-question block', () => {
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi' };
    const s1: TranscriptState = { blocks: [user], windowSize: RENDER_WINDOW };
    const s2 = transcriptReducer(s1, { t: 'questionResolved', blockId: 'u1', state: 'cancelled' });
    expect(s2).toBe(s1);
  });
});

describe('transcriptReducer — permission.asked / permission.resolved (permission-guardrails FR-24)', () => {
  const ask: PermissionAsk = {
    toolName: 'Bash',
    summary: 'npm test',
    inputJson: '{"command":"npm test"}',
    cwd: '/repo',
    pattern: 'Bash(npm test:*)',
    patternLabel: 'npm test (any arguments)',
  };
  const rule: PermissionRule = {
    id: 'local|allow|Bash(npm test:*)',
    pattern: 'Bash(npm test:*)',
    effect: 'allow',
    tier: 'local',
    enabled: true,
    label: 'npm test (any arguments)',
  };

  function permBlock(s: TranscriptState, blockId: string): PermissionConversationBlock {
    const b = s.blocks.find((x) => x.blockId === blockId);
    if (!b || b.kind !== 'permission') throw new Error(`no permission block ${blockId}`);
    return b;
  }

  it('permissionAsked inserts a pending block (FR-25: isStreaming iff pending)', () => {
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'go' };
    const s = transcriptReducer({ blocks: [user], windowSize: RENDER_WINDOW }, { t: 'permissionAsked', blockId: 'p1', ask });
    expect(s.blocks).toHaveLength(2);
    expect(s.blocks[1]).toEqual({ kind: 'permission', blockId: 'p1', isStreaming: true, ask, state: 'pending' });
    expect(permBlock(s, 'p1')).not.toHaveProperty('rule');
  });

  it('permissionAsked is idempotent on replay', () => {
    const s1 = transcriptReducer(S0, { t: 'permissionAsked', blockId: 'p1', ask });
    const s2 = transcriptReducer(s1, { t: 'permissionAsked', blockId: 'p1', ask });
    expect(s2).toBe(s1); // no-op, not a duplicate insert
  });

  it('permissionResolved allowed: updates state + rule in place, clears isStreaming', () => {
    const s1 = transcriptReducer(S0, { t: 'permissionAsked', blockId: 'p1', ask });
    const s2 = transcriptReducer(s1, { t: 'permissionResolved', blockId: 'p1', state: 'allowed', rule });
    expect(s2.blocks).toHaveLength(1);
    expect(permBlock(s2, 'p1')).toEqual({
      kind: 'permission',
      blockId: 'p1',
      isStreaming: false,
      ask,
      state: 'allowed',
      rule,
    });
  });

  it('a once-decision resolves without a rule property', () => {
    const s1 = transcriptReducer(S0, { t: 'permissionAsked', blockId: 'p1', ask });
    const s2 = transcriptReducer(s1, { t: 'permissionResolved', blockId: 'p1', state: 'denied' });
    expect(permBlock(s2, 'p1').state).toBe('denied');
    expect(permBlock(s2, 'p1')).not.toHaveProperty('rule');
  });

  it('cancelled (interrupt / turn end / app exit) resolves the card in place', () => {
    const s1 = transcriptReducer(S0, { t: 'permissionAsked', blockId: 'p1', ask });
    const s2 = transcriptReducer(s1, { t: 'permissionResolved', blockId: 'p1', state: 'cancelled' });
    expect(permBlock(s2, 'p1')).toEqual({
      kind: 'permission',
      blockId: 'p1',
      isStreaming: false,
      ask,
      state: 'cancelled',
    });
  });

  it('resolved arriving first inserts resolved; a later asked fills the ask in without reviving it', () => {
    const s1 = transcriptReducer(S0, { t: 'permissionResolved', blockId: 'p1', state: 'denied' });
    expect(permBlock(s1, 'p1').state).toBe('denied');
    expect(permBlock(s1, 'p1').ask.toolName).toBe(''); // placeholder
    const s2 = transcriptReducer(s1, { t: 'permissionAsked', blockId: 'p1', ask });
    expect(permBlock(s2, 'p1').ask).toEqual(ask);
    expect(permBlock(s2, 'p1').state).toBe('denied'); // resolution survives
    expect(permBlock(s2, 'p1').isStreaming).toBe(false);
  });

  it('never touches a block of another kind sharing the id', () => {
    const s1 = transcriptReducer(S0, { t: 'commandStarted', blockId: 'x', command: 'usage' });
    expect(transcriptReducer(s1, { t: 'permissionResolved', blockId: 'x', state: 'allowed' })).toBe(s1);
    expect(transcriptReducer(s1, { t: 'permissionAsked', blockId: 'x', ask })).toBe(s1);
  });

  it('/clear drops permission blocks like every other block', () => {
    const s1 = transcriptReducer(S0, { t: 'permissionAsked', blockId: 'p1', ask });
    expect(transcriptReducer(s1, { t: 'clear' }).blocks).toEqual([]);
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
  const user = (blockId: string, text: string): ConversationBlock => ({
    kind: 'user',
    blockId,
    isStreaming: false,
    text,
  });

  describe('seed', () => {
    it('replaces the whole block list (hydration)', () => {
      const s1: TranscriptState = { blocks: [user('u1', 'old')], windowSize: RENDER_WINDOW };
      const seeded = [user('u2', 'restored')];
      const s2 = transcriptReducer(s1, { t: 'seed', blocks: seeded });
      expect(s2.blocks).toEqual(seeded);
    });
  });

  describe('optimisticUser', () => {
    it('appends the optimistic user block (transcript-perf FR-21: no `queued` field)', () => {
      const s = transcriptReducer(S0, { t: 'optimisticUser', blockId: 'u1', text: 'hi' });
      expect(s.blocks).toEqual([{ kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi' }]);
    });

    it('guards against duplicates (existing blockId → same state)', () => {
      const s1 = transcriptReducer(S0, { t: 'optimisticUser', blockId: 'u1', text: 'hi' });
      const s2 = transcriptReducer(s1, { t: 'optimisticUser', blockId: 'u1', text: 'hi again' });
      expect(s2).toBe(s1); // no-op, not a duplicate insert
    });
  });

  describe('msgUser', () => {
    it('upserts onto the optimistic block (echo)', () => {
      const s1 = transcriptReducer(S0, { t: 'optimisticUser', blockId: 'u1', text: 'hi' });
      const s2 = transcriptReducer(s1, { t: 'msgUser', blockId: 'u1', text: 'hi' });
      expect(s2.blocks).toEqual([{ kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi' }]);
    });

    it('inserts when unseen (echo without an optimistic block)', () => {
      const s = transcriptReducer(S0, { t: 'msgUser', blockId: 'u1', text: 'hi' });
      expect(s.blocks).toEqual([{ kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi' }]);
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

  describe('mergeDelta', () => {
    it('appends a chunk that starts exactly where the text ends', () => {
      expect(mergeDelta('Hel', 'lo', 3)).toBe('Hello');
      expect(mergeDelta('', 'Hel', 0)).toBe('Hel');
    });

    it('applies only the new tail of a chunk the text already covers in part', () => {
      // Hydration seeded 'Hello'; the buffered delta that produced 'llo world'
      // starts at offset 2, so only ' world' is new.
      expect(mergeDelta('Hello', 'llo world', 2)).toBe('Hello world');
    });

    it('ignores a chunk the text already covers entirely', () => {
      expect(mergeDelta('Hello world', 'llo', 2)).toBe('Hello world');
      expect(mergeDelta('Hello', 'Hello', 0)).toBe('Hello');
    });

    it('keeps the new text when a chunk went missing rather than losing it too', () => {
      // A gap (offset past the end) cannot be reconstructed here — assistantDone
      // repairs it. Dropping the chunk would only widen the hole.
      expect(mergeDelta('Hel', 'world', 20)).toBe('Helworld');
    });
  });

  describe('delta', () => {
    it('inserts a streaming assistant block when unseen', () => {
      const s = transcriptReducer(S0, { t: 'delta', blockId: 'a1', text: 'Hel', offset: 0 });
      expect(s.blocks).toEqual([
        {
          kind: 'assistant',
          blockId: 'a1',
          isStreaming: true,
          glyph: '●',
          glyphColor: '#c3f53f',
          bodyColor: '#e6e9ef',
          text: 'Hel',
        },
      ]);
    });

    it('appends onto the open block', () => {
      const s1 = transcriptReducer(S0, { t: 'delta', blockId: 'a1', text: 'Hel', offset: 0 });
      const s2 = transcriptReducer(s1, { t: 'delta', blockId: 'a1', text: 'lo', offset: 3 });
      expect(s2.blocks).toHaveLength(1);
      const b = s2.blocks[0];
      if (b.kind !== 'assistant') throw new Error('expected assistant block');
      expect(b.text).toBe('Hello');
      expect(b.isStreaming).toBe(true);
    });

    it('does not duplicate a delta the hydration seed already carried', () => {
      // The core buffers in-flight text, so a mid-block hydration seeds a prefix
      // and then drains the deltas that built it. Offsets make that overlap a
      // no-op instead of a doubled word.
      const seeded = transcriptReducer(S0, {
        t: 'seed',
        blocks: [{ kind: 'assistant', blockId: 'a1', isStreaming: true, glyph: '●', glyphColor: '#c3f53f', bodyColor: '#e6e9ef', text: 'Hello wor' }],
      });
      const drained1 = transcriptReducer(seeded, { t: 'delta', blockId: 'a1', text: 'Hello ', offset: 0 });
      const drained2 = transcriptReducer(drained1, { t: 'delta', blockId: 'a1', text: 'wor', offset: 6 });
      const live = transcriptReducer(drained2, { t: 'delta', blockId: 'a1', text: 'ld', offset: 9 });
      const b = live.blocks[0];
      if (b.kind !== 'assistant') throw new Error('expected assistant block');
      expect(b.text).toBe('Hello world');
    });

    it('returns the same state when the chunk adds nothing (no needless re-render)', () => {
      const s1 = transcriptReducer(S0, { t: 'delta', blockId: 'a1', text: 'Hello', offset: 0 });
      expect(transcriptReducer(s1, { t: 'delta', blockId: 'a1', text: 'ell', offset: 1 })).toBe(s1);
    });
  });

  describe('deltaBatch (transcript-perf FR-5/FR-9: one dispatch per blockId per frame)', () => {
    it('is byte-identical to applying the same chunks one at a time via delta', () => {
      const oneAtATime = ['Hel', 'lo ', 'world'].reduce(
        (s, text, i, arr) =>
          transcriptReducer(s, {
            t: 'delta',
            blockId: 'a1',
            text,
            offset: arr.slice(0, i).join('').length,
          }),
        S0,
      );
      const batched = transcriptReducer(S0, {
        t: 'deltaBatch',
        blockId: 'a1',
        chunks: [
          { text: 'Hel', offset: 0 },
          { text: 'lo ', offset: 3 },
          { text: 'world', offset: 6 },
        ],
      });
      expect(batched.blocks).toEqual(oneAtATime.blocks);
      const b = batched.blocks[0];
      if (b.kind !== 'assistant') throw new Error('expected assistant block');
      expect(b.text).toBe('Hello world');
    });

    it('inserts a streaming assistant block when unseen, folding every chunk into the seed', () => {
      const s = transcriptReducer(S0, {
        t: 'deltaBatch',
        blockId: 'a1',
        chunks: [
          { text: 'Hel', offset: 0 },
          { text: 'lo', offset: 3 },
        ],
      });
      const b = s.blocks[0];
      if (b.kind !== 'assistant') throw new Error('expected assistant block');
      expect(b.text).toBe('Hello');
      expect(b.isStreaming).toBe(true);
    });

    it('appends onto an already-open block', () => {
      const s1 = transcriptReducer(S0, { t: 'delta', blockId: 'a1', text: 'Hel', offset: 0 });
      const s2 = transcriptReducer(s1, {
        t: 'deltaBatch',
        blockId: 'a1',
        chunks: [
          { text: 'lo ', offset: 3 },
          { text: 'world', offset: 6 },
        ],
      });
      const b = s2.blocks[0];
      if (b.kind !== 'assistant') throw new Error('expected assistant block');
      expect(b.text).toBe('Hello world');
    });

    it('returns the same state when the batch adds nothing (no needless re-render)', () => {
      const s1 = transcriptReducer(S0, { t: 'delta', blockId: 'a1', text: 'Hello', offset: 0 });
      const s2 = transcriptReducer(s1, { t: 'deltaBatch', blockId: 'a1', chunks: [{ text: 'ell', offset: 1 }] });
      expect(s2).toBe(s1);
    });
  });

  describe('pushDelta / drainDeltas (the rAF buffer)', () => {
    it('accumulates chunks per blockId, preserving arrival order', () => {
      const buffer = new Map<string, DeltaChunk[]>();
      pushDelta(buffer, 'a1', 'Hel', 0);
      pushDelta(buffer, 'a1', 'lo', 3);
      pushDelta(buffer, 'a2', 'Hi', 0);
      const actions = drainDeltas(buffer);
      expect(actions).toEqual([
        { t: 'deltaBatch', blockId: 'a1', chunks: [{ text: 'Hel', offset: 0 }, { text: 'lo', offset: 3 }] },
        { t: 'deltaBatch', blockId: 'a2', chunks: [{ text: 'Hi', offset: 0 }] },
      ]);
    });

    it('empties the buffer on drain', () => {
      const buffer = new Map<string, DeltaChunk[]>();
      pushDelta(buffer, 'a1', 'Hel', 0);
      drainDeltas(buffer);
      expect(drainDeltas(buffer)).toEqual([]);
      expect(buffer.size).toBe(0);
    });
  });

  describe('assistantDone', () => {
    it('finalizes the block with the settled colors', () => {
      const s1 = transcriptReducer(S0, { t: 'delta', blockId: 'a1', text: 'Hello', offset: 0 });
      const s2 = transcriptReducer(s1, { t: 'assistantDone', blockId: 'a1', text: 'Hello' });
      expect(s2.blocks).toEqual([
        {
          kind: 'assistant',
          blockId: 'a1',
          isStreaming: false,
          glyph: '●',
          glyphColor: '#8b93a3',
          bodyColor: '#c3c9d4',
          text: 'Hello',
        },
      ]);
    });

    it('is idempotent on replay', () => {
      const s1 = transcriptReducer(S0, { t: 'delta', blockId: 'a1', text: 'Hello', offset: 0 });
      const s2 = transcriptReducer(s1, { t: 'assistantDone', blockId: 'a1', text: 'Hello' });
      const s3 = transcriptReducer(s2, { t: 'assistantDone', blockId: 'a1', text: 'Hello' });
      expect(s3.blocks).toEqual(s2.blocks);
    });

    it('repairs a block that lost a chunk mid-stream with the authoritative text', () => {
      const s1 = transcriptReducer(S0, { t: 'delta', blockId: 'a1', text: 'Hello ', offset: 0 });
      // ' cruel' never arrived — the block is short until the block closes.
      const s2 = transcriptReducer(s1, { t: 'delta', blockId: 'a1', text: 'world', offset: 12 });
      const s3 = transcriptReducer(s2, { t: 'assistantDone', blockId: 'a1', text: 'Hello cruel world' });
      const b = s3.blocks[0];
      if (b.kind !== 'assistant') throw new Error('expected assistant block');
      expect(b.text).toBe('Hello cruel world');
    });

    it('inserts the finished block when every delta for it was missed', () => {
      const s = transcriptReducer(S0, { t: 'assistantDone', blockId: 'a1', text: 'Hello' });
      expect(s.blocks).toEqual([
        {
          kind: 'assistant',
          blockId: 'a1',
          isStreaming: false,
          glyph: '●',
          glyphColor: '#8b93a3',
          bodyColor: '#c3c9d4',
          text: 'Hello',
        },
      ]);
    });

    it('is a no-op when the blockId belongs to a non-assistant block', () => {
      const s1 = transcriptReducer(S0, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'src/a.ts' });
      expect(transcriptReducer(s1, { t: 'assistantDone', blockId: 't1', text: 'Hello' })).toBe(s1);
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

    it("carries a dispatch's own model onto the subagent block", () => {
      // A subagent can run on a model other than the session's — the banner
      // names it. A dispatch that named none carries no key at all.
      const s = transcriptReducer(S0, { t: 'toolStart', blockId: 't1', tool: 'Agent', summary: 'reviewer', model: 'opus' });
      const b = s.blocks[0];
      if (b.kind !== 'subagent') throw new Error('expected subagent block');
      expect(b.agentModel).toBe('opus');

      const inherited = transcriptReducer(S0, { t: 'toolStart', blockId: 't2', tool: 'Agent', summary: 'reviewer' });
      expect(inherited.blocks[0]).not.toHaveProperty('agentModel');
    });

    it('never puts a model on a plain tool block', () => {
      const s = transcriptReducer(S0, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'src/a.ts', model: 'opus' });
      expect(s.blocks[0]).toEqual(classifyToolStart('Read', 'src/a.ts', 't1'));
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

    // command-inspect FR-10/FR-12: the chevron only exists because tool.done said
    // a StepDetail record was written.
    it('carries hasDetail onto the tool block when the event set it', () => {
      const s1 = transcriptReducer(S0, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'src/a.ts' });
      const s2 = transcriptReducer(s1, { t: 'toolDone', blockId: 't1', meta: '412 lines', hasDetail: true });
      const b = s2.blocks[0];
      if (b.kind !== 'tool') throw new Error('expected tool block');
      expect(b.hasDetail).toBe(true);
    });

    it('leaves hasDetail unset when the event omitted it (pre-feature step)', () => {
      const s1 = transcriptReducer(S0, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'src/a.ts' });
      const s2 = transcriptReducer(s1, { t: 'toolDone', blockId: 't1', meta: '412 lines' });
      const b = s2.blocks[0];
      if (b.kind !== 'tool') throw new Error('expected tool block');
      expect(b.hasDetail).toBeUndefined();
    });

    it('a later meta-only tool.done never erases an established hasDetail', () => {
      const s1 = transcriptReducer(S0, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'src/a.ts' });
      const s2 = transcriptReducer(s1, { t: 'toolDone', blockId: 't1', meta: '412 lines', hasDetail: true });
      const s3 = transcriptReducer(s2, { t: 'toolDone', blockId: 't1', meta: '412 lines' });
      const b = s3.blocks[0];
      if (b.kind !== 'tool') throw new Error('expected tool block');
      expect(b.hasDetail).toBe(true);
    });

    it('never puts hasDetail on a subagent block (FR-8)', () => {
      const s1 = transcriptReducer(S0, { t: 'toolStart', blockId: 't1', tool: 'Task', summary: 'explorer' });
      const s2 = transcriptReducer(s1, { t: 'toolDone', blockId: 't1', meta: 'done in 4s', hasDetail: true });
      const b = s2.blocks[0];
      if (b.kind !== 'subagent') throw new Error('expected subagent block');
      expect('hasDetail' in b).toBe(false);
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
      const s1: TranscriptState = { blocks: [user('u1', 'hi'), user('u2', 'there')], windowSize: RENDER_WINDOW };
      const s2 = transcriptReducer(s1, { t: 'clear' });
      expect(s2).toEqual({ blocks: [], windowSize: RENDER_WINDOW });
    });

    it('resets an already-widened window (transcript-scale FR-15)', () => {
      const s1: TranscriptState = { blocks: [user('u1', 'hi')], windowSize: RENDER_WINDOW * 3 };
      const s2 = transcriptReducer(s1, { t: 'clear' });
      expect(s2).toEqual({ blocks: [], windowSize: RENDER_WINDOW });
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

  describe('windowSize is carried unchanged through every ordinary action (transcript-scale)', () => {
    const widened: TranscriptState = { blocks: [], windowSize: RENDER_WINDOW * 2 };

    it('optimisticUser / msgUser / toolStart / commandStarted append without touching windowSize', () => {
      expect(transcriptReducer(widened, { t: 'optimisticUser', blockId: 'u1', text: 'hi' }).windowSize).toBe(RENDER_WINDOW * 2);
      expect(transcriptReducer(widened, { t: 'msgUser', blockId: 'u1', text: 'hi' }).windowSize).toBe(RENDER_WINDOW * 2);
      expect(transcriptReducer(widened, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'a.ts' }).windowSize).toBe(RENDER_WINDOW * 2);
      expect(transcriptReducer(widened, { t: 'commandStarted', blockId: 'c1', command: 'usage' }).windowSize).toBe(RENDER_WINDOW * 2);
    });

    it('delta / deltaBatch / assistantDone / toolDone (replace-in-place) preserve windowSize', () => {
      const withAssistant = transcriptReducer(widened, { t: 'delta', blockId: 'a1', text: 'Hel', offset: 0 });
      expect(withAssistant.windowSize).toBe(RENDER_WINDOW * 2);
      expect(transcriptReducer(withAssistant, { t: 'deltaBatch', blockId: 'a1', chunks: [{ text: 'lo', offset: 3 }] }).windowSize).toBe(
        RENDER_WINDOW * 2,
      );
      expect(transcriptReducer(withAssistant, { t: 'assistantDone', blockId: 'a1', text: 'Hello' }).windowSize).toBe(RENDER_WINDOW * 2);
      const withTool = transcriptReducer(widened, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'a.ts' });
      expect(transcriptReducer(withTool, { t: 'toolDone', blockId: 't1', meta: '10 lines' }).windowSize).toBe(RENDER_WINDOW * 2);
    });

    it('remove preserves windowSize', () => {
      const withUser = transcriptReducer(widened, { t: 'optimisticUser', blockId: 'u1', text: 'hi' });
      expect(transcriptReducer(withUser, { t: 'remove', blockId: 'u1' }).windowSize).toBe(RENDER_WINDOW * 2);
    });
  });

  describe('expandWindow (transcript-scale FR-13)', () => {
    it('grows windowSize by one RENDER_WINDOW page and leaves blocks untouched', () => {
      const s1: TranscriptState = { blocks: [user('u1', 'a'), user('u2', 'b')], windowSize: RENDER_WINDOW };
      const s2 = transcriptReducer(s1, { t: 'expandWindow' });
      expect(s2.windowSize).toBe(RENDER_WINDOW * 2);
      expect(s2.blocks).toBe(s1.blocks);
    });
  });

  describe('prepend (transcript-scale FR-13)', () => {
    it('prepends oldest-first and grows windowSize by the number of NEW blocks added', () => {
      const s1: TranscriptState = { blocks: [user('u3', 'held')], windowSize: RENDER_WINDOW };
      const page = [user('u1', 'older'), user('u2', 'less old')];
      const s2 = transcriptReducer(s1, { t: 'prepend', blocks: page });
      expect(s2.blocks.map((b) => b.blockId)).toEqual(['u1', 'u2', 'u3']);
      expect(s2.windowSize).toBe(RENDER_WINDOW + 2);
    });

    it('never duplicates a block already held — returns the same state when the whole page is already present', () => {
      const s1: TranscriptState = { blocks: [user('u1', 'a'), user('u2', 'b')], windowSize: RENDER_WINDOW };
      const s2 = transcriptReducer(s1, { t: 'prepend', blocks: [user('u1', 'a')] });
      expect(s2).toBe(s1);
    });

    it('drops only the already-held blocks from a partially-overlapping page', () => {
      const s1: TranscriptState = { blocks: [user('u2', 'b')], windowSize: RENDER_WINDOW };
      const s2 = transcriptReducer(s1, { t: 'prepend', blocks: [user('u1', 'a'), user('u2', 'b')] });
      expect(s2.blocks.map((b) => b.blockId)).toEqual(['u1', 'u2']);
      expect(s2.windowSize).toBe(RENDER_WINDOW + 1); // only u1 was actually new
    });
  });
});

describe('windowedBlocks (transcript-scale FR-11: the DOM-bound trailing slice)', () => {
  it('renders only the trailing windowSize blocks', () => {
    const blocks = Array.from({ length: 5 }, (_, i) => ({
      kind: 'user' as const,
      blockId: `u${i}`,
      isStreaming: false,
      text: String(i),
    }));
    const state: TranscriptState = { blocks, windowSize: 2 };
    expect(windowedBlocks(state).map((b) => b.blockId)).toEqual(['u3', 'u4']);
  });

  it('renders every block when windowSize exceeds the total held', () => {
    const blocks = [
      { kind: 'user' as const, blockId: 'u1', isStreaming: false, text: 'a' },
      { kind: 'user' as const, blockId: 'u2', isStreaming: false, text: 'b' },
    ];
    const state: TranscriptState = { blocks, windowSize: RENDER_WINDOW };
    expect(windowedBlocks(state)).toEqual(blocks);
  });

  // quality fix: a raw trailing-count cut can land mid-run inside a multi-tool
  // assistant turn (groupTurns folds consecutive assistant/tool/subagent blocks
  // into ONE turn) — the window must extend back to the nearest turn boundary
  // instead of splitting that turn's earlier tool calls from its later ones.
  const assistant = (blockId: string): ConversationBlock => ({
    kind: 'assistant',
    blockId,
    isStreaming: false,
    glyph: '●',
    glyphColor: '#8b93a3',
    bodyColor: '#c3c9d4',
    text: blockId,
  });
  const toolCall = (blockId: string): ConversationBlock => ({ ...classifyToolStart('Read', 'x', blockId), isStreaming: false });
  const userBlock = (blockId: string): ConversationBlock => ({ kind: 'user', blockId, isStreaming: false, text: blockId });

  it('extends the window backward to the start of a turn a raw count would cut in half', () => {
    // one turn: assistant prose + 2 tool calls (a1, t1, t2) — a raw slice(-2)
    // would keep only [t1, t2] and silently drop a1's lead-in.
    const blocks = [userBlock('u1'), assistant('a1'), toolCall('t1'), toolCall('t2')];
    const state: TranscriptState = { blocks, windowSize: 2 };
    expect(windowStartIndex(blocks, 2)).toBe(1); // backs up past a1/t1's shared run to a1
    expect(windowedBlocks(state).map((b) => b.blockId)).toEqual(['a1', 't1', 't2']);
  });

  it('does not extend when the raw cut already lands on a turn boundary', () => {
    const blocks = [userBlock('u1'), assistant('a1'), toolCall('t1'), userBlock('u2')];
    const state: TranscriptState = { blocks, windowSize: 1 };
    expect(windowStartIndex(blocks, 1)).toBe(3); // u2 already opens its own turn
    expect(windowedBlocks(state).map((b) => b.blockId)).toEqual(['u2']);
  });

  it('never backs up past index 0 even if the whole array is one open run', () => {
    const blocks = [assistant('a1'), toolCall('t1'), toolCall('t2')];
    expect(windowStartIndex(blocks, 1)).toBe(0);
  });
});

describe('earlierRowState (transcript-scale FR-12 + design brief "Data shown")', () => {
  it('is invisible when every held block is already rendered and there is nothing more on disk', () => {
    const state: TranscriptState = { blocks: [{ kind: 'user', blockId: 'u1', isStreaming: false, text: 'a' }], windowSize: RENDER_WINDOW };
    expect(earlierRowState(state, false)).toEqual({ visible: false, count: 0 });
  });

  it('states the exact count of held-but-unrendered blocks once hasMore is false', () => {
    const blocks = Array.from({ length: 10 }, (_, i) => ({ kind: 'user' as const, blockId: `u${i}`, isStreaming: false, text: '' }));
    const state: TranscriptState = { blocks, windowSize: 4 };
    expect(earlierRowState(state, false)).toEqual({ visible: true, count: 6 });
  });

  it('is indefinite (count: null) whenever hasMore is true, even with held-but-unrendered blocks', () => {
    const blocks = Array.from({ length: 10 }, (_, i) => ({ kind: 'user' as const, blockId: `u${i}`, isStreaming: false, text: '' }));
    const state: TranscriptState = { blocks, windowSize: 4 };
    expect(earlierRowState(state, true)).toEqual({ visible: true, count: null });
  });

  it('is visible with an indefinite count even when the whole held buffer is fully rendered', () => {
    const state: TranscriptState = { blocks: [{ kind: 'user', blockId: 'u1', isStreaming: false, text: 'a' }], windowSize: RENDER_WINDOW };
    expect(earlierRowState(state, true)).toEqual({ visible: true, count: null });
  });
});

describe('earlierRowLabel (design brief: singular / plural / indefinite, thousands-separated)', () => {
  it('states the indefinite form with no figure', () => {
    expect(earlierRowLabel(null)).toBe('▲ earlier blocks');
  });
  it('states the singular form for exactly one', () => {
    expect(earlierRowLabel(1)).toBe('▲ 1 earlier block');
  });
  it('states the plural form, thousands-separated', () => {
    expect(earlierRowLabel(2)).toBe('▲ 2 earlier blocks');
    expect(earlierRowLabel(2140)).toBe('▲ 2,140 earlier blocks');
    expect(earlierRowLabel(0)).toBe('▲ 0 earlier blocks');
  });
});

describe('decideEarlierActivation (transcript-scale FR-13)', () => {
  it('expands in place when the reducer already holds blocks beyond the window', () => {
    const blocks = Array.from({ length: 10 }, (_, i) => ({ kind: 'user' as const, blockId: `u${i}`, isStreaming: false, text: '' }));
    const state: TranscriptState = { blocks, windowSize: 4 };
    expect(decideEarlierActivation(state, true, false)).toEqual({ kind: 'expand' });
    expect(decideEarlierActivation(state, false, false)).toEqual({ kind: 'expand' }); // held blocks win even without hasMore
  });

  it('fetches a page keyed on the oldest held block once the window has caught up and hasMore is true', () => {
    const state: TranscriptState = { blocks: [{ kind: 'user', blockId: 'u1', isStreaming: false, text: 'a' }], windowSize: RENDER_WINDOW };
    expect(decideEarlierActivation(state, true, false)).toEqual({ kind: 'fetch', before: 'u1' });
  });

  it('does nothing once the window has caught up and hasMore is false (exhausted)', () => {
    const state: TranscriptState = { blocks: [{ kind: 'user', blockId: 'u1', isStreaming: false, text: 'a' }], windowSize: RENDER_WINDOW };
    expect(decideEarlierActivation(state, false, false)).toEqual({ kind: 'none' });
  });

  it('does nothing while a page is already in flight, even if one would otherwise be fetched', () => {
    const state: TranscriptState = { blocks: [{ kind: 'user', blockId: 'u1', isStreaming: false, text: 'a' }], windowSize: RENDER_WINDOW };
    expect(decideEarlierActivation(state, true, true)).toEqual({ kind: 'none' });
  });

  it('does nothing on a genuinely empty transcript', () => {
    const state: TranscriptState = { blocks: [], windowSize: RENDER_WINDOW };
    expect(decideEarlierActivation(state, true, false)).toEqual({ kind: 'none' });
  });
});

describe('CARD_KIND_COMMAND (interactive-commands §8 — shared with CommandCard.tsx)', () => {
  it('is the table commandFromCard delegates to for every kind', () => {
    for (const card of [usageCard, costCard, noticeCard]) {
      expect(CARD_KIND_COMMAND[card.kind](card as never)).toBe(commandFromCard(card));
    }
  });
});

describe('applySessionEvent (conversation-view FR-8/9/10 — the former route(e) switch)', () => {
  function newSetters(): ConversationEventSetters {
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

  it('session.status → setStatus', () => {
    const dispatch = vi.fn();
    const setters = newSetters();
    applySessionEvent(dispatch, setters, { type: 'session.status', sessionId: 'x', status: 'running' });
    expect(setters.setStatus).toHaveBeenCalledWith('running');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('session.meta → setStatus + setErrorMessage from the snapshot', () => {
    const dispatch = vi.fn();
    const setters = newSetters();
    const meta = {
      id: 'x',
      name: 's',
      cwd: '/repo',
      model: { id: 'claude-opus-4', label: 'Opus' },
      status: 'error' as const,
      contextUsedTokens: 0,
      contextLimitTokens: 0,
      startedAt: 0,
      lastActivityAt: 0,
      errorMessage: 'boom',
      permissionMode: 'default' as const,
      permissionModeSince: 0 as const,
      runtime: 'native' as const,
      accountId: 'default',
      agentRuntime: 'claude-code' as const,
      protocol: 'anthropic' as const,
      responseMode: 'default' as const,
      allowGit: false,
    };
    applySessionEvent(dispatch, setters, { type: 'session.meta', meta });
    expect(setters.setStatus).toHaveBeenCalledWith('error');
    expect(setters.setErrorMessage).toHaveBeenCalledWith('boom');
  });

  it('session.error → setErrorMessage + setStatus("error")', () => {
    const dispatch = vi.fn();
    const setters = newSetters();
    applySessionEvent(dispatch, setters, {
      type: 'session.error',
      sessionId: 'x',
      error: { code: 'SPAWN_FAILED', message: 'nope' },
    });
    expect(setters.setErrorMessage).toHaveBeenCalledWith('nope');
    expect(setters.setStatus).toHaveBeenCalledWith('error');
    expect(setters.setLimitNotice).not.toHaveBeenCalled();
  });

  it('session.error USAGE_LIMIT → the banner, and NOT the terminal error state', () => {
    // THE BUG: a usage-limit failure used to flip the view to `error`, which
    // disables the composer — and nothing is emitted when the plan window
    // resets, so the input never came back. The core keeps the session idle;
    // this handler must not overrule it.
    const dispatch = vi.fn();
    const setters = newSetters();
    applySessionEvent(dispatch, setters, {
      type: 'session.error',
      sessionId: 'x',
      error: { code: 'USAGE_LIMIT', message: 'Claude AI usage limit reached|1753272000' },
    });
    expect(setters.setLimitNotice).toHaveBeenCalledWith('Claude AI usage limit reached|1753272000');
    expect(setters.setStatus).not.toHaveBeenCalled();
    expect(setters.setErrorMessage).not.toHaveBeenCalled();
  });

  it('context.usage → patchUsage(usedTokens, limitTokens)', () => {
    const dispatch = vi.fn();
    const setters = newSetters();
    applySessionEvent(dispatch, setters, { type: 'context.usage', sessionId: 'x', usedTokens: 10, limitTokens: 100 });
    expect(setters.patchUsage).toHaveBeenCalledWith(10, 100);
  });

  it('message.user → dispatches msgUser and clears the resume-fail notice (FR-14)', () => {
    const dispatch = vi.fn();
    const setters = newSetters();
    applySessionEvent(dispatch, setters, { type: 'message.user', sessionId: 'x', blockId: 'b1', text: 'hi' });
    expect(dispatch).toHaveBeenCalledWith({ t: 'msgUser', blockId: 'b1', text: 'hi' });
    expect(setters.setResumeFailed).toHaveBeenCalledWith(false);
    // …and the usage-limit banner: the user is retrying, so the old notice goes.
    expect(setters.setLimitNotice).toHaveBeenCalledWith(null);
  });

  it('session.resumeFailed → setResumeFailed(true)', () => {
    const dispatch = vi.fn();
    const setters = newSetters();
    applySessionEvent(dispatch, setters, { type: 'session.resumeFailed', sessionId: 'x' });
    expect(setters.setResumeFailed).toHaveBeenCalledWith(true);
  });

  it('session.cleared → dispatches clear, resets resume-fail, re-pins and clears hasMore', () => {
    const dispatch = vi.fn();
    const setters = newSetters();
    applySessionEvent(dispatch, setters, { type: 'session.cleared', sessionId: 'x' });
    expect(dispatch).toHaveBeenCalledWith({ t: 'clear' });
    expect(setters.setResumeFailed).toHaveBeenCalledWith(false);
    expect(setters.setPinned).toHaveBeenCalledWith(true);
    expect(setters.setHasMore).toHaveBeenCalledWith(false); // transcript-scale FR-15
  });

  it('assistant.delta / assistant.done / tool.start / tool.done forward to the reducer verbatim', () => {
    const dispatch = vi.fn();
    const setters = newSetters();
    applySessionEvent(dispatch, setters, { type: 'assistant.delta', sessionId: 'x', blockId: 'b1', text: 'He', offset: 4 });
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'delta', blockId: 'b1', text: 'He', offset: 4 });
    applySessionEvent(dispatch, setters, { type: 'assistant.done', sessionId: 'x', blockId: 'b1', text: 'Hi He' });
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'assistantDone', blockId: 'b1', text: 'Hi He' });
    applySessionEvent(dispatch, setters, { type: 'tool.start', sessionId: 'x', blockId: 't1', tool: 'Read', summary: 'a.ts' });
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'a.ts', model: undefined });
    // the dispatch's model rides the same event when the core sent one
    applySessionEvent(dispatch, setters, { type: 'tool.start', sessionId: 'x', blockId: 't2', tool: 'Agent', summary: 'reviewer', model: 'haiku' });
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'toolStart', blockId: 't2', tool: 'Agent', summary: 'reviewer', model: 'haiku' });
    applySessionEvent(dispatch, setters, { type: 'tool.done', sessionId: 'x', blockId: 't1', meta: '10 lines' });
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'toolDone', blockId: 't1', meta: '10 lines', hasDetail: undefined });
    // command-inspect FR-10: hasDetail rides the same event when core wrote a record
    applySessionEvent(dispatch, setters, { type: 'tool.done', sessionId: 'x', blockId: 't2', meta: '10 lines', hasDetail: true });
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'toolDone', blockId: 't2', meta: '10 lines', hasDetail: true });
  });

  it('command.started / command.output forward to the reducer (interactive-commands FR-20)', () => {
    const dispatch = vi.fn();
    const setters = newSetters();
    applySessionEvent(dispatch, setters, { type: 'command.started', sessionId: 'x', blockId: 'c1', command: 'usage' });
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'commandStarted', blockId: 'c1', command: 'usage' });
    applySessionEvent(dispatch, setters, { type: 'command.output', sessionId: 'x', blockId: 'c1', card: usageCard });
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'commandOutput', blockId: 'c1', card: usageCard });
  });

  it('question.asked / question.resolved forward to the reducer (session-questions FR-16)', () => {
    const dispatch = vi.fn();
    const setters = newSetters();
    const questions: SessionQuestion[] = [];
    applySessionEvent(dispatch, setters, { type: 'question.asked', sessionId: 'x', blockId: 'q1', questions });
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'questionAsked', blockId: 'q1', questions });
    applySessionEvent(dispatch, setters, { type: 'question.resolved', sessionId: 'x', blockId: 'q1', state: 'answered', answers: { a: 'b' } });
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'questionResolved', blockId: 'q1', state: 'answered', answers: { a: 'b' } });
  });

  it('permission.asked / permission.resolved forward to the reducer (permission-guardrails FR-24)', () => {
    const dispatch = vi.fn();
    const setters = newSetters();
    const ask: PermissionAsk = { toolName: 'Bash', summary: 'npm test', inputJson: '{}', cwd: '/repo', pattern: '*', patternLabel: '*' };
    applySessionEvent(dispatch, setters, { type: 'permission.asked', sessionId: 'x', blockId: 'p1', ask });
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'permissionAsked', blockId: 'p1', ask });
    applySessionEvent(dispatch, setters, { type: 'permission.resolved', sessionId: 'x', blockId: 'p1', state: 'denied' });
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'permissionResolved', blockId: 'p1', state: 'denied', rule: undefined });
  });

  it('session.commands → setCommands (slash-menu FR-10)', () => {
    const dispatch = vi.fn();
    const setters = newSetters();
    const commands = [{ name: 'usage', description: '', source: 'builtin' as const }];
    applySessionEvent(dispatch, setters, { type: 'session.commands', sessionId: 'x', commands });
    expect(setters.setCommands).toHaveBeenCalledWith(commands);
  });

  it('ignores event types this view does not own (session.removed / agent.update / agent.step / mcp.update)', () => {
    const dispatch = vi.fn();
    const setters = newSetters();
    const agent: AgentInfo = {
      id: 'a1',
      sessionId: 'x',
      name: 'explorer',
      task: 'look around',
      status: 'running',
      startedAt: 0,
      background: false,
      stepCount: 0,
    };
    const step: AgentStep = { seq: 1, kind: 'text', at: 0, label: 'thinking' };
    const server: McpServerInfo = { name: 'fs', status: 'connected' };
    const ignored: SessionEvent[] = [
      { type: 'session.removed', sessionId: 'x' },
      { type: 'agent.update', agent },
      { type: 'agent.step', sessionId: 'x', agentId: 'a1', step },
      { type: 'mcp.update', sessionId: 'x', server },
    ];
    for (const e of ignored) applySessionEvent(dispatch, setters, e);
    expect(dispatch).not.toHaveBeenCalled();
    for (const fn of Object.values(setters)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('isTranscriptRelevantEvent (transcript-scale FR-21 regression fix)', () => {
  it('rejects agent.update and workflow.update — both carry no sessionId, so the router broadcasts them to every session', () => {
    const agent: AgentInfo = {
      id: 'a1',
      sessionId: 'x',
      name: 'explorer',
      task: 'look around',
      status: 'running',
      startedAt: 0,
      background: false,
      stepCount: 0,
    };
    const run: WorkflowRun = {
      id: 'w1',
      sessionId: 'x',
      name: 'plan',
      description: '',
      status: 'running',
      startedAt: 0,
      phases: [],
    };
    expect(isTranscriptRelevantEvent({ type: 'agent.update', agent })).toBe(false);
    expect(isTranscriptRelevantEvent({ type: 'workflow.update', run })).toBe(false);
  });

  it('accepts every other event type, including this session’s own agent.step/mcp.update', () => {
    const step: AgentStep = { seq: 1, kind: 'text', at: 0, label: 'thinking' };
    const server: McpServerInfo = { name: 'fs', status: 'connected' };
    expect(isTranscriptRelevantEvent({ type: 'session.status', sessionId: 'x', status: 'running' })).toBe(true);
    expect(isTranscriptRelevantEvent({ type: 'assistant.delta', sessionId: 'x', blockId: 'b1', text: 'hi', offset: 0 })).toBe(true);
    expect(isTranscriptRelevantEvent({ type: 'agent.step', sessionId: 'x', agentId: 'a1', step })).toBe(true);
    expect(isTranscriptRelevantEvent({ type: 'mcp.update', sessionId: 'x', server })).toBe(true);
  });
});

describe('compactBlocks (render-time merge of duplicate consecutive tool rows)', () => {
  const tool = (blockId: string, name: string, summary: string, meta?: string): ConversationBlock => ({
    ...classifyToolStart(name, summary, blockId),
    isStreaming: meta === undefined,
    ...(meta !== undefined ? { meta } : {}),
  });

  it('merges consecutive edits of the same file, summing the +N −M metas', () => {
    const out = compactBlocks([
      tool('t1', 'Edit', 'src/a.ts', '+3 −1'),
      tool('t2', 'Edit', 'src/a.ts', '+5 −2'),
    ]);
    expect(out).toHaveLength(1);
    const b = out[0];
    if (b.kind !== 'tool') throw new Error('expected tool block');
    expect(b.blockId).toBe('t2'); // newest block keys the row
    expect(b.meta).toBe('+8 −3');
  });

  it('accumulates across a run of three', () => {
    const out = compactBlocks([
      tool('t1', 'Edit', 'src/a.ts', '+3 −1'),
      tool('t2', 'Edit', 'src/a.ts', '+5 −2'),
      tool('t3', 'Edit', 'src/a.ts', '+2 −0'),
    ]);
    expect(out).toHaveLength(1);
    const b = out[0];
    if (b.kind !== 'tool') throw new Error('expected tool block');
    expect(b.meta).toBe('+10 −3');
  });

  it('keeps the last meta when metas are not line-change shaped', () => {
    const out = compactBlocks([
      tool('t1', 'Read', 'src/a.ts', '50 lines'),
      tool('t2', 'Read', 'src/a.ts', '412 lines'),
    ]);
    expect(out).toHaveLength(1);
    const b = out[0];
    if (b.kind !== 'tool') throw new Error('expected tool block');
    expect(b.meta).toBe('412 lines');
  });

  it('does not merge different files or different tools', () => {
    const out = compactBlocks([
      tool('t1', 'Edit', 'src/a.ts', '+3 −1'),
      tool('t2', 'Edit', 'src/b.ts', '+5 −2'),
      tool('t3', 'Write', 'src/b.ts', '12 lines'),
    ]);
    expect(out).toHaveLength(3);
  });

  it('does not merge across an intervening non-tool block', () => {
    const assistant: ConversationBlock = {
      kind: 'assistant',
      blockId: 'a1',
      isStreaming: false,
      glyph: '●',
      glyphColor: '#8b93a3',
      bodyColor: '#c3c9d4',
      text: 'now the second edit',
    };
    const out = compactBlocks([
      tool('t1', 'Edit', 'src/a.ts', '+3 −1'),
      assistant,
      tool('t2', 'Edit', 'src/a.ts', '+5 −2'),
    ]);
    expect(out).toHaveLength(3);
  });

  it('never merges an error row (errors stay visible and break the run)', () => {
    const out = compactBlocks([
      tool('t1', 'Edit', 'src/a.ts', '+3 −1'),
      tool('t2', 'Edit', 'src/a.ts', 'error'),
      tool('t3', 'Edit', 'src/a.ts', '+5 −2'),
    ]);
    expect(out).toHaveLength(3);
  });

  it('a still-streaming newest edit keeps the run total and the streaming state', () => {
    const out = compactBlocks([
      tool('t1', 'Edit', 'src/a.ts', '+3 −1'),
      tool('t2', 'Edit', 'src/a.ts'),
    ]);
    expect(out).toHaveLength(1);
    const b = out[0];
    if (b.kind !== 'tool') throw new Error('expected tool block');
    expect(b.blockId).toBe('t2');
    expect(b.isStreaming).toBe(true);
    expect(b.meta).toBe('+3 −1');
  });

  it('leaves subagent blocks alone even with identical names', () => {
    const out = compactBlocks([
      tool('t1', 'Task', 'explorer', 'done in 4s'),
      tool('t2', 'Task', 'explorer', 'done in 2s'),
    ]);
    expect(out).toHaveLength(2);
  });
});


describe('TRANSCRIPT_TEXT_SELECT_STYLE (mac-text-selection FR-1)', () => {
  it('sets both the standard and WebKit-prefixed user-select properties to text', () => {
    // WKWebView (macOS) has a documented history of ignoring the unprefixed
    // property for drag-to-select; Windows/Linux already honor it unprefixed
    // (FR-5 regression guard), so both must be present and both must be 'text'.
    expect(TRANSCRIPT_TEXT_SELECT_STYLE.userSelect).toBe('text');
    expect(TRANSCRIPT_TEXT_SELECT_STYLE.WebkitUserSelect).toBe('text');
  });
});

describe('transcriptReducer — a delta on one block never disturbs another (mac-text-selection FR-4)', () => {
  it('leaves an earlier block referentially unchanged while a later block streams', () => {
    // A live browser selection anchored inside `user`'s DOM subtree must survive
    // an assistant.delta appending elsewhere: React only re-renders the DOM for
    // blocks whose props changed, and this asserts `user` never becomes a new
    // object (nor moves) across two delta dispatches targeting a different block.
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'earlier message' };
    const s1: TranscriptState = { blocks: [user], windowSize: RENDER_WINDOW };
    const s2 = transcriptReducer(s1, { t: 'delta', blockId: 'a1', text: 'Hel', offset: 0 });
    const s3 = transcriptReducer(s2, { t: 'delta', blockId: 'a1', text: 'lo', offset: 3 });
    expect(s2.blocks[0]).toBe(user);
    expect(s3.blocks[0]).toBe(user);
    expect(s3.blocks[0]).toBe(s2.blocks[0]);
  });

  it('keeps every sibling block referentially stable across a run of deltas on one block', () => {
    const a: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'a' };
    const b: ConversationBlock = { kind: 'user', blockId: 'u2', isStreaming: false, text: 'b' };
    let s: TranscriptState = { blocks: [a, b], windowSize: RENDER_WINDOW };
    let offset = 0;
    for (const chunk of ['Hel', 'lo ', 'wor', 'ld']) {
      s = transcriptReducer(s, { t: 'delta', blockId: 'a1', text: chunk, offset });
      offset += chunk.length;
    }
    expect(s.blocks[0]).toBe(a);
    expect(s.blocks[1]).toBe(b);
  });
});

describe('compactBlocks preserves block identity for untouched blocks (mac-text-selection FR-4)', () => {
  it('returns the same object references for blocks it does not merge', () => {
    // compactBlocks runs on every ConversationView render, right before the
    // key={b.blockId} map to <Block>. If it recreated non-merged blocks the
    // reconciler would still key them the same, but keeping reference identity
    // here is the cheapest guarantee that unrelated re-renders stay no-ops.
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi' };
    const assistant: ConversationBlock = {
      kind: 'assistant',
      blockId: 'a1',
      isStreaming: true,
      glyph: '●',
      glyphColor: '#c3f53f',
      bodyColor: '#e6e9ef',
      text: 'Hello',
    };
    const out = compactBlocks([user, assistant]);
    expect(out[0]).toBe(user);
    expect(out[1]).toBe(assistant);
  });
});

describe('isKnownEmptySession (session-switch-loader FR-3)', () => {
  it('is known-empty when contextUsedTokens is 0', () => {
    expect(isKnownEmptySession(0)).toBe(true);
  });

  it('is known-empty when no SessionMeta reached this pane (undefined)', () => {
    expect(isKnownEmptySession(undefined)).toBe(true);
  });

  it('is NOT known-empty for any positive token count', () => {
    expect(isKnownEmptySession(1)).toBe(false);
    expect(isKnownEmptySession(48_000)).toBe(false);
  });
});

describe('deriveShowSkeleton (session-switch-loader FR-2/FR-3/FR-11 — one case per input)', () => {
  it('false before the 140ms gate elapses (delayedActive false)', () => {
    expect(deriveShowSkeleton(false, false, null, false)).toBe(false);
  });

  it('false once hydrated, even if delayedActive has not caught up yet', () => {
    expect(deriveShowSkeleton(true, true, null, false)).toBe(false);
  });

  it('false the instant hydrationError is set', () => {
    expect(deriveShowSkeleton(true, false, 'spawn failed', false)).toBe(false);
  });

  it('false for a known-empty session however long hydration takes', () => {
    expect(deriveShowSkeleton(true, false, null, true)).toBe(false);
  });

  it('true only when every gate is open: past the delay, not hydrated, no error, not known-empty', () => {
    expect(deriveShowSkeleton(true, false, null, false)).toBe(true);
  });
});

describe('RESTORING_PLACEHOLDER (session-switch-loader FR-8)', () => {
  it('is the exact copy the design brief specifies', () => {
    expect(RESTORING_PLACEHOLDER).toBe('restoring transcript — you can start typing');
  });
});

describe('readingWindowHint (session-switch-loader FR-9 — never a literal 200)', () => {
  it('interpolates RENDER_WINDOW', () => {
    expect(readingWindowHint()).toBe(`reading last ${RENDER_WINDOW} of the session`);
    expect(readingWindowHint()).toContain(String(RENDER_WINDOW));
  });
});
