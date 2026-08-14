import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { ProjectMeta } from '../../../contract/projects';
import {
  flattenGroups,
  groupKeyFor,
  groupSessionsByRepo,
  parseCollapsedGroups,
  pathLeaf,
} from './roster-groups';

function session(over: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    name: over.id,
    cwd: '/tmp/repo',
    model: { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    runtime: 'native',
    accountId: 'default',
    provider: 'claude-code',
    ...over,
  };
}

function project(id: string, name: string, root = `/src/${name}`): ProjectMeta {
  return {
    id,
    name,
    root,
    defaults: {} as ProjectMeta['defaults'],
    createdAt: 0,
    lastUsedAt: 0,
    rootExists: true,
  };
}

describe('pathLeaf', () => {
  it('takes the last segment of a posix path', () => {
    expect(pathLeaf('/home/u/acme-api')).toBe('acme-api');
  });
  it('takes the last segment of a windows path', () => {
    expect(pathLeaf('D:\\work\\francois')).toBe('francois');
  });
  it('ignores trailing separators', () => {
    expect(pathLeaf('/home/u/acme-api/')).toBe('acme-api');
    expect(pathLeaf('D:\\work\\francois\\\\')).toBe('francois');
  });
  it('returns empty for an empty path', () => {
    expect(pathLeaf('')).toBe('');
    expect(pathLeaf('///')).toBe('');
  });
});

describe('groupKeyFor', () => {
  const projects = [project('p1', 'acme-api')];

  it('keys a project-backed session on the project id and labels it with the name', () => {
    const s = session({ id: 's1', cwd: '/w/whatever', projectId: 'p1' });
    expect(groupKeyFor(s, projects)).toEqual({ key: 'project:p1', label: 'acme-api', projectId: 'p1' });
  });

  it('keeps two same-named projects apart', () => {
    const both = [project('p1', 'api'), project('p2', 'api')];
    const a = groupKeyFor(session({ id: 'a', projectId: 'p1' }), both);
    const b = groupKeyFor(session({ id: 'b', projectId: 'p2' }), both);
    expect(a.key).not.toBe(b.key);
  });

  it('falls back to the cwd leaf for an unlinked session', () => {
    const s = session({ id: 's2', cwd: '/home/u/cartograph' });
    expect(groupKeyFor(s, projects)).toEqual({ key: 'path:cartograph', label: 'cartograph', projectId: null });
  });

  it('still keys on the id when the registry has not resolved the project yet', () => {
    const s = session({ id: 's3', cwd: '/home/u/docs-site', projectId: 'unresolved' });
    expect(groupKeyFor(s, [])).toEqual({ key: 'project:unresolved', label: 'docs-site', projectId: 'unresolved' });
  });

  it('labels a session with no usable cwd generically', () => {
    const s = session({ id: 's4', cwd: '' });
    expect(groupKeyFor(s, projects).label).toBe('elsewhere');
  });
});

describe('groupSessionsByRepo', () => {
  const projects = [project('p1', 'acme-api')];

  it('groups by repo and preserves first-appearance order', () => {
    const groups = groupSessionsByRepo(
      [
        session({ id: 'a', projectId: 'p1' }),
        session({ id: 'b', cwd: '/w/francois' }),
        session({ id: 'c', projectId: 'p1' }),
        session({ id: 'd', cwd: '/w/francois' }),
      ],
      projects,
    );
    expect(groups.map((g) => g.label)).toEqual(['acme-api', 'francois']);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['a', 'c']);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(['b', 'd']);
  });

  it('returns nothing for no sessions', () => {
    expect(groupSessionsByRepo([], projects)).toEqual([]);
  });
});

describe('flattenGroups', () => {
  const projects = [project('p1', 'acme-api')];
  const groups = groupSessionsByRepo(
    [session({ id: 'a', projectId: 'p1' }), session({ id: 'b', cwd: '/w/francois' }), session({ id: 'c', projectId: 'p1' })],
    projects,
  );

  it('walks the groups in painted order, not arrival order', () => {
    expect(flattenGroups(groups).map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('skips a collapsed group — a hidden row cannot take the cursor', () => {
    expect(flattenGroups(groups, new Set(['project:p1'])).map((s) => s.id)).toEqual(['b']);
  });
});

describe('parseCollapsedGroups', () => {
  it('defaults to nothing collapsed', () => {
    expect(parseCollapsedGroups(null)).toEqual(new Set());
  });
  it('round-trips a key list', () => {
    expect(parseCollapsedGroups('["project:p1","path:francois"]')).toEqual(new Set(['project:p1', 'path:francois']));
  });
  it('degrades on malformed input', () => {
    expect(parseCollapsedGroups('{')).toEqual(new Set());
    expect(parseCollapsedGroups('{"a":1}')).toEqual(new Set());
  });
  it('drops non-string entries', () => {
    expect(parseCollapsedGroups('["ok",3,null]')).toEqual(new Set(['ok']));
  });
});
