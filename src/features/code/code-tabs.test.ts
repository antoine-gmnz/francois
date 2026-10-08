import { describe, expect, it } from 'vitest';
import { EDITOR_MAX_TABS } from '../../../contract/code-editor';
import { closeTab, EMPTY_ROOT_TABS, openTab, tabLabels, touchTab, updateTab } from './code-tabs';
import { tab } from './code.testutil';

function fill(n: number) {
  let s = EMPTY_ROOT_TABS;
  for (let i = 0; i < n; i++) {
    const r = openTab(s, tab(`f${i}.ts`));
    if (!r.ok) throw new Error('refused');
    s = r.state;
  }
  return s;
}

describe('openTab (FR-6)', () => {
  it('adds a tab, activates it and records it as most recent', () => {
    const r = openTab(EMPTY_ROOT_TABS, tab('a.ts'));
    expect(r.ok && r.state.active).toBe('a.ts');
    expect(r.ok && r.state.mru).toEqual(['a.ts']);
  });

  it('re-opening an existing path focuses it without a second tab', () => {
    const s = fill(2);
    const r = openTab(s, tab('f0.ts', { version: 'v2' }));
    expect(r.ok && r.state.tabs).toHaveLength(2);
    expect(r.ok && r.state.active).toBe('f0.ts');
    expect(r.ok && r.state.mru[0]).toBe('f0.ts');
  });

  it('keeps the existing record (dirty, view state) when re-opening', () => {
    let s = fill(1);
    s = updateTab(s, 'f0.ts', { dirty: true, viewState: { top: 40 } });
    const r = openTab(s, tab('f0.ts'));
    expect(r.ok && r.state.tabs[0]).toMatchObject({ dirty: true, viewState: { top: 40 } });
  });

  it('evicts the least recently used CLEAN tab at the 13th open', () => {
    const s = fill(EDITOR_MAX_TABS);
    const r = openTab(s, tab('new.ts'));
    expect(r.ok && r.evicted).toBe('f0.ts');
    expect(r.ok && r.state.tabs).toHaveLength(EDITOR_MAX_TABS);
    expect(r.ok && r.state.tabs.some((t) => t.path === 'f0.ts')).toBe(false);
  });

  it('skips dirty tabs when picking the eviction victim', () => {
    let s = fill(EDITOR_MAX_TABS);
    s = updateTab(s, 'f0.ts', { dirty: true });
    const r = openTab(s, tab('new.ts'));
    expect(r.ok && r.evicted).toBe('f1.ts');
  });

  it('refuses when every tab is dirty', () => {
    let s = fill(EDITOR_MAX_TABS);
    for (let i = 0; i < EDITOR_MAX_TABS; i++) s = updateTab(s, `f${i}.ts`, { dirty: true });
    expect(openTab(s, tab('new.ts'))).toEqual({ ok: false, reason: 'all-dirty' });
  });
});

describe('closeTab', () => {
  it('activates the most recently used remaining tab', () => {
    let s = fill(3);
    s = touchTab(s, 'f0.ts');
    s = touchTab(s, 'f2.ts');
    const r = closeTab(s, 'f2.ts');
    expect(r.active).toBe('f0.ts');
    expect(r.tabs.map((t) => t.path)).toEqual(['f0.ts', 'f1.ts']);
  });

  it('keeps the active tab when closing a different one', () => {
    expect(closeTab(fill(3), 'f0.ts').active).toBe('f2.ts');
  });

  it('closing the last tab leaves no active path', () => {
    expect(closeTab(fill(1), 'f0.ts').active).toBeUndefined();
  });
});

describe('touchTab / updateTab', () => {
  it('ignores a path that is not open', () => {
    const s = fill(1);
    expect(touchTab(s, 'nope.ts')).toBe(s);
    expect(updateTab(s, 'nope.ts', { dirty: true })).toBe(s);
  });
});

describe('tabLabels', () => {
  it('uses the basename', () => {
    expect(tabLabels([tab('src/a.ts')])).toEqual({ 'src/a.ts': 'a.ts' });
  });
  it('adds the parent dir only when two basenames collide', () => {
    expect(tabLabels([tab('src/a.ts'), tab('lib/a.ts'), tab('b.ts')])).toEqual({
      'src/a.ts': 'src/a.ts',
      'lib/a.ts': 'lib/a.ts',
      'b.ts': 'b.ts',
    });
  });
});
