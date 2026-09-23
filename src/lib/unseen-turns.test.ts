import { describe, expect, it } from 'vitest';
import type { SessionMeta, SessionStatus } from '../../contract/common';
import { dropUnseenTurn, markFinishedTurns, type UnseenTurns } from './unseen-turns';

const s = (id: string, status: SessionStatus) => ({ id, status }) as SessionMeta;
const NONE: UnseenTurns = {};

describe('markFinishedTurns', () => {
  it.each(['running', 'starting', 'awaiting_approval', 'awaiting_input'] as const)('marks %s → idle', (from) => {
    expect(markFinishedTurns([s('a', from)], [s('a', 'idle')], null, NONE)).toEqual({ a: true });
  });

  it('does not mark the active session', () => {
    expect(markFinishedTurns([s('a', 'running')], [s('a', 'idle')], 'a', NONE)).toBe(NONE);
  });

  it('does not mark a session it has never seen before (hydration, append)', () => {
    expect(markFinishedTurns([], [s('a', 'idle')], null, NONE)).toBe(NONE);
  });

  it.each(['idle', 'done', 'error'] as const)('does not mark %s → idle', (from) => {
    expect(markFinishedTurns([s('a', from)], [s('a', 'idle')], null, NONE)).toBe(NONE);
  });

  it('does not mark a working → error/done transition', () => {
    expect(markFinishedTurns([s('a', 'running')], [s('a', 'error')], null, NONE)).toBe(NONE);
  });

  it('keeps existing marks and prunes the ones whose session is gone', () => {
    const unseen = { a: true, gone: true } as const;
    expect(markFinishedTurns([s('a', 'idle')], [s('a', 'running')], null, unseen)).toEqual({ a: true });
  });

  it('returns the same reference when nothing changes', () => {
    const unseen = { a: true } as const;
    expect(markFinishedTurns([s('a', 'idle')], [s('a', 'idle')], null, unseen)).toBe(unseen);
  });
});

describe('dropUnseenTurn', () => {
  it('drops the mark', () => {
    expect(dropUnseenTurn({ a: true, b: true }, 'a')).toEqual({ b: true });
  });
  it('is reference-stable when there is no mark', () => {
    const unseen = { b: true } as const;
    expect(dropUnseenTurn(unseen, 'a')).toBe(unseen);
  });
});
