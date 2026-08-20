import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { ProjectGroup, ProjectMeta } from '../../../contract/projects';
import {
  COLLAPSED_TIERS_KEY,
  groupTiersOf,
  loadCollapsedTiers,
  parseCollapsedTiers,
  persistCollapsedTiers,
  tierOf,
  UNGROUPED_TIER_KEY,
  UNGROUPED_TIER_LABEL,
  withGroupTiers,
} from './group-tier';
import { groupSessionsByState, stateGroupKey } from './state-groups';

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
  } as SessionMeta;
}

function project(over: Partial<ProjectMeta> & { id: string }): ProjectMeta {
  return {
    name: over.id,
    root: `/root/${over.id}`,
    defaults: {},
    createdAt: 0,
    lastUsedAt: 0,
    rootExists: true,
    ...over,
  } as ProjectMeta;
}

function group(id: string, name: string): ProjectGroup {
  return { id, name, createdAt: 0 };
}

describe('tierOf', () => {
  const odo = group('g-odo', 'ODO');
  const groups = [odo];

  it('resolves a session through projectId -> groupId -> group (the happy path)', () => {
    const p = project({ id: 'p1', groupId: 'g-odo' });
    const s = session({ id: 'a', projectId: 'p1' });
    expect(tierOf(s, [p], groups)).toEqual({ key: 'group:g-odo', label: 'ODO' });
  });

  it('falls to ungrouped when there is no projectId', () => {
    const s = session({ id: 'a' });
    expect(tierOf(s, [], groups)).toEqual({ key: UNGROUPED_TIER_KEY, label: UNGROUPED_TIER_LABEL });
  });

  it('falls to ungrouped when the project is not (yet) in the registry', () => {
    const s = session({ id: 'a', projectId: 'unresolved' });
    expect(tierOf(s, [], groups)).toEqual({ key: UNGROUPED_TIER_KEY, label: UNGROUPED_TIER_LABEL });
  });

  it('falls to ungrouped when the project has no groupId', () => {
    const p = project({ id: 'p1' });
    const s = session({ id: 'a', projectId: 'p1' });
    expect(tierOf(s, [p], groups)).toEqual({ key: UNGROUPED_TIER_KEY, label: UNGROUPED_TIER_LABEL });
  });

  it('falls to ungrouped when the groupId names a group absent from the registry', () => {
    const p = project({ id: 'p1', groupId: 'gone' });
    const s = session({ id: 'a', projectId: 'p1' });
    expect(tierOf(s, [p], groups)).toEqual({ key: UNGROUPED_TIER_KEY, label: UNGROUPED_TIER_LABEL });
  });
});

describe('groupTiersOf', () => {
  const odo = group('g-odo', 'ODO');
  const perso = group('g-perso', 'Perso');
  const pOdo = project({ id: 'p-odo', groupId: 'g-odo' });
  const pPerso = project({ id: 'p-perso', groupId: 'g-perso' });
  const projects = [pOdo, pPerso];
  const groups = [odo, perso];

  it('returns null (suppressed) when every session in the band shares one tier', () => {
    const node = groupSessionsByState([
      session({ id: 'a', projectId: 'p-odo', status: 'idle' }),
      session({ id: 'b', projectId: 'p-odo', status: 'idle' }),
    ])[0];
    expect(groupTiersOf(node, projects, groups)).toBeNull();
  });

  it('returns null when every session is ungrouped (no exception)', () => {
    const node = groupSessionsByState([
      session({ id: 'a', status: 'idle' }),
      session({ id: 'b', status: 'idle' }),
    ])[0];
    expect(groupTiersOf(node, projects, groups)).toBeNull();
  });

  it('paints headings ordered by name, case-insensitive, ungrouped always last', () => {
    const node = groupSessionsByState([
      session({ id: 'a', status: 'idle' }), // elsewhere
      session({ id: 'b', projectId: 'p-perso', status: 'idle' }), // Perso
      session({ id: 'c', projectId: 'p-odo', status: 'idle' }), // ODO
    ])[0];
    const tiers = groupTiersOf(node, projects, groups)!;
    expect(tiers.map((t) => t.label)).toEqual(['ODO', 'Perso', UNGROUPED_TIER_LABEL]);
    expect(tiers.map((t) => t.sessions.map((s) => s.id))).toEqual([['c'], ['b'], ['a']]);
  });

  it('keeps sessions in incoming order inside a tier (no second sort)', () => {
    const node = groupSessionsByState([
      session({ id: 'z', projectId: 'p-odo', status: 'idle' }),
      session({ id: 'a', projectId: 'p-odo', status: 'idle' }),
      session({ id: 'x', projectId: 'p-perso', status: 'idle' }),
    ])[0];
    const tiers = groupTiersOf(node, projects, groups)!;
    expect(tiers.find((t) => t.label === 'ODO')!.sessions.map((s) => s.id)).toEqual(['z', 'a']);
  });

  it('paints two adjacent headings, one per groupId, for two groups sharing a name', () => {
    const dup1 = group('g-1', 'Same');
    const dup2 = group('g-2', 'Same');
    const p1 = project({ id: 'p1', groupId: 'g-1' });
    const p2 = project({ id: 'p2', groupId: 'g-2' });
    const node = groupSessionsByState([
      session({ id: 'a', projectId: 'p1', status: 'idle' }),
      session({ id: 'b', projectId: 'p2', status: 'idle' }),
    ])[0];
    const tiers = groupTiersOf(node, [p1, p2], [dup1, dup2])!;
    expect(tiers).toHaveLength(2);
    expect(tiers.map((t) => t.groupKey)).toEqual(['group:g-1', 'group:g-2']);
    expect(tiers[0].key).not.toBe(tiers[1].key);
  });

  it('scopes the collapse key to the band it is in (FR-9)', () => {
    const node = groupSessionsByState([
      session({ id: 'a', projectId: 'p-odo', status: 'idle' }),
      session({ id: 'b', projectId: 'p-perso', status: 'idle' }),
    ])[0];
    const tiers = groupTiersOf(node, projects, groups)!;
    expect(tiers.every((t) => t.key.startsWith(`gtier:${stateGroupKey('idle')}:`))).toBe(true);
  });
});

describe('withGroupTiers', () => {
  it('attaches null tiers per node when suppressed', () => {
    const nodes = groupSessionsByState([session({ id: 'a', status: 'idle' })]);
    const withTiers = withGroupTiers(nodes, [], []);
    expect(withTiers[0].tiers).toBeNull();
  });
});

describe('collapse record (FR-10/FR-11)', () => {
  it('defaults to expanded (empty set) when nothing has been persisted', () => {
    expect([...parseCollapsedTiers(null)]).toEqual([]);
  });

  it('takes a persisted record verbatim', () => {
    expect([...parseCollapsedTiers('["gtier:state:idle:group:x"]')]).toEqual(['gtier:state:idle:group:x']);
  });

  it('degrades malformed / non-array input to expanded', () => {
    expect([...parseCollapsedTiers('not json')]).toEqual([]);
    expect([...parseCollapsedTiers('{"a":1}')]).toEqual([]);
  });

  it('drops non-string members', () => {
    expect([...parseCollapsedTiers('["a",7,null]')]).toEqual(['a']);
  });

  it('never throws without a localStorage (node test environment has none)', () => {
    expect(() => persistCollapsedTiers(new Set(['gtier:state:idle:group:x']))).not.toThrow();
    expect(() => loadCollapsedTiers()).not.toThrow();
    expect(COLLAPSED_TIERS_KEY).toBe('francois.collapsedRosterGroupTiers');
  });
});
