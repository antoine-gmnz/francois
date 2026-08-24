// The pure half of the post-removal reassignment (fleet-board §7 /
// split-session FR-20): WHICH session takes over the left pane once the active
// one is gone. The store half — that the answer is applied WITHOUT the FR-8
// pane swap — is covered in src/lib/sessionsStore.test.ts.

import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import { getPending, parkPrompt } from '../conversation/pending-queue';
import {
  clearQueueOnSessionCleared,
  clearQueueOnSessionError,
  drainQueueOnMessageUser,
  nextActiveAfterRemoval,
} from './useSessionFleetSync';

function meta(id: string): SessionMeta {
  return {
    id,
    name: id,
    cwd: '/repo',
    model: { id: 'm', label: 'M' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt: 1,
    permissionMode: 'default',
    permissionModeSince: 0,
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    responseMode: 'default',
  };
}

describe('nextActiveAfterRemoval (§7)', () => {
  const list = [meta('s1'), meta('s2'), meta('s3')];

  it('takes the session that slides into the removed one’s position', () => {
    expect(nextActiveAfterRemoval(list, 's1')).toBe('s2');
    expect(nextActiveAfterRemoval(list, 's2')).toBe('s3');
  });

  it('falls back to the last row when the removed one was last', () => {
    expect(nextActiveAfterRemoval(list, 's3')).toBe('s2');
  });

  it('is null when nothing remains', () => {
    expect(nextActiveAfterRemoval([meta('s1')], 's1')).toBeNull();
    expect(nextActiveAfterRemoval([], 's1')).toBeNull();
  });

  it('answers the RIGHT pane’s session like any other — the caller must not swap', () => {
    // The nearest remaining session very often IS the paned one; that is exactly
    // why the caller uses reassignActiveSessionId rather than setActiveSessionId.
    expect(nextActiveAfterRemoval([meta('s1'), meta('s2')], 's1')).toBe('s2');
  });

  it('clamps into range for an id that is not in the list rather than throwing', () => {
    expect(nextActiveAfterRemoval(list, 'gone')).toBe('s1');
  });
});

// transcript-perf FR-12/FR-14: the ctx callbacks the hook actually plugs into
// `handleSessionEvent` (onMessageUser/onError/onCleared) delegate to THESE
// exported functions rather than calling pending-queue inline — so the
// wiring itself is under test here, not just pending-queue's own map ops
// (pending-queue.test.ts).
describe('pending-queue wiring (transcript-perf FR-12/FR-14)', () => {
  it('drainQueueOnMessageUser resolves the matching parked prompt', () => {
    parkPrompt('fs1', 'b1', 'go');
    drainQueueOnMessageUser('fs1', 'b1');
    expect(getPending('fs1')).toEqual([]);
  });

  it('clearQueueOnSessionError drops the whole queue', () => {
    parkPrompt('fs2', 'b1', 'a');
    parkPrompt('fs2', 'b2', 'b');
    clearQueueOnSessionError('fs2');
    expect(getPending('fs2')).toEqual([]);
  });

  it('clearQueueOnSessionCleared drops the whole queue', () => {
    parkPrompt('fs3', 'b1', 'a');
    clearQueueOnSessionCleared('fs3');
    expect(getPending('fs3')).toEqual([]);
  });
});
