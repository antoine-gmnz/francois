import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import { agoPhrase, claudeMdSegments, identityParts, recentInRepo, workingOnSegments } from './welcome';

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('');

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function session(over: Partial<SessionMeta> & Pick<SessionMeta, 'id'>): SessionMeta {
  return {
    name: over.id,
    cwd: '/repo',
    model: { id: 'opus', label: 'Opus 5' },
    status: 'done',
    contextUsedTokens: 0,
    contextLimitTokens: 200_000,
    startedAt: NOW - DAY,
    lastActivityAt: NOW - DAY,
    permissionMode: 'default',
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    ...over,
  };
}

describe('agoPhrase', () => {
  it('says "just now" instead of the card form "now"', () => {
    // formatRelativeTime is built for cards ('now'), which suffixes into the
    // nonsense "now ago".
    expect(agoPhrase(NOW - 2_000, NOW)).toBe('just now');
  });

  it('suffixes every other age', () => {
    expect(agoPhrase(NOW - 6 * DAY, NOW)).toBe('6d ago');
    expect(agoPhrase(NOW - 3 * 3600_000, NOW)).toBe('3h ago');
  });
});

describe('claudeMdSegments', () => {
  it('states the line count and the edit age, with the filename as the strong run', () => {
    const segs = claudeMdSegments({ lines: 41, modifiedAt: NOW - 6 * DAY }, NOW);
    expect(text(segs)).toBe('CLAUDE.md found — 41 lines, last edited 6d ago.');
    expect(segs[0]).toEqual({ text: 'CLAUDE.md', strong: true });
  });

  it('singularises a one-line file', () => {
    expect(text(claudeMdSegments({ lines: 1, modifiedAt: NOW }, NOW))).toBe(
      'CLAUDE.md found — 1 line, last edited just now.',
    );
  });

  it('invites /init when the repo has none', () => {
    const segs = claudeMdSegments(undefined, NOW);
    expect(text(segs)).toBe('No CLAUDE.md here yet — run /init to write one.');
    expect(segs.find((s) => s.strong)).toEqual({ text: '/init', strong: true });
  });
});

describe('workingOnSegments', () => {
  it('states the branch and how far ahead of the trunk it is', () => {
    const segs = workingOnSegments({ branch: 'router-adapter', detached: false, base: 'main', ahead: 4 });
    expect(text(segs!)).toBe('Working on router-adapter, 4 commits ahead of main.');
    expect(segs![1]).toEqual({ text: 'router-adapter', strong: true });
  });

  it('singularises a single commit', () => {
    const segs = workingOnSegments({ branch: 'fix', detached: false, base: 'main', ahead: 1 });
    expect(text(segs!)).toBe('Working on fix, 1 commit ahead of main.');
  });

  it('drops the clause when there is no trunk, or nothing ahead of it', () => {
    expect(text(workingOnSegments({ branch: 'main', detached: false })!)).toBe('Working on main.');
    expect(text(workingOnSegments({ branch: 'main', detached: false, base: 'master', ahead: 0 })!)).toBe(
      'Working on main.',
    );
  });

  it('states a detached HEAD as the sha it is parked on', () => {
    expect(text(workingOnSegments({ branch: '9f1c2ab', detached: true })!)).toBe('Detached at 9f1c2ab.');
  });

  it('is null outside a repo, so the header renders no line at all', () => {
    expect(workingOnSegments(undefined)).toBeNull();
  });
});

describe('identityParts', () => {
  it('reads model · account · branch, with the sidebar branch glyph', () => {
    expect(identityParts({ model: 'Opus 5', account: 'work@acme.dev', branch: 'main' })).toEqual([
      'Opus 5',
      'work@acme.dev',
      '⎇ main',
    ]);
  });

  it('drops what it has nothing to say about rather than rendering a blank part', () => {
    expect(identityParts({ model: 'Opus 5' })).toEqual(['Opus 5']);
    expect(identityParts({ model: 'Opus 5', account: '', branch: undefined })).toEqual(['Opus 5']);
    expect(identityParts({})).toEqual([]);
  });
});

describe('recentInRepo', () => {
  const current = session({ id: 'cur', status: 'idle', projectId: 'p1' });

  it('lists only finished sessions of the same project, newest first, excluding this one', () => {
    const sessions = [
      current,
      session({ id: 'a', projectId: 'p1', status: 'done', lastActivityAt: NOW - 2 * DAY, name: 'Split the auth middleware' }),
      session({ id: 'b', projectId: 'p1', status: 'error', lastActivityAt: NOW - DAY, name: 'Drop the legacy /v1 routes' }),
      session({ id: 'busy', projectId: 'p1', status: 'running', lastActivityAt: NOW }),
      session({ id: 'other', projectId: 'p2', status: 'done', lastActivityAt: NOW }),
    ];
    expect(recentInRepo(sessions, current, NOW)).toEqual([
      { id: 'b', name: 'Drop the legacy /v1 routes', done: false, age: '1d' },
      { id: 'a', name: 'Split the auth middleware', done: true, age: '2d' },
    ]);
  });

  it('falls back to the exact cwd for an unlinked session, and never mixes in linked ones', () => {
    const unlinked = session({ id: 'cur', status: 'idle', cwd: '/repo' });
    const sessions = [
      unlinked,
      session({ id: 'same', cwd: '/repo', lastActivityAt: NOW - DAY }),
      session({ id: 'elsewhere', cwd: '/other', lastActivityAt: NOW }),
      // Same directory but owned by a project — a different notion of "here".
      session({ id: 'linked', cwd: '/repo', projectId: 'p1', lastActivityAt: NOW }),
    ];
    expect(recentInRepo(sessions, unlinked, NOW).map((r) => r.id)).toEqual(['same']);
  });

  it('caps the list', () => {
    const sessions = [
      current,
      ...[1, 2, 3, 4, 5].map((n) => session({ id: `s${n}`, projectId: 'p1', lastActivityAt: NOW - n * DAY })),
    ];
    expect(recentInRepo(sessions, current, NOW).map((r) => r.id)).toEqual(['s1', 's2', 's3']);
    expect(recentInRepo(sessions, current, NOW, 1).map((r) => r.id)).toEqual(['s1']);
  });

  it('does not reorder the caller’s array', () => {
    const sessions = [
      current,
      session({ id: 'a', projectId: 'p1', lastActivityAt: NOW - 2 * DAY }),
      session({ id: 'b', projectId: 'p1', lastActivityAt: NOW - DAY }),
    ];
    recentInRepo(sessions, current, NOW);
    expect(sessions.map((s) => s.id)).toEqual(['cur', 'a', 'b']);
  });
});
