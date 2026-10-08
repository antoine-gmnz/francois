import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { PullSummary } from '../../../contract/github-page';
import { joinRosterPulls, pullMarkerTitle, pullScope } from './roster-pulls';

const session = (id: string, cwd: string, worktree?: Partial<SessionMeta['worktree']>): SessionMeta =>
  ({ id, cwd, worktree: worktree as SessionMeta['worktree'] }) as SessionMeta;

const pull = (number: number, head: string, state: PullSummary['state'] = 'open'): PullSummary =>
  ({ number, head, state, title: `t${number}`, updatedAt: number }) as PullSummary;

describe('pullScope', () => {
  it('reads a worktree session from its source repo', () => {
    expect(pullScope(session('a', '/wt/feat', { sourceRepoRoot: '/repo' }))).toBe('/repo');
  });
  it('reads a main-checkout session from its cwd', () => {
    expect(pullScope(session('a', '/repo'))).toBe('/repo');
  });
});

describe('joinRosterPulls', () => {
  const pulls = new Map([['/repo', [pull(1, 'feat/a'), pull(2, 'feat/b', 'draft'), pull(3, 'feat/c', 'merged')]]]);

  it('matches each session to the open or draft PR on its branch', () => {
    const sessions = [session('a', '/repo'), session('b', '/wt/b', { sourceRepoRoot: '/repo' })];
    const branches = new Map([
      ['a', 'feat/a'],
      ['b', 'feat/b'],
    ]);
    const out = joinRosterPulls(sessions, branches, pulls);
    expect(out.get('a')?.number).toBe(1);
    expect(out.get('b')?.number).toBe(2);
  });

  it('leaves out merged PRs, unknown branches and unprobed repos', () => {
    const sessions = [session('c', '/repo'), session('d', '/repo'), session('e', '/other')];
    const branches = new Map([
      ['c', 'feat/c'],
      ['e', 'feat/a'],
    ]);
    expect(joinRosterPulls(sessions, branches, pulls).size).toBe(0);
  });
});

describe('pullMarkerTitle', () => {
  it('names the PR and flags drafts', () => {
    expect(pullMarkerTitle(pull(42, 'x'))).toBe('PR #42 · t42');
    expect(pullMarkerTitle(pull(7, 'x', 'draft'))).toBe('Draft PR #7 · t7');
  });
});
