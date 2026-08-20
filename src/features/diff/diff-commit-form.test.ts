import { describe, expect, it } from 'vitest';
import type { DiffFileSummary } from '../../../contract/diff-view';
import { SUBJECT_LIMIT, buildManifest, staysBehindLine, subjectMeterState } from './diff-commit-form';

function file(path: string, extra: Partial<DiffFileSummary> = {}): DiffFileSummary {
  const slash = path.lastIndexOf('/');
  return {
    path,
    dir: slash === -1 ? '' : path.slice(0, slash),
    name: slash === -1 ? path : path.slice(slash + 1),
    additions: 1,
    deletions: 0,
    status: 'modified',
    ...extra,
  };
}

describe('buildManifest (FR-35)', () => {
  const files = [file('a.ts'), file('b.ts'), file('c.ts'), file('d.ts', { additions: 4, deletions: 2 }), file('e.ts', { additions: 1, deletions: 1 })];

  it('shows up to the limit and aggregates the rest', () => {
    const inCommit = new Set(files.map((f) => f.path));
    const m = buildManifest(files, inCommit);
    expect(m.shown.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(m.moreCount).toBe(2);
    expect(m.moreAdd).toBe(5); // 4 + 1
    expect(m.moreDel).toBe(3); // 2 + 1
  });

  it('only considers checked files', () => {
    const inCommit = new Set(['a.ts', 'b.ts']);
    const m = buildManifest(files, inCommit);
    expect(m.shown.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(m.moreCount).toBe(0);
  });

  it('is empty when nothing is checked', () => {
    const m = buildManifest(files, new Set());
    expect(m.shown).toEqual([]);
    expect(m.moreCount).toBe(0);
  });
});

describe('staysBehindLine (FR-36)', () => {
  const files = [file('diff-view.md'), file('review-icons.png'), file('a.ts'), file('b.ts')];

  it('reads "nothing selected" when nothing is checked', () => {
    expect(staysBehindLine(files, new Set())).toBe('nothing selected');
  });

  it('is empty when every file is checked', () => {
    expect(staysBehindLine(files, new Set(files.map((f) => f.path)))).toBe('');
  });

  it('names a single unchecked file with the singular verb', () => {
    const inCommit = new Set(['diff-view.md', 'review-icons.png', 'a.ts']);
    expect(staysBehindLine(files, inCommit)).toBe('b.ts stays in the working tree');
  });

  it('names two unchecked files with "and" / plural verb', () => {
    const inCommit = new Set(['a.ts', 'b.ts']);
    expect(staysBehindLine(files, inCommit)).toBe('diff-view.md and review-icons.png stay in the working tree');
  });

  it('truncates past three unchecked files to "<a>, <b> and <m> more"', () => {
    const many = [file('diff-view.md'), file('review-icons.png'), file('a.ts'), file('b.ts'), file('c.ts')];
    expect(staysBehindLine(many, new Set())).toBe('nothing selected');
    expect(staysBehindLine(many, new Set(['diff-view.md']))).toBe('review-icons.png, a.ts and 2 more stay in the working tree');
  });
});

describe('subjectMeterState (FR-35 — warns, never blocks)', () => {
  it('reports the length under the limit with no warning', () => {
    expect(subjectMeterState('fix retry state bug')).toEqual({ len: 19, warn: false });
  });

  it('warns past the limit without indicating a block', () => {
    const long = 'x'.repeat(SUBJECT_LIMIT + 5);
    expect(subjectMeterState(long)).toEqual({ len: SUBJECT_LIMIT + 5, warn: true });
  });
});
