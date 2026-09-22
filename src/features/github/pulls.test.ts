import { describe, expect, it } from 'vitest';
import type { PullSummary } from '../../../contract/github-page';
import {
  canUpdateBranch,
  checkRollupChip,
  checkRollupHeadline,
  filterMatchesPull,
  ghUnavailableMessage,
  mergeButtonLabel,
  mergeableTone,
  pullOpenedBy,
  pullRelativeTime,
  pullReviewText,
  pullStateChip,
  pullStateIcon,
  visiblePullFiles,
} from './pulls';

function pull(overrides: Partial<PullSummary> = {}): PullSummary {
  return {
    number: 128,
    title: 'Retry failed auth requests with backoff',
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
    url: 'https://github.com/acme/orbit/pull/128',
    ...overrides,
  };
}

describe('pullStateIcon / pullStateChip', () => {
  it('maps each PR state to its glyph', () => {
    expect(pullStateIcon('open')).toBe('flow');
    expect(pullStateIcon('draft')).toBe('dots');
    expect(pullStateIcon('merged')).toBe('check');
    expect(pullStateIcon('closed')).toBe('x');
  });

  it('gives merged a success tone and closed a danger tone', () => {
    expect(pullStateChip('merged').tone).toBe('success');
    expect(pullStateChip('closed').tone).toBe('danger');
    expect(pullStateChip('open').tone).toBe('info');
    expect(pullStateChip('draft').tone).toBe('faint');
  });
});

describe('checkRollupChip / checkRollupHeadline', () => {
  it('is null when there are no checks', () => {
    expect(checkRollupChip({ total: 0, passed: 0, failed: 0, pending: 0 })).toBeNull();
  });

  it('reads failing checks as danger, singular vs plural', () => {
    expect(checkRollupChip({ total: 4, passed: 3, failed: 1, pending: 0 })).toEqual({ label: '1 check failing', tone: 'danger' });
    expect(checkRollupChip({ total: 4, passed: 2, failed: 2, pending: 0 })).toEqual({ label: '2 checks failing', tone: 'danger' });
  });

  it('reads all-passed as success and pending (no failures) as neutral', () => {
    expect(checkRollupChip({ total: 3, passed: 3, failed: 0, pending: 0 })).toEqual({ label: 'checks passed', tone: 'success' });
    expect(checkRollupChip({ total: 3, passed: 1, failed: 0, pending: 2 })).toEqual({ label: 'checks pending', tone: 'faint' });
  });

  it('headline reports "N of total" for the detail header', () => {
    expect(checkRollupHeadline({ total: 4, passed: 3, failed: 1, pending: 0 })).toEqual({
      label: '1 of 4 checks failing',
      tone: 'danger',
    });
  });
});

describe('pullReviewText', () => {
  it('shows merged-by, preferring "you"', () => {
    expect(pullReviewText(pull({ state: 'merged', mergedByViewer: true }))).toEqual({ text: 'merged by you', tone: 'faint' });
    expect(pullReviewText(pull({ state: 'merged', mergedBy: 'marie', mergedByViewer: false }))).toEqual({
      text: 'merged by marie',
      tone: 'faint',
    });
  });

  it('shows draft as faint', () => {
    expect(pullReviewText(pull({ state: 'draft' }))).toEqual({ text: 'draft', tone: 'faint' });
  });

  it('shows changes requested as attention, singular vs plural', () => {
    expect(pullReviewText(pull({ changesRequested: 1 }))).toEqual({ text: '1 change requested', tone: 'attention' });
    expect(pullReviewText(pull({ changesRequested: 2 }))).toEqual({ text: '2 changes requested', tone: 'attention' });
  });

  it('shows approved as success, and null otherwise', () => {
    expect(pullReviewText(pull({ review: 'approved' }))).toEqual({ text: 'approved · ready to merge', tone: 'success' });
    expect(pullReviewText(pull({ review: 'review_required' }))).toBeNull();
  });
});

describe('filterMatchesPull', () => {
  const p = pull({ number: 128, title: 'Retry failed auth requests', head: 'auth-retry' });

  it('matches an empty query', () => {
    expect(filterMatchesPull(p, '')).toBe(true);
  });

  it('matches title, number and head, case-insensitively', () => {
    expect(filterMatchesPull(p, 'RETRY')).toBe(true);
    expect(filterMatchesPull(p, '#128')).toBe(true);
    expect(filterMatchesPull(p, '128')).toBe(true);
    expect(filterMatchesPull(p, 'auth-retry')).toBe(true);
  });

  it('rejects a query matching nothing', () => {
    expect(filterMatchesPull(p, 'rate-limit')).toBe(false);
  });
});

describe('pullRelativeTime', () => {
  const now = new Date('2026-09-22T12:00:00').getTime();

  it('reports minutes and hours within today', () => {
    expect(pullRelativeTime(now - 30_000, now)).toBe('just now');
    expect(pullRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(pullRelativeTime(now - 2 * 3_600_000, now)).toBe('2 h ago');
  });

  it('reports "yesterday" for the prior calendar day', () => {
    const yesterday = new Date('2026-09-21T09:00:00').getTime();
    expect(pullRelativeTime(yesterday, now)).toBe('yesterday');
  });

  it('reports "N days ago" further back', () => {
    const twoDaysAgo = new Date('2026-09-20T09:00:00').getTime();
    expect(pullRelativeTime(twoDaysAgo, now)).toBe('2 days ago');
  });
});

describe('mergeableTone / canUpdateBranch / mergeButtonLabel', () => {
  it('flags blocked and conflicting as danger, behind as attention, clean as success', () => {
    expect(mergeableTone('blocked')).toBe('danger');
    expect(mergeableTone('conflicting')).toBe('danger');
    expect(mergeableTone('behind')).toBe('attention');
    expect(mergeableTone('clean')).toBe('success');
    expect(mergeableTone('unknown')).toBe('faint');
  });

  it('enables Update branch only when behind or blocked', () => {
    expect(canUpdateBranch('behind')).toBe(true);
    expect(canUpdateBranch('blocked')).toBe(true);
    expect(canUpdateBranch('clean')).toBe(false);
    expect(canUpdateBranch('conflicting')).toBe(false);
  });

  it('labels Merge with the blocked warning unless clean', () => {
    expect(mergeButtonLabel('clean')).toBe('Merge');
    expect(mergeButtonLabel('blocked')).toBe('Merge · blocked by checks');
  });
});

describe('visiblePullFiles', () => {
  it('shows the first 4 and counts the rest', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(visiblePullFiles(files)).toEqual({ shown: ['a', 'b', 'c', 'd'], moreCount: 2 });
  });

  it('reports zero more when everything fits', () => {
    expect(visiblePullFiles(['a', 'b'])).toEqual({ shown: ['a', 'b'], moreCount: 0 });
  });
});

describe('pullOpenedBy', () => {
  it('prefers "you"', () => {
    expect(pullOpenedBy(pull({ authorIsViewer: true, author: 'marie' }))).toBe('you');
    expect(pullOpenedBy(pull({ authorIsViewer: false, author: 'marie' }))).toBe('marie');
  });
});

describe('ghUnavailableMessage', () => {
  it('names the fix per GhStatus', () => {
    expect(ghUnavailableMessage('missing')).toMatch(/Install the GitHub CLI/);
    expect(ghUnavailableMessage('unauthenticated')).toMatch(/gh auth login/);
    expect(ghUnavailableMessage('not-github')).toMatch(/remote isn't on GitHub/);
  });
});
