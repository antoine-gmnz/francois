import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { ProjectGroup, ProjectMeta } from '../../../contract/projects';
import {
  buildRoster,
  flattenGroups,
  groupKeyFor,
  groupSessionsByRepo,
  isGroupNode,
  parseCollapsedGroups,
  pathLeaf,
  type RosterNode,
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
    ...over,
  } as SessionMeta;
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

function group(id: string, name: string): ProjectGroup {
  return { id, name, createdAt: 0 };
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

describe('buildRoster (project-groups FR-11..FR-18)', () => {
  it('promotes a grouped project into its group node at the group\'s first-session position', () => {
    const projects = [project('p1', 'ODO - Frontend', '/src/odo-fe', 'g1'), project('p2', 'ODO - Databases', '/src/odo-db', 'g1')];
    const groups = [group('g1', 'ODO')];
    const nodes = buildRoster(
      [session({ id: 'a', projectId: 'p1' }), session({ id: 'b', cwd: '/w/loose' }), session({ id: 'c', projectId: 'p2' })],
      projects,
      groups,
    );
    // group appears where its FIRST member's first session did — before 'loose'
    expect(nodes.map((n) => n.key)).toEqual(['group:g1', 'path:loose']);
    const g = nodes[0];
    if (!isGroupNode(g)) throw new Error('expected a group node');
    expect(g.label).toBe('ODO');
    expect(g.sessionCount).toBe(2); // FR-14: sum over member projects
    expect(g.projects.map((p) => p.key)).toEqual(['project:p1', 'project:p2']);
  });

  it('a group whose members are interleaved with ungrouped projects stays at its own first position', () => {
    const projects = [project('p1', 'acme', '/src/acme', 'g1')];
    const groups = [group('g1', 'Acme co')];
    const nodes = buildRoster(
      [session({ id: 'x', cwd: '/w/loose1' }), session({ id: 'a', projectId: 'p1' }), session({ id: 'y', cwd: '/w/loose2' })],
      projects,
      groups,
    );
    expect(nodes.map((n) => n.key)).toEqual(['path:loose1', 'group:g1', 'path:loose2']);
  });

  it('a project whose groupId names a group not yet resolved stays top-level (FR-18)', () => {
    const projects = [project('p1', 'acme', '/src/acme', 'ghost')];
    const nodes = buildRoster([session({ id: 'a', projectId: 'p1' })], projects, []); // registry in flight
    expect(nodes).toHaveLength(1);
    expect(isGroupNode(nodes[0])).toBe(false);
    expect(nodes[0].key).toBe('project:p1');
  });

  it('emits no group node when every member has no visible session (FR-12)', () => {
    const projects = [project('p1', 'acme', '/src/acme', 'g1')];
    const groups = [group('g1', 'Acme co')];
    const nodes = buildRoster([], projects, groups);
    expect(nodes).toEqual([]);
  });
});

describe('isGroupNode', () => {
  it('distinguishes a group node from a project node', () => {
    const groupNode: RosterNode = { key: 'group:g1', label: 'ODO', groupId: 'g1', projects: [], sessionCount: 0 };
    const projectNode: RosterNode = { key: 'project:p1', label: 'acme', projectId: 'p1', sessions: [] };
    expect(isGroupNode(groupNode)).toBe(true);
    expect(isGroupNode(projectNode)).toBe(false);
  });
});

describe('flattenGroups over a mixed-depth tree (FR-17)', () => {
  const projects = [project('p1', 'ODO - Frontend', '/src/odo-fe', 'g1'), project('p2', 'ODO - Databases', '/src/odo-db', 'g1')];
  const groups = [group('g1', 'ODO')];
  const nodes = buildRoster(
    [session({ id: 'a', projectId: 'p1' }), session({ id: 'b', projectId: 'p2' }), session({ id: 'c', cwd: '/w/loose' })],
    projects,
    groups,
  );

  it('walks a mixed-depth tree in painted order regardless of depth', () => {
    expect(flattenGroups(nodes).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('skips a collapsed group\'s entire subtree', () => {
    expect(flattenGroups(nodes, new Set(['group:g1'])).map((s) => s.id)).toEqual(['c']);
  });

  it('a group all of whose members are collapsed yields no sessions from it', () => {
    expect(flattenGroups(nodes, new Set(['project:p1', 'project:p2'])).map((s) => s.id)).toEqual(['c']);
  });

  it('an expanded group still honors an individual project\'s own collapse', () => {
    expect(flattenGroups(nodes, new Set(['project:p1'])).map((s) => s.id)).toEqual(['b', 'c']);
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
