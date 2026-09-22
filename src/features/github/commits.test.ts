import { describe, expect, it } from 'vitest';
import type { CheckRun, CommitSummary } from '../../../contract/github-page';
import type { SessionMeta } from '../../../contract/common';
import {
  commitAuthorLabel,
  commitChecksChip,
  commitChecksIcon,
  commitOrigin,
  commitTimeLabel,
  dayGroupLabel,
  filterCommits,
  groupCommitsByDay,
  otherCommitFiles,
} from './commits';

function commit(overrides: Partial<CommitSummary> = {}): CommitSummary {
  return {
    sha: '9c41ea2000000000000000000000000000000000',
    shortSha: '9c41ea2',
    subject: 'Cap the auth backoff window at 30 s',
    author: 'marie',
    authorIsViewer: false,
    committedAt: 0,
    byAgent: false,
    ...overrides,
  };
}

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'session-1' as SessionMeta['id'],
    name: 'auth-retry',
    cwd: '/repo',
    model: { id: 'opus', label: 'Opus' } as SessionMeta['model'],
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    permissionModeSince: 0,
    runtime: 'native',
    ...overrides,
  } as SessionMeta;
}

describe('dayGroupLabel / groupCommitsByDay', () => {
  const now = new Date('2026-09-22T12:00:00').getTime();

  it('labels today, yesterday and older dates', () => {
    expect(dayGroupLabel(now - 2 * 3_600_000, now)).toBe('TODAY');
    expect(dayGroupLabel(new Date('2026-09-21T09:00:00').getTime(), now)).toBe('YESTERDAY');
    expect(dayGroupLabel(new Date('2026-09-10T09:00:00').getTime(), now)).toBe('Sep 10');
  });

  it('groups consecutive commits by day, preserving newest-first order', () => {
    const commits = [
      commit({ shortSha: 'a', committedAt: now - 1_000 }),
      commit({ shortSha: 'b', committedAt: now - 2 * 3_600_000 }),
      commit({ shortSha: 'c', committedAt: new Date('2026-09-21T18:00:00').getTime() }),
    ];
    const groups = groupCommitsByDay(commits, now);
    expect(groups.map((g) => g.label)).toEqual(['TODAY', 'YESTERDAY']);
    expect(groups[0].commits).toHaveLength(2);
    expect(groups[1].commits).toHaveLength(1);
  });
});

describe('commitTimeLabel', () => {
  const now = new Date('2026-09-22T12:00:00').getTime();

  it('reports minutes/hours within today', () => {
    expect(commitTimeLabel(now - 30_000, now)).toBe('just now');
    expect(commitTimeLabel(now - 5 * 60_000, now)).toBe('5m ago');
    expect(commitTimeLabel(now - 2 * 3_600_000, now)).toBe('2 h ago');
  });

  it('reports "yesterday HH:MM" for the prior calendar day', () => {
    const ts = new Date('2026-09-21T18:40:00').getTime();
    expect(commitTimeLabel(ts, now)).toBe('yesterday 18:40');
  });

  it('reports a short date further back', () => {
    const ts = new Date('2026-09-10T09:00:00').getTime();
    expect(commitTimeLabel(ts, now)).toBe('Sep 10');
  });
});

describe('filterCommits', () => {
  it('passes everything through when the toggle is off', () => {
    const commits = [commit({ byAgent: true }), commit({ byAgent: false })];
    expect(filterCommits(commits, false)).toHaveLength(2);
  });

  it('keeps only agent-written commits when the toggle is on', () => {
    const commits = [commit({ byAgent: true }), commit({ byAgent: false })];
    expect(filterCommits(commits, true)).toEqual([commit({ byAgent: true })]);
  });
});

describe('commitOrigin', () => {
  it('is a session chip when agent-written and the ref is linked', () => {
    expect(commitOrigin(commit({ byAgent: true }), session({ name: 'auth-retry' }))).toEqual({
      kind: 'session',
      sessionName: 'auth-retry',
    });
  });

  it('is a neutral "agent" chip when agent-written but unlinked', () => {
    expect(commitOrigin(commit({ byAgent: true }), undefined)).toEqual({ kind: 'agent' });
  });

  it('is "by hand" for a non-agent commit, linked or not', () => {
    expect(commitOrigin(commit({ byAgent: false }), session())).toEqual({ kind: 'hand' });
    expect(commitOrigin(commit({ byAgent: false }), undefined)).toEqual({ kind: 'hand' });
  });
});

describe('commitChecksIcon / commitChecksChip', () => {
  const passed: CheckRun[] = [{ name: 'build', state: 'passed' }];
  const failed: CheckRun[] = [{ name: 'build', state: 'passed' }, { name: 'unit', state: 'failed' }];
  const pending: CheckRun[] = [{ name: 'build', state: 'pending' }];

  it('is null when checks are unknown', () => {
    expect(commitChecksIcon(undefined)).toBeNull();
    expect(commitChecksIcon([])).toBeNull();
    expect(commitChecksChip(undefined)).toBeNull();
  });

  it('shows check for all-passed and x when any failed', () => {
    expect(commitChecksIcon(passed)).toBe('check');
    expect(commitChecksIcon(failed)).toBe('x');
    expect(commitChecksIcon(pending)).toBeNull();
  });

  it('chip mirrors icon tone, with a pending label when nothing failed yet', () => {
    expect(commitChecksChip(passed)).toEqual({ label: 'checks passed', tone: 'success' });
    expect(commitChecksChip(failed)).toEqual({ label: 'checks failing', tone: 'danger' });
    expect(commitChecksChip(pending)).toEqual({ label: 'checks pending', tone: 'faint' });
  });
});

describe('commitAuthorLabel', () => {
  it('prefers "you"', () => {
    expect(commitAuthorLabel(commit({ authorIsViewer: true, author: 'marie' }))).toBe('you');
    expect(commitAuthorLabel(commit({ authorIsViewer: false, author: 'marie' }))).toBe('marie');
  });
});

describe('otherCommitFiles', () => {
  it('drops the first (largest) file, keeping the rest in order', () => {
    const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
    expect(otherCommitFiles(files)).toEqual([{ path: 'b' }, { path: 'c' }]);
  });
});
