import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { ProjectMeta } from '../../../contract/projects';
import { groupKeyFor, pathLeaf } from './roster-groups';

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
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    ...over,
  };
}

function project(id: string, name: string, root = `/src/${name}`, groupId?: string): ProjectMeta {
  return {
    id,
    name,
    root,
    defaults: {} as ProjectMeta['defaults'],
    createdAt: 0,
    lastUsedAt: 0,
    rootExists: true,
    ...(groupId !== undefined ? { groupId } : {}),
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

