import { describe, expect, it } from 'vitest';
import { createLatestOnly, slotFailed, slotLoading, slotSettled, type Slot } from './useContextBreakdown';

describe('createLatestOnly (FR-13: drop answers for a session no longer focused)', () => {
  it('lets only the most recent request settle', () => {
    const gate = createLatestOnly();
    const first = gate.next();
    const second = gate.next();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it('cancel() retires the request in flight (session switched, section unmounted)', () => {
    const gate = createLatestOnly();
    const token = gate.next();
    gate.cancel();
    expect(gate.isCurrent(token)).toBe(false);
  });
});

describe('slot transitions', () => {
  const B = {
    model: 'm',
    totalTokens: 10,
    maxTokens: 100,
    percentage: 10,
    categories: [],
    mcpTools: [],
    memoryFiles: [],
    agents: [],
    skills: [],
    autoCompactThreshold: null,
  };
  const good = { breakdown: B, measuredAt: 5, stale: false };
  const shown: Slot = { sessionId: 's1', data: good, error: null, loading: false };

  it('loading keeps the data of the same session, starts empty for another', () => {
    expect(slotLoading(shown, 's1')).toEqual({ ...shown, loading: true });
    expect(slotLoading(shown, 's2')).toEqual({ sessionId: 's2', data: null, error: null, loading: true });
  });

  it('ignores an answer for a session that is no longer the slot\'s', () => {
    const other = { ...shown, sessionId: 's2' };
    expect(slotSettled(other, 's1', { ok: true, data: good })).toBe(other);
    expect(slotFailed(other, 's1', 'boom')).toBe(other);
  });

  it('a success merges (an empty answer never erases the last good breakdown) and clears the error', () => {
    const errored: Slot = { ...shown, error: { code: 'INTERNAL', message: 'x' }, loading: true };
    expect(slotSettled(errored, 's1', { ok: true, data: { breakdown: null, measuredAt: null, stale: true } })).toEqual({
      ...shown,
      data: { ...good, stale: true },
    });
  });

  it('an error keeps the last data', () => {
    const error = { code: 'CONTEXT_BREAKDOWN_UNAVAILABLE' as const, message: 'Timed out measuring context.' };
    expect(slotSettled({ ...shown, loading: true }, 's1', { ok: false, error })).toEqual({ ...shown, error });
  });

  it('a rejected invoke reads as unavailable, so the legacy meter takes over', () => {
    expect(slotFailed({ ...shown, data: null, loading: true }, 's1', 'command session_context_breakdown not found')).toEqual({
      sessionId: 's1',
      data: null,
      error: { code: 'CONTEXT_BREAKDOWN_UNAVAILABLE', message: 'command session_context_breakdown not found' },
      loading: false,
    });
  });
});
