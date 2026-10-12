// code-editor-workspace FR-1/FR-3/FR-4: the workspace chrome's store.

import { beforeEach, describe, expect, it } from 'vitest';
import { initialWorkspaceState, useWorkspaceStore } from './workspaceStore';
import type { Problem } from './problems';

const w = () => useWorkspaceStore.getState();
const problem = (path: string): Problem => ({ path, severity: 'error', message: 'm', code: null, source: null, line: 1, column: 1, endLine: 1, endColumn: 2 });

beforeEach(() => useWorkspaceStore.setState(initialWorkspaceState()));

describe('sidebar view (FR-1)', () => {
  it('starts on the explorer; picking another view swaps it; re-picking collapses', () => {
    expect(w().sidebar).toBe('explorer');
    w().pickView('search');
    expect(w().sidebar).toBe('search');
    w().pickView('search');
    expect(w().sidebar).toBeNull();
    w().pickView('explorer');
    expect(w().sidebar).toBe('explorer');
  });

  it('the source-control view swaps in and collapses like the others', () => {
    w().pickView('changes');
    expect(w().sidebar).toBe('changes');
    w().pickView('changes');
    expect(w().sidebar).toBeNull();
  });

  it('showSearch always opens the search view and asks it to take focus', () => {
    w().pickView('search');
    w().pickView('search');
    const tick = w().searchFocusTick;
    w().showSearch();
    expect(w().sidebar).toBe('search');
    expect(w().searchFocusTick).toBe(tick + 1);
    w().showSearch();
    expect(w().sidebar).toBe('search');
  });
});

describe('problems panel (FR-3)', () => {
  it('toggles, and closing un-maximises it', () => {
    w().toggleProblems();
    expect(w().problemsOpen).toBe(true);
    w().toggleMaximized();
    expect(w().problemsMaximized).toBe(true);
    w().toggleProblems();
    expect(w()).toMatchObject({ problemsOpen: false, problemsMaximized: false });
  });

  it('keeps the filter and the problems per root', () => {
    w().setProblemFilter('unused');
    w().setProblems('project:p1', [problem('a.ts')]);
    expect(w().problemFilter).toBe('unused');
    expect(w().problemsByRootKey['project:p1']).toHaveLength(1);
  });
});

describe('language status (FR-4)', () => {
  it('records the TypeScript version and flips ready once', () => {
    w().setTsVersion('5.9.3');
    expect(w()).toMatchObject({ tsVersion: '5.9.3', tsReady: false });
    w().markTsReady();
    expect(w().tsReady).toBe(true);
  });
});
