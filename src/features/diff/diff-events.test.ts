import { describe, expect, it } from 'vitest';
import { nextDiffEventAction } from './diff-events';

const SID = 's1';

describe('nextDiffEventAction', () => {
  it('ignores an event of another type', () => {
    expect(nextDiffEventAction({ type: 'other' as 'diff.changed', sessionId: SID }, SID, false)).toBe('ignore');
  });

  it('ignores another session’s event', () => {
    expect(nextDiffEventAction({ type: 'diff.changed', sessionId: 'other-session' }, SID, false)).toBe('ignore');
  });

  it('queues a single trailing refresh while a fetch is in flight', () => {
    expect(nextDiffEventAction({ type: 'diff.changed', sessionId: SID }, SID, true)).toBe('queueRefresh');
  });

  it('refetches on every idle event, with no echo left to swallow', () => {
    // Regression pin for the loop fix: this used to take a pendingEcho count and
    // swallow the first event after each getSummary as that fetch's own echo.
    // With the core broadcast gone (FR-17 amended) there is no echo, and
    // swallowing anything here would drop a real watcher/tool.done change.
    expect(nextDiffEventAction({ type: 'diff.changed', sessionId: SID }, SID, false)).toBe('refetch');
    expect(nextDiffEventAction({ type: 'diff.changed', sessionId: SID }, SID, false)).toBe('refetch');
  });
});
