// session-questions FR-12/17/18/19/20/21 — pure question-card logic: selection
// accumulation, submit enablement, the ', ' multi-select join, free-text
// pass-through, answered-state reconstruction, the FR-21 failure path, and the
// FR-20 composer placeholder. Pure logic only (no DOM).

import { describe, expect, it, vi } from 'vitest';
import type { Result, SessionQuestion } from '../contract/common';
import type { ConversationBlock } from '../contract/conversation-view';
import {
  allComplete,
  answeredSelection,
  buildAnswers,
  commitFreeText,
  composerPlaceholder,
  hasMultiSelect,
  hasPendingQuestionBlock,
  initSelections,
  pickOption,
  sectionComplete,
  shouldAutoSubmit,
  submitAnswers,
} from './question-card';

const single: SessionQuestion = {
  question: 'Which auth method?',
  header: 'Auth',
  multiSelect: false,
  options: [
    { label: 'JWT', description: 'stateless tokens' },
    { label: 'Sessions', description: 'server-side sessions' },
  ],
};

const multi: SessionQuestion = {
  question: 'Which features?',
  header: 'Features',
  multiSelect: true,
  options: [
    { label: 'A', description: 'feature a' },
    { label: 'B', description: 'feature b' },
    { label: 'C', description: 'feature c' },
  ],
};

describe('initSelections', () => {
  it('mints one empty selection per section', () => {
    expect(initSelections([single, multi])).toEqual([
      { selected: [], freeText: '' },
      { selected: [], freeText: '' },
    ]);
  });
});

describe('pickOption (FR-18 selection accumulation)', () => {
  it('single-select: picks the clicked label', () => {
    const s = pickOption([single], initSelections([single]), 0, 'JWT');
    expect(s[0]).toEqual({ selected: ['JWT'], freeText: '' });
  });

  it('single-select: a second pick replaces the first', () => {
    let s = pickOption([single], initSelections([single]), 0, 'JWT');
    s = pickOption([single], s, 0, 'Sessions');
    expect(s[0]).toEqual({ selected: ['Sessions'], freeText: '' });
  });

  it('single-select: picking an option clears a committed free text', () => {
    let s = commitFreeText([single], initSelections([single]), 0, 'OAuth');
    s = pickOption([single], s, 0, 'JWT');
    expect(s[0]).toEqual({ selected: ['JWT'], freeText: '' });
  });

  it('multi-select: clicks toggle and accumulate', () => {
    let s = pickOption([multi], initSelections([multi]), 0, 'C');
    s = pickOption([multi], s, 0, 'A');
    expect(s[0].selected).toContain('A');
    expect(s[0].selected).toContain('C');
    s = pickOption([multi], s, 0, 'C');
    expect(s[0].selected).toEqual(['A']);
  });

  it('multi-select: toggling keeps a committed free text', () => {
    let s = commitFreeText([multi], initSelections([multi]), 0, 'something else');
    s = pickOption([multi], s, 0, 'A');
    expect(s[0]).toEqual({ selected: ['A'], freeText: 'something else' });
  });

  it('only touches the addressed section', () => {
    const s = pickOption([single, multi], initSelections([single, multi]), 1, 'B');
    expect(s[0]).toEqual({ selected: [], freeText: '' });
    expect(s[1].selected).toEqual(['B']);
  });
});

describe('commitFreeText (FR-12 pass-through)', () => {
  it('single-select: sets the free text and clears any picked option', () => {
    let s = pickOption([single], initSelections([single]), 0, 'JWT');
    s = commitFreeText([single], s, 0, 'OAuth device flow');
    expect(s[0]).toEqual({ selected: [], freeText: 'OAuth device flow' });
  });

  it('multi-select: keeps the selected labels', () => {
    let s = pickOption([multi], initSelections([multi]), 0, 'B');
    s = commitFreeText([multi], s, 0, 'and docs');
    expect(s[0]).toEqual({ selected: ['B'], freeText: 'and docs' });
  });

  it('stores the value verbatim (no trimming of the committed text)', () => {
    const s = commitFreeText([single], initSelections([single]), 0, '  padded  ');
    expect(s[0].freeText).toBe('  padded  ');
  });

  it('whitespace-only text is a no-op (same state)', () => {
    const s0 = initSelections([single]);
    expect(commitFreeText([single], s0, 0, '   ')).toBe(s0);
    expect(commitFreeText([single], s0, 0, '')).toBe(s0);
  });
});

describe('completion + submit enablement (FR-18)', () => {
  it('sectionComplete: ≥ 1 selection or a committed free text', () => {
    expect(sectionComplete({ selected: [], freeText: '' })).toBe(false);
    expect(sectionComplete({ selected: ['JWT'], freeText: '' })).toBe(true);
    expect(sectionComplete({ selected: [], freeText: 'other' })).toBe(true);
  });

  it('allComplete: every section answered', () => {
    let s = pickOption([single, multi], initSelections([single, multi]), 0, 'JWT');
    expect(allComplete(s)).toBe(false);
    s = pickOption([single, multi], s, 1, 'A');
    expect(allComplete(s)).toBe(true);
  });

  it('hasMultiSelect: true iff any section is multiSelect (§8 submit affordance)', () => {
    expect(hasMultiSelect([single])).toBe(false);
    expect(hasMultiSelect([single, multi])).toBe(true);
  });

  it('pure single-select: the completing click auto-submits', () => {
    const s = pickOption([single], initSelections([single]), 0, 'JWT');
    expect(shouldAutoSubmit([single], s)).toBe(true);
  });

  it('multi-question single-select: waits for every section', () => {
    const two: SessionQuestion[] = [single, { ...single, question: 'Second?', header: 'Two' }];
    let s = pickOption(two, initSelections(two), 0, 'JWT');
    expect(shouldAutoSubmit(two, s)).toBe(false);
    s = pickOption(two, s, 1, 'Sessions');
    expect(shouldAutoSubmit(two, s)).toBe(true);
  });

  it('never auto-submits while a multi-select section exists', () => {
    let s = pickOption([single, multi], initSelections([single, multi]), 0, 'JWT');
    s = pickOption([single, multi], s, 1, 'A');
    expect(allComplete(s)).toBe(true);
    expect(shouldAutoSubmit([single, multi], s)).toBe(false); // §8: answer ↵ affordance instead
  });
});

describe('buildAnswers (FR-12)', () => {
  it('single-select: the chosen label, verbatim', () => {
    const s = pickOption([single], initSelections([single]), 0, 'JWT');
    expect(buildAnswers([single], s)).toEqual({ 'Which auth method?': 'JWT' });
  });

  it('free text passes verbatim', () => {
    const s = commitFreeText([single], initSelections([single]), 0, '  OAuth, maybe  ');
    expect(buildAnswers([single], s)).toEqual({ 'Which auth method?': '  OAuth, maybe  ' });
  });

  it("multi-select: selected labels joined with ', ' in option order", () => {
    let s = pickOption([multi], initSelections([multi]), 0, 'C');
    s = pickOption([multi], s, 0, 'A');
    expect(buildAnswers([multi], s)).toEqual({ 'Which features?': 'A, C' });
  });

  it('multi-select: a committed free text joins last', () => {
    let s = pickOption([multi], initSelections([multi]), 0, 'B');
    s = commitFreeText([multi], s, 0, 'and docs');
    expect(buildAnswers([multi], s)).toEqual({ 'Which features?': 'B, and docs' });
  });

  it('one entry per section, keyed by the question text', () => {
    let s = pickOption([single, multi], initSelections([single, multi]), 0, 'Sessions');
    s = pickOption([single, multi], s, 1, 'A');
    expect(buildAnswers([single, multi], s)).toEqual({
      'Which auth method?': 'Sessions',
      'Which features?': 'A',
    });
  });
});

describe('answeredSelection (FR-19 answered-state reconstruction)', () => {
  it('single-select: an answer matching an option label is the chosen row', () => {
    expect(answeredSelection(single, 'JWT')).toEqual({ chosen: ['JWT'], freeText: null });
  });

  it('single-select: a non-matching answer echoes in the free-text slot', () => {
    expect(answeredSelection(single, 'OAuth device flow')).toEqual({ chosen: [], freeText: 'OAuth device flow' });
  });

  it("multi-select: splits the ', ' join back into chosen labels", () => {
    expect(answeredSelection(multi, 'A, C')).toEqual({ chosen: ['A', 'C'], freeText: null });
  });

  it('multi-select: non-label parts collect into the free-text slot', () => {
    expect(answeredSelection(multi, 'A, and docs')).toEqual({ chosen: ['A'], freeText: 'and docs' });
  });

  it('no recorded answer → nothing chosen', () => {
    expect(answeredSelection(single, undefined)).toEqual({ chosen: [], freeText: null });
  });
});

describe('submitAnswers (FR-18/21)', () => {
  const ok: Result<null> = { ok: true, data: null };
  const fail: Result<null> = { ok: false, error: { code: 'QUESTION_NOT_PENDING', message: 'that question is no longer pending' } };

  it('marks in-flight and stays in-flight on success (the resolved event flips the card)', async () => {
    const setInFlight = vi.fn();
    const log = vi.fn();
    await submitAnswers({
      answers: { q: 'a' },
      answer: vi.fn(async () => ok),
      setInFlight,
      isResolved: () => false,
      log,
    });
    expect(setInFlight.mock.calls).toEqual([[true]]);
    expect(log).not.toHaveBeenCalled();
  });

  it('on ok: false logs and re-enables the card', async () => {
    const setInFlight = vi.fn();
    const log = vi.fn();
    await submitAnswers({
      answers: { q: 'a' },
      answer: vi.fn(async () => fail),
      setInFlight,
      isResolved: () => false,
      log,
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('that question is no longer pending');
    expect(setInFlight.mock.calls).toEqual([[true], [false]]);
  });

  it('on ok: false does NOT re-enable when the card is already resolved (§3 flow 8 race)', async () => {
    const setInFlight = vi.fn();
    await submitAnswers({
      answers: { q: 'a' },
      answer: vi.fn(async () => fail),
      setInFlight,
      isResolved: () => true,
      log: vi.fn(),
    });
    expect(setInFlight.mock.calls).toEqual([[true]]); // never re-enabled — the card is inert anyway
  });

  it('catches a transport-level rejection: logs and re-enables', async () => {
    const setInFlight = vi.fn();
    const log = vi.fn();
    await submitAnswers({
      answers: { q: 'a' },
      answer: vi.fn(async () => {
        throw new Error('ipc bridge lost');
      }),
      setInFlight,
      isResolved: () => false,
      log,
    });
    expect(String(log.mock.calls[0][0])).toContain('ipc bridge lost');
    expect(setInFlight.mock.calls).toEqual([[true], [false]]);
  });
});

describe('composer placeholder (FR-20)', () => {
  const questionBlock = (state: 'pending' | 'answered' | 'cancelled'): ConversationBlock => ({
    kind: 'question',
    blockId: 'q1',
    isStreaming: state === 'pending',
    questions: [single],
    state,
  });

  it('hasPendingQuestionBlock: true only for a pending question block', () => {
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi', queued: false };
    expect(hasPendingQuestionBlock([user])).toBe(false);
    expect(hasPendingQuestionBlock([user, questionBlock('pending')])).toBe(true);
    expect(hasPendingQuestionBlock([user, questionBlock('answered')])).toBe(false);
    expect(hasPendingQuestionBlock([user, questionBlock('cancelled')])).toBe(false);
  });

  it('swaps while a pending card exists and reverts after', () => {
    expect(composerPlaceholder('running', undefined, true)).toBe('answer the question above — typed messages will queue');
    expect(composerPlaceholder('running', undefined, false)).toBe('send a follow-up, or run a command…');
    expect(composerPlaceholder('idle', undefined, false)).toBe('send a follow-up, or run a command…');
  });

  it('done/error placeholders win over the question hint', () => {
    expect(composerPlaceholder('done', undefined, true)).toBe('session ended — press n for a new one');
    expect(composerPlaceholder('error', 'spawn failed', true)).toBe('spawn failed');
    expect(composerPlaceholder('error', undefined, false)).toBe('session error');
  });
});
