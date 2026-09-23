import { describe, expect, it } from 'vitest';
import type { PullSummary } from '../../../contract/github-page';
import { mergeableSummary, pullForBranch } from './session-pull';

function pull(over: Partial<PullSummary>): PullSummary {
  return {
    number: 1,
    title: 't',
    head: 'feat/x',
    base: 'main',
    state: 'open',
    author: 'me',
    authorIsViewer: true,
    createdAt: 0,
    updatedAt: 0,
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    review: 'none',
    changesRequested: 0,
    url: 'https://github.com/o/r/pull/1',
    ...over,
  };
}

describe('pullForBranch', () => {
  it('returns null without a branch', () => {
    expect(pullForBranch([pull({})], null)).toBeNull();
    expect(pullForBranch([pull({})], '')).toBeNull();
  });

  it('matches an open or draft PR on the head branch', () => {
    expect(pullForBranch([pull({ number: 3 })], 'feat/x')?.number).toBe(3);
    expect(pullForBranch([pull({ number: 4, state: 'draft' })], 'feat/x')?.number).toBe(4);
  });

  it('ignores merged/closed PRs and other branches', () => {
    const pulls = [pull({ state: 'merged' }), pull({ state: 'closed' }), pull({ head: 'feat/y' })];
    expect(pullForBranch(pulls, 'feat/x')).toBeNull();
  });

  it('never matches on the base branch', () => {
    expect(pullForBranch([pull({ head: 'feat/x', base: 'main' })], 'main')).toBeNull();
  });

  it('prefers the most recently updated when several match', () => {
    const pulls = [pull({ number: 1, updatedAt: 10 }), pull({ number: 2, updatedAt: 20 }), pull({ number: 3, updatedAt: 5 })];
    expect(pullForBranch(pulls, 'feat/x')?.number).toBe(2);
  });
});

describe('mergeableSummary', () => {
  it('maps each mergeability to a tone', () => {
    expect(mergeableSummary('clean').tone).toBe('success');
    expect(mergeableSummary('blocked').tone).toBe('danger');
    expect(mergeableSummary('conflicting').tone).toBe('danger');
    expect(mergeableSummary('behind').tone).toBe('attention');
    expect(mergeableSummary('unknown').tone).toBe('faint');
  });
});
