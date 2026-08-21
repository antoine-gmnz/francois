// transcript-perf §6/FR-10..18 — the per-session pending-queue module. Pure
// map operations + the subscription contract; no DOM/React renderer needed
// (subscribePending is exercised directly rather than through the hook).

import { describe, expect, it, vi } from 'vitest';
import {
  appendToDraft,
  clearPending,
  firstLine,
  getPending,
  parkPrompt,
  resolvePrompt,
  subscribePending,
  wasWronglyOptimistic,
} from './pending-queue';

describe('getPending', () => {
  it('is empty for an unknown session', () => {
    expect(getPending('unknown-1')).toEqual([]);
  });
});

describe('parkPrompt', () => {
  it('appends in FIFO order', () => {
    parkPrompt('s1', 'b1', 'first');
    parkPrompt('s1', 'b2', 'second');
    expect(getPending('s1')).toEqual([
      { blockId: 'b1', text: 'first' },
      { blockId: 'b2', text: 'second' },
    ]);
    clearPending('s1');
  });

  it('is idempotent on a replayed blockId', () => {
    parkPrompt('s2', 'b1', 'first');
    parkPrompt('s2', 'b1', 'first again');
    expect(getPending('s2')).toEqual([{ blockId: 'b1', text: 'first' }]);
    clearPending('s2');
  });

  it('notifies subscribers', () => {
    const listener = vi.fn();
    const unsub = subscribePending('s3', listener);
    parkPrompt('s3', 'b1', 'hi');
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    clearPending('s3');
  });
});

describe('resolvePrompt', () => {
  it('removes the matching entry, leaving the rest in order', () => {
    parkPrompt('s4', 'b1', 'a');
    parkPrompt('s4', 'b2', 'b');
    resolvePrompt('s4', 'b1');
    expect(getPending('s4')).toEqual([{ blockId: 'b2', text: 'b' }]);
    clearPending('s4');
  });

  it('is a no-op (and does not notify) for an id never parked', () => {
    const listener = vi.fn();
    const unsub = subscribePending('s5', listener);
    resolvePrompt('s5', 'never-parked');
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it('drops the map entry once the queue empties', () => {
    parkPrompt('s6', 'b1', 'only');
    resolvePrompt('s6', 'b1');
    expect(getPending('s6')).toEqual([]);
  });
});

describe('clearPending', () => {
  it('drops every parked prompt for the session', () => {
    parkPrompt('s7', 'b1', 'a');
    parkPrompt('s7', 'b2', 'b');
    clearPending('s7');
    expect(getPending('s7')).toEqual([]);
  });

  it('is a no-op (and does not notify) for an already-empty session', () => {
    const listener = vi.fn();
    const unsub = subscribePending('s8', listener);
    clearPending('s8');
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });
});

describe('firstLine', () => {
  it('returns the text unchanged when there is no newline', () => {
    expect(firstLine('one line')).toBe('one line');
  });

  it('cuts at the first newline', () => {
    expect(firstLine('first\nsecond\nthird')).toBe('first');
  });
});

describe('appendToDraft', () => {
  it('becomes the whole draft when it was empty', () => {
    expect(appendToDraft('', 'retracted')).toBe('retracted');
  });

  it('joins with a newline when the draft is non-empty', () => {
    expect(appendToDraft('already typing', 'retracted')).toBe('already typing\nretracted');
  });
});

describe('wasWronglyOptimistic (FR-11)', () => {
  it('true only when idle was guessed but the send was actually queued', () => {
    expect(wasWronglyOptimistic(false, true)).toBe(true);
  });

  it('false when the guess matched (idle+not-queued, busy+queued)', () => {
    expect(wasWronglyOptimistic(false, false)).toBe(false);
    expect(wasWronglyOptimistic(true, true)).toBe(false);
  });

  it('false when busy was guessed but it ran immediately — self-resolves at message.user', () => {
    expect(wasWronglyOptimistic(true, false)).toBe(false);
  });
});
