import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { ProjectMeta } from '../../../contract/projects';
import { scopeChips } from './scope-chips';

const p = (id: string, name: string, lastUsedAt = 0) => ({ id, name, lastUsedAt }) as unknown as ProjectMeta;
const s = (projectId: string | null, status: SessionMeta['status'] = 'idle') => ({ projectId, status }) as unknown as SessionMeta;

describe('scopeChips', () => {
  const projects = [p('a', 'alpha'), p('b', 'beta'), p('c', 'gamma'), p('d', 'delta')];
  const sessions = [s('a'), s('b'), s('b'), s('b'), s('c', 'awaiting_approval'), s('c'), s(null)];

  it('counts every session for All, and each project its own', () => {
    const view = scopeChips(projects, sessions, null, 2);
    expect(view.total).toBe(7);
    expect(view.chips.map((c) => [c.id, c.count])).toEqual([
      ['b', 3],
      ['c', 2],
    ]);
  });

  it('orders by session count, then name, and caps the visible chips', () => {
    const view = scopeChips(projects, sessions, null, 2);
    expect(view.chips.map((c) => c.name)).toEqual(['beta', 'gamma']);
    // alpha (1 session) and delta (0) fold into the overflow.
    expect(view.overflow).toBe(2);
  });

  it('flags a project holding a session that needs you', () => {
    const view = scopeChips(projects, sessions, null, 3);
    expect(view.chips.find((c) => c.id === 'c')?.attention).toBe(true);
    expect(view.chips.find((c) => c.id === 'b')?.attention).toBe(false);
  });

  it('always shows the active project, even past the cap', () => {
    const view = scopeChips(projects, sessions, 'd', 2);
    expect(view.chips.map((c) => c.id)).toEqual(['d', 'b']);
    expect(view.chips[0].count).toBe(0);
    expect(view.overflow).toBe(2);
  });

  it('never shows a project with no sessions unless it is active', () => {
    const view = scopeChips(projects, sessions, null, 10);
    expect(view.chips.map((c) => c.id)).not.toContain('d');
    expect(view.overflow).toBe(1);
  });

  it('puts pinned projects first, in pin order, even without sessions', () => {
    const view = scopeChips(projects, sessions, null, 2, ['d', 'zz']);
    expect(view.chips.map((c) => c.id)).toEqual(['d', 'b']);
    expect(scopeChips(projects, sessions, 'd', 2, ['d', 'a']).chips.map((c) => c.id)).toEqual(['d', 'a']);
  });
});
