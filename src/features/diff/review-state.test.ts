import { beforeEach, describe, expect, it } from 'vitest';
import type { DiffFileSummary } from '../../../contract/diff-view';
import { isReviewed, reviewKey, reviewProgress, toggleReviewed, useDiffReviewStore } from './review-state';

function file(path: string, additions = 1, deletions = 0, status: DiffFileSummary['status'] = 'modified'): DiffFileSummary {
  const i = path.lastIndexOf('/');
  return { path, dir: i < 0 ? '' : path.slice(0, i), name: path.slice(i + 1), additions, deletions, status };
}

describe('reviewKey', () => {
  it('changes when the file changes shape, so an edited file drops out of reviewed', () => {
    expect(reviewKey(file('a.ts', 1, 2))).not.toBe(reviewKey(file('a.ts', 1, 3)));
    expect(reviewKey(file('a.ts', 1, 2))).not.toBe(reviewKey(file('a.ts', 1, 2, 'added')));
    expect(reviewKey(file('a.ts', 1, 2))).toBe(reviewKey(file('a.ts', 1, 2)));
  });
});

describe('toggleReviewed / isReviewed', () => {
  it('adds then removes a file', () => {
    const f = file('src/a.ts');
    const once = toggleReviewed([], f);
    expect(isReviewed(once, f)).toBe(true);
    expect(isReviewed(toggleReviewed(once, f), f)).toBe(false);
  });
  it('does not treat a changed file as reviewed', () => {
    const marked = toggleReviewed([], file('src/a.ts', 3, 1));
    expect(isReviewed(marked, file('src/a.ts', 4, 1))).toBe(false);
  });
});

describe('reviewProgress', () => {
  it('counts only files still in the summary with their reviewed shape', () => {
    const a = file('a.ts');
    const b = file('b.ts');
    const marked = [reviewKey(a), reviewKey(file('gone.ts')), reviewKey(file('b.ts', 9, 9))];
    expect(reviewProgress([a, b], marked)).toEqual({ reviewed: 1, total: 2, fraction: 0.5 });
  });
  it('is zero for an empty summary', () => {
    expect(reviewProgress([], ['x'])).toEqual({ reviewed: 0, total: 0, fraction: 0 });
  });
});

describe('useDiffReviewStore', () => {
  beforeEach(() => useDiffReviewStore.setState({ bySession: {} }));
  it('keeps marks per session', () => {
    const f = file('a.ts');
    useDiffReviewStore.getState().toggle('s1', f);
    expect(useDiffReviewStore.getState().bySession.s1).toEqual([reviewKey(f)]);
    expect(useDiffReviewStore.getState().bySession.s2).toBeUndefined();
    useDiffReviewStore.getState().toggle('s1', f);
    expect(useDiffReviewStore.getState().bySession.s1).toEqual([]);
  });
});
