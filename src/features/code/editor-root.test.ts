import { describe, expect, it } from 'vitest';
import { defaultRoot, rootExists, rootKey, rootOptions, type RootProject, type RootSession } from './editor-root';

const projects: RootProject[] = [
  { id: 'p1', name: 'orbit' },
  { id: 'p2', name: 'atlas' },
];
const sessions: RootSession[] = [
  { id: 's1', name: 'orbit-api', projectId: 'p1', worktree: { branch: 'feat/auth-retry' } },
  { id: 's2', name: 'plain', projectId: 'p2' },
  { id: 's3', name: 'loose' },
];

describe('rootKey', () => {
  it('keys a root by kind and id', () => {
    expect(rootKey({ kind: 'project', projectId: 'p1' })).toBe('project:p1');
    expect(rootKey({ kind: 'session', sessionId: 's1' })).toBe('session:s1');
  });
});

describe('defaultRoot (FR-3, flow 1)', () => {
  it('roots at the selected session when it has a worktree', () => {
    expect(defaultRoot({ activeSessionId: 's1', activeProjectId: 'p2', sessions, projects })).toEqual({ kind: 'session', sessionId: 's1' });
  });
  it('falls back to the selected session\'s project when it has no worktree', () => {
    expect(defaultRoot({ activeSessionId: 's2', activeProjectId: null, sessions, projects })).toEqual({ kind: 'project', projectId: 'p2' });
  });
  it('roots at a project-less session itself (its cwd)', () => {
    expect(defaultRoot({ activeSessionId: 's3', activeProjectId: null, sessions, projects })).toEqual({ kind: 'session', sessionId: 's3' });
  });
  it('with no session: the active project, else the first project, else nothing', () => {
    expect(defaultRoot({ activeSessionId: null, activeProjectId: 'p2', sessions, projects })).toEqual({ kind: 'project', projectId: 'p2' });
    expect(defaultRoot({ activeSessionId: null, activeProjectId: null, sessions, projects })).toEqual({ kind: 'project', projectId: 'p1' });
    expect(defaultRoot({ activeSessionId: null, activeProjectId: null, sessions: [], projects: [] })).toBeNull();
  });
});

describe('rootOptions (flow 2)', () => {
  it('lists every project, then every session with a worktree', () => {
    expect(rootOptions(projects, sessions)).toEqual([
      { key: 'project:p1', root: { kind: 'project', projectId: 'p1' }, label: 'orbit', branch: null },
      { key: 'project:p2', root: { kind: 'project', projectId: 'p2' }, label: 'atlas', branch: null },
      { key: 'session:s1', root: { kind: 'session', sessionId: 's1' }, label: 'orbit-api', branch: 'feat/auth-retry' },
    ]);
  });
});

describe('rootExists (§7)', () => {
  it('is false once the project or session is gone', () => {
    expect(rootExists({ kind: 'project', projectId: 'p1' }, projects, sessions)).toBe(true);
    expect(rootExists({ kind: 'project', projectId: 'gone' }, projects, sessions)).toBe(false);
    expect(rootExists({ kind: 'session', sessionId: 's3' }, projects, sessions)).toBe(true);
    expect(rootExists({ kind: 'session', sessionId: 'gone' }, projects, sessions)).toBe(false);
  });
});
