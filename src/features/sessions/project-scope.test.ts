import { describe, expect, it } from 'vitest';
import type { SessionMeta, SessionStatus } from '../../../contract/common';
import type { ProjectGroup, ProjectMeta } from '../../../contract/projects';
import { flattenScopeTiers, matchesScopeQuery, projectScopeView, scopeFlyoutPlacement } from './project-scope';

const project = (id: string, over: Partial<ProjectMeta> = {}) => ({ id, name: id, root: `/code/${id}`, rootExists: true, ...over }) as ProjectMeta;
const session = (projectId: string, status: SessionStatus = 'idle', name?: string) =>
  ({ id: `${projectId}-${status}-${Math.random()}`, name: name ?? status, projectId, status }) as SessionMeta;
const group = (id: string, name: string): ProjectGroup => ({ id, name, createdAt: 0 });

const projects = [
  project('orbit'),
  project('francois'),
  project('docs'),
  project('infra'),
  project('orbit-mobile', { groupId: 'g1' }),
  project('orbit-legacy', { groupId: 'g1', rootExists: false }),
  project('dotfiles'),
];
const sessions = [
  session('orbit', 'awaiting_approval'),
  session('orbit'),
  session('docs', 'awaiting_input'),
  session('infra', 'running'),
  session('infra'),
  session('orbit-mobile'),
];

describe('projectScopeView', () => {
  it('tiers projects: pinned, active now, each group, then the rest', () => {
    const view = projectScopeView(projects, [group('g1', 'Orbit group')], sessions, ['orbit', 'francois'], '');
    expect(view.tiers.map((t) => t.label)).toEqual(['Pinned', 'Active now', 'Orbit group', 'Other projects']);
    expect(view.tiers[0]!.rows.map((r) => r.id)).toEqual(['orbit', 'francois']);
    // blocked on you outranks running
    expect(view.tiers[1]!.rows.map((r) => [r.id, r.state])).toEqual([['docs', 'question'], ['infra', 'running']]);
    expect(view.tiers[2]!.rows.map((r) => r.id)).toEqual(['orbit-mobile', 'orbit-legacy']);
    expect(view.tiers[3]!.rows.map((r) => r.id)).toEqual(['dotfiles']);
    expect(view.total).toBe(7);
    expect(view.hidden).toBe(0);
  });

  it('carries the count, the most urgent state, the missing flag and the pin', () => {
    const rows = flattenScopeTiers(projectScopeView(projects, [], sessions, ['orbit'], ''));
    const orbit = rows.find((r) => r.id === 'orbit')!;
    expect(orbit).toMatchObject({ count: 2, state: 'approval', pinned: true, missing: false });
    expect(rows.find((r) => r.id === 'orbit-legacy')).toMatchObject({ count: 0, state: null, missing: true, pinned: false });
  });

  it('lists a row\'s own sessions, blocked-on-you/running first, then by name', () => {
    const named = [
      session('orbit', 'idle', 'zeta'),
      session('orbit', 'awaiting_approval', 'alpha'),
      session('orbit', 'idle', 'beta'),
    ];
    const rows = flattenScopeTiers(projectScopeView(projects, [], named, [], ''));
    const orbit = rows.find((r) => r.id === 'orbit')!;
    expect(orbit.sessions.map((s) => s.name)).toEqual(['alpha', 'beta', 'zeta']);
    expect(rows.find((r) => r.id === 'dotfiles')!.sessions).toEqual([]);
  });

  it('names the last tier "Projects" when there are no groups, and drops empty tiers', () => {
    const view = projectScopeView([project('a'), project('b')], [], [], [], '');
    expect(view.tiers.map((t) => t.label)).toEqual(['Projects']);
  });

  it('caps the rows and counts the rest, but never while searching', () => {
    const many = Array.from({ length: 14 }, (_, i) => project(`p${String(i).padStart(2, '0')}`));
    const capped = projectScopeView(many, [], [], [], '', 10);
    expect(flattenScopeTiers(capped)).toHaveLength(10);
    expect(capped.hidden).toBe(4);
    const searched = projectScopeView(many, [], [], [], 'p', 10);
    expect(flattenScopeTiers(searched)).toHaveLength(14);
    expect(searched.hidden).toBe(0);
  });

  it('filters by name and ignores pins for projects that no longer exist', () => {
    const view = projectScopeView(projects, [], sessions, ['gone', 'infra'], 'INF');
    expect(flattenScopeTiers(view).map((r) => r.id)).toEqual(['infra']);
    expect(view.tiers[0]!.label).toBe('Pinned');
  });
});

describe('matchesScopeQuery', () => {
  it('is a trimmed, case-insensitive substring match', () => {
    expect(matchesScopeQuery('orbit-mobile', ' MOB ')).toBe(true);
    expect(matchesScopeQuery('orbit', '')).toBe(true);
    expect(matchesScopeQuery('orbit', 'x')).toBe(false);
  });
});

describe('scopeFlyoutPlacement', () => {
  const viewport = { width: 1200, height: 800 };
  const size = { width: 220, height: 150 };

  it('opens to the right of the row when there is room', () => {
    const row = { left: 300, right: 400, top: 200 };
    expect(scopeFlyoutPlacement(row, viewport, size)).toEqual({ left: 404, top: 200 });
  });

  it('flips to the left when the right side has no room', () => {
    const row = { left: 1050, right: 1150, top: 200 };
    expect(scopeFlyoutPlacement(row, viewport, size)).toEqual({ left: 826, top: 200 });
  });

  it('clamps the top inside the window for a row near the bottom', () => {
    const row = { left: 300, right: 400, top: 760 };
    expect(scopeFlyoutPlacement(row, viewport, size)).toEqual({ left: 404, top: 642 });
  });
});
