import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { BranchInfo, PullSummary } from '../../../contract/github-page';
import {
  aheadTone,
  behindTone,
  branchMatchesFilter,
  branchMatchesQuery,
  filterBranches,
  isReadyToPrune,
  isStale,
  lastCommitRelative,
  pullForBranch,
  pullsByBranch,
  readyToPruneBranches,
  sessionChip,
} from './branches';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function branch(overrides: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name: 'feature',
    isDefault: false,
    isCurrent: false,
    vsDefault: { ahead: 0, behind: 0 },
    merged: false,
    lastCommit: { shortSha: 'abc1234', subject: 'x', committedAt: NOW - DAY },
    ...overrides,
  };
}

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    name: 'feature',
    cwd: '/x',
    model: { id: 'm', label: 'M', brief: '', contextTokens: 1, efforts: [] },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 1,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    permissionModeSince: 0,
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    responseMode: 'default',
    allowGit: false,
    ...overrides,
  } as SessionMeta;
}

describe('branchMatchesFilter', () => {
  it('all matches everything', () => {
    expect(branchMatchesFilter(branch(), 'all', NOW)).toBe(true);
  });

  it('worktree matches only a branch with one', () => {
    expect(branchMatchesFilter(branch(), 'worktree', NOW)).toBe(false);
    expect(
      branchMatchesFilter(branch({ worktree: { path: '/w', displayPath: '~/w', isMain: false, dirty: false } }), 'worktree', NOW),
    ).toBe(true);
  });

  it('merged matches only a merged branch', () => {
    expect(branchMatchesFilter(branch({ merged: false }), 'merged', NOW)).toBe(false);
    expect(branchMatchesFilter(branch({ merged: true }), 'merged', NOW)).toBe(true);
  });

  it('stale matches a branch whose last commit is older than 30 days', () => {
    expect(branchMatchesFilter(branch({ lastCommit: { shortSha: 'a', subject: 'x', committedAt: NOW - 10 * DAY } }), 'stale', NOW)).toBe(
      false,
    );
    expect(branchMatchesFilter(branch({ lastCommit: { shortSha: 'a', subject: 'x', committedAt: NOW - 31 * DAY } }), 'stale', NOW)).toBe(
      true,
    );
  });
});

describe('isStale', () => {
  it('is exclusive at exactly 30 days', () => {
    expect(isStale(branch({ lastCommit: { shortSha: 'a', subject: 'x', committedAt: NOW - 30 * DAY } }), NOW)).toBe(false);
    expect(isStale(branch({ lastCommit: { shortSha: 'a', subject: 'x', committedAt: NOW - 30 * DAY - 1 } }), NOW)).toBe(true);
  });
});

describe('branchMatchesQuery / filterBranches', () => {
  it('matches case-insensitively, substring anywhere', () => {
    expect(branchMatchesQuery(branch({ name: 'auth-retry' }), 'RETRY')).toBe(true);
    expect(branchMatchesQuery(branch({ name: 'auth-retry' }), 'zzz')).toBe(false);
  });

  it('an empty query matches everything', () => {
    expect(branchMatchesQuery(branch(), '   ')).toBe(true);
  });

  it('combines the filter and the query', () => {
    const branches = [branch({ name: 'main', merged: true }), branch({ name: 'auth-retry', merged: false })];
    expect(filterBranches(branches, 'all', 'auth', NOW).map((b) => b.name)).toEqual(['auth-retry']);
    expect(filterBranches(branches, 'merged', '', NOW).map((b) => b.name)).toEqual(['main']);
  });
});

describe('isReadyToPrune / readyToPruneBranches', () => {
  it('requires merged, non-default, non-current, and no session', () => {
    expect(isReadyToPrune(branch({ merged: true }), undefined)).toBe(true);
    expect(isReadyToPrune(branch({ merged: true, isDefault: true }), undefined)).toBe(false);
    expect(isReadyToPrune(branch({ merged: false }), undefined)).toBe(false);
    expect(isReadyToPrune(branch({ merged: true }), [session()])).toBe(false);
    expect(isReadyToPrune(branch({ merged: true }), [])).toBe(true);
  });

  it('excludes the current branch even when merged with no session (mirrors the core prune guard)', () => {
    expect(isReadyToPrune(branch({ merged: true, isCurrent: true }), undefined)).toBe(false);
  });

  it('filters the full branch list against a session map', () => {
    const branches = [
      branch({ name: 'main', isDefault: true, merged: true }),
      branch({ name: 'done-feature', merged: true }),
      branch({ name: 'live-feature', merged: true }),
      branch({ name: 'open-feature', merged: false }),
      branch({ name: 'current-feature', merged: true, isCurrent: true }),
    ];
    const byBranch = new Map([['live-feature', [session()]]]);
    expect(readyToPruneBranches(branches, byBranch).map((b) => b.name)).toEqual(['done-feature']);
  });
});

describe('aheadTone / behindTone', () => {
  it('is zero at 0, ahead/behind otherwise', () => {
    expect(aheadTone(0)).toBe('zero');
    expect(aheadTone(2)).toBe('ahead');
    expect(behindTone(0)).toBe('zero');
    expect(behindTone(1)).toBe('behind');
  });
});

describe('sessionChip', () => {
  it('reads — for no session', () => {
    expect(sessionChip(undefined)).toEqual({ tone: 'none', label: '—' });
    expect(sessionChip([])).toEqual({ tone: 'none', label: '—' });
  });

  it('tints the single session by its own state', () => {
    expect(sessionChip([session({ name: 'auth-retry', status: 'awaiting_approval' })])).toEqual({
      tone: 'attention',
      label: 'auth-retry',
    });
    expect(sessionChip([session({ name: 'rate-limit', status: 'running' })])).toEqual({ tone: 'running', label: 'rate-limit' });
    expect(sessionChip([session({ name: 'docs', status: 'idle' })])).toEqual({ tone: 'neutral', label: 'docs' });
  });

  it('reads a neutral count for more than one session', () => {
    expect(sessionChip([session({ id: 'a' }), session({ id: 'b' })])).toEqual({ tone: 'neutral', label: '2 sessions' });
  });
});

function pull(overrides: Partial<PullSummary> = {}): PullSummary {
  return {
    number: 1,
    title: 't',
    head: 'auth-retry',
    base: 'main',
    state: 'open',
    author: 'marie',
    authorIsViewer: false,
    createdAt: 0,
    updatedAt: 0,
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    review: 'none',
    changesRequested: 0,
    url: 'https://github.com/acme/orbit/pull/1',
    ...overrides,
  };
}

describe('pullForBranch / pullsByBranch', () => {
  it('is undefined when no PR has this head', () => {
    expect(pullForBranch([pull({ head: 'other' })], 'auth-retry')).toBeUndefined();
  });

  it('picks the single match', () => {
    expect(pullForBranch([pull({ number: 5 })], 'auth-retry')?.number).toBe(5);
  });

  it('prefers open/draft over merged/closed regardless of recency', () => {
    const merged = pull({ number: 1, state: 'merged', updatedAt: 2000 });
    const open = pull({ number: 2, state: 'open', updatedAt: 1000 });
    expect(pullForBranch([merged, open], 'auth-retry')?.number).toBe(2);
    expect(pullForBranch([open, merged], 'auth-retry')?.number).toBe(2);
  });

  it('breaks ties within the same rank by the newest updatedAt', () => {
    const older = pull({ number: 1, state: 'open', updatedAt: 1000 });
    const newer = pull({ number: 2, state: 'draft', updatedAt: 2000 });
    expect(pullForBranch([older, newer], 'auth-retry')?.number).toBe(2);

    const closedOlder = pull({ number: 3, state: 'closed', updatedAt: 1000 });
    const closedNewer = pull({ number: 4, state: 'merged', updatedAt: 2000 });
    expect(pullForBranch([closedOlder, closedNewer], 'auth-retry')?.number).toBe(4);
  });

  it('pullsByBranch keys the best PR per branch', () => {
    const map = pullsByBranch([
      pull({ number: 1, head: 'auth-retry', state: 'closed', updatedAt: 1000 }),
      pull({ number: 2, head: 'auth-retry', state: 'open', updatedAt: 500 }),
      pull({ number: 3, head: 'rate-limit', state: 'merged', updatedAt: 100 }),
    ]);
    expect(map.get('auth-retry')?.number).toBe(2);
    expect(map.get('rate-limit')?.number).toBe(3);
    expect(map.get('missing')).toBeUndefined();
  });
});

describe('lastCommitRelative', () => {
  it('reads hours within a day', () => {
    expect(lastCommitRelative(NOW - 2 * 60 * 60 * 1000, NOW)).toBe('2 h ago');
  });

  it('reads yesterday exactly on day 1', () => {
    expect(lastCommitRelative(NOW - DAY, NOW)).toBe('yesterday');
  });

  it('reads days within a week', () => {
    expect(lastCommitRelative(NOW - 3 * DAY, NOW)).toBe('3 days ago');
  });

  it('reads weeks beyond a week', () => {
    expect(lastCommitRelative(NOW - 21 * DAY, NOW)).toBe('3 weeks ago');
  });
});
