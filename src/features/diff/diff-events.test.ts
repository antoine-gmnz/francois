import { describe, expect, it } from 'vitest';
import { nextDiffEventAction } from './diff-events';

describe('nextDiffEventAction', () => {
  const SID = 'session-1';

  it('ignores events of a different type', () => {
    expect(nextDiffEventAction({ type: 'other' as 'diff.changed', sessionId: SID }, SID, 0, false)).toBe('ignore');
  });

  it('ignores events for a different session', () => {
    expect(nextDiffEventAction({ type: 'diff.changed', sessionId: 'other-session' }, SID, 0, false)).toBe('ignore');
  });

  it('consumes one outstanding echo instead of refetching', () => {
    expect(nextDiffEventAction({ type: 'diff.changed', sessionId: SID }, SID, 1, false)).toBe('consumeEcho');
  });

  it('prefers echo consumption over queueing even while a fetch is in flight', () => {
    expect(nextDiffEventAction({ type: 'diff.changed', sessionId: SID }, SID, 2, true)).toBe('consumeEcho');
  });

  it('queues a trailing refresh when a summary fetch is already in flight', () => {
    expect(nextDiffEventAction({ type: 'diff.changed', sessionId: SID }, SID, 0, true)).toBe('queueRefresh');
  });

  it('refetches immediately when idle with no outstanding echo', () => {
    expect(nextDiffEventAction({ type: 'diff.changed', sessionId: SID }, SID, 0, false)).toBe('refetch');
  });
});
