import { describe, expect, it, vi } from 'vitest';
import {
  buildShortcutActions,
  clampToPaneTab,
  dividerGridArea,
  mainPaneBranch,
  paneGridArea,
  paneMenuEntries,
  shellColumns,
  shellFooterPath,
  showsPanes,
  splitCandidate,
  type ShortcutActionsContext,
} from './appShell';

describe('shellColumns', () => {
  // design 7a: two tracks, not three — [3]-[6] are roster rows now, so the
  // roster is the only column left to size.
  it('gives the roster its full width at one pane', () => {
    expect(shellColumns('single', true)).toEqual({ template: '282px 1fr', leftRail: false });
  });

  it('narrows the roster while split, and keeps 282px only at one pane', () => {
    expect(shellColumns('split', true).template).toBe('238px 1fr');
    expect(shellColumns('grid', true).template).toBe('238px 1fr');
  });

  it('folds the roster to the 46px rail in EVERY regime — never to nothing', () => {
    for (const regime of ['single', 'split', 'grid'] as const) {
      expect(shellColumns(regime, false)).toEqual({ template: '46px 1fr', leftRail: true });
    }
  });
});

describe('paneGridArea', () => {
  it('leaves the one-row regimes to auto-placement', () => {
    expect(paneGridArea(0, 1)).toBeUndefined();
    expect(paneGridArea(0, 2)).toBeUndefined();
    expect(paneGridArea(1, 2)).toBeUndefined();
  });

  it('places four panes in the corners, skipping the gutter tracks', () => {
    expect(paneGridArea(0, 4)).toEqual({ gridColumn: '1', gridRow: '1' });
    expect(paneGridArea(1, 4)).toEqual({ gridColumn: '3', gridRow: '1' });
    expect(paneGridArea(2, 4)).toEqual({ gridColumn: '1', gridRow: '3' });
    expect(paneGridArea(3, 4)).toEqual({ gridColumn: '3', gridRow: '3' });
  });

  it('spans the third pane across the whole bottom row (FR-2)', () => {
    expect(paneGridArea(0, 3)).toEqual({ gridColumn: '1', gridRow: '1' });
    expect(paneGridArea(1, 3)).toEqual({ gridColumn: '3', gridRow: '1' });
    expect(paneGridArea(2, 3)).toEqual({ gridColumn: '1 / -1', gridRow: '3' });
  });
});

describe('dividerGridArea', () => {
  it('leaves the two-pane handle to auto-placement, and offers no row handle there', () => {
    expect(dividerGridArea('x', 2)).toBeUndefined();
    expect(dividerGridArea('y', 2)).toBeUndefined();
  });

  it('runs the column handle the full height at four panes', () => {
    expect(dividerGridArea('x', 4)).toEqual({ gridColumn: '2', gridRow: '1 / -1' });
  });

  it('stops the column handle at the top row when the third pane spans below it', () => {
    expect(dividerGridArea('x', 3)).toEqual({ gridColumn: '2', gridRow: '1' });
  });

  it('runs the row handle the full width in both grid regimes', () => {
    expect(dividerGridArea('y', 3)).toEqual({ gridColumn: '1 / -1', gridRow: '2' });
    expect(dividerGridArea('y', 4)).toEqual({ gridColumn: '1 / -1', gridRow: '2' });
  });
});

describe('shellFooterPath', () => {
  it('abbreviates a plain (non-WSL) cwd against home', () => {
    expect(shellFooterPath('/home/u/api', 'bash', '/home/u')).toBe('~/api');
  });

  it('renders a WSL cwd as distro:/path when the shell name does not already name it', () => {
    expect(shellFooterPath('\\\\wsl$\\Ubuntu\\home\\u\\api', 'bash', '/home/u')).toBe('Ubuntu:/home/u/api');
  });

  it('drops the redundant distro prefix when the shell name already names it (FR-12)', () => {
    expect(shellFooterPath('\\\\wsl$\\Ubuntu\\home\\u\\api', 'Ubuntu', '/home/u')).toBe('/home/u/api');
  });
});

describe('mainPaneBranch', () => {
  it('maps the four plain MainTab values onto themselves', () => {
    expect(mainPaneBranch('overview')).toBe('overview');
    expect(mainPaneBranch('session')).toBe('session');
    expect(mainPaneBranch('diff')).toBe('diff');
    expect(mainPaneBranch('shell')).toBe('shell');
  });

  it('collapses any dynamic agent:<id> tab onto the agent branch', () => {
    expect(mainPaneBranch('agent:abc-123')).toBe('agent');
  });

  // extensions FR-9: the third dynamic tab kind — one per available extension.
  it('routes an ext:<id> tab to the ext branch', () => {
    expect(mainPaneBranch('ext:cohorte')).toBe('ext');
    expect(mainPaneBranch('ext:git')).toBe('ext');
  });

  // workflow-details FR-11: the second dynamic tab kind gets its own branch.
  it('routes a workflow:<id> tab to the workflow branch', () => {
    expect(mainPaneBranch('workflow:run-1')).toBe('workflow');
  });
});

describe('buildShortcutActions', () => {
  function fakeCtx(overrides: Partial<ShortcutActionsContext> = {}): { ctx: ShortcutActionsContext; spies: Record<string, ReturnType<typeof vi.fn>> } {
    const spies = {
      preventDefault: vi.fn(),
      setFocusedPane: vi.fn(),
      setMainTab: vi.fn(),
      setNewSessionOpen: vi.fn(),
      setNewAgentOpen: vi.fn(),
      closeAgentTab: vi.fn(),
      toggleLeftPane: vi.fn(),
    };
    const ctx: ShortcutActionsContext = {
      preventDefault: spies.preventDefault,
      getActiveSessionId: () => null,
      getMainTab: () => 'session',
      getFocusedPane: () => 'sidebar',
      setFocusedPane: spies.setFocusedPane,
      setMainTab: spies.setMainTab,
      setNewSessionOpen: spies.setNewSessionOpen,
      setNewAgentOpen: spies.setNewAgentOpen,
      closeAgentTab: spies.closeAgentTab,
      toggleLeftPane: spies.toggleLeftPane,
      ...overrides,
    };
    return { ctx, spies };
  }

  // design 7a: `]` and `c` are gone with the right column they acted on; every
  // other key the original if/else chain handled is still here.
  it('covers every key the shortcut chain handles, both cases', () => {
    const { ctx } = fakeCtx();
    const actions = buildShortcutActions(ctx);
    expect(Object.keys(actions).sort()).toEqual(
      ['1', '2', '3', '4', '5', '6', '[', 'A', 'D', 'N', 'O', 'T', 'W', 'a', 'd', 'n', 'o', 't', 'w'].sort(),
    );
  });

  it('n/N opens the new-session modal and prevents default', () => {
    const { ctx, spies } = fakeCtx();
    const actions = buildShortcutActions(ctx);
    actions.n();
    expect(spies.preventDefault).toHaveBeenCalledTimes(1);
    expect(spies.setNewSessionOpen).toHaveBeenCalledWith(true);
    actions.N();
    expect(spies.setNewSessionOpen).toHaveBeenCalledTimes(2);
  });

  it('a/A is a no-op with no active session', () => {
    const { ctx, spies } = fakeCtx({ getActiveSessionId: () => null });
    buildShortcutActions(ctx).a();
    expect(spies.preventDefault).not.toHaveBeenCalled();
    expect(spies.setNewAgentOpen).not.toHaveBeenCalled();
  });

  // design 7a: the modal lives inside AgentsPanel, which is a main tab now, so
  // `a` opens that tab rather than focusing a right-column pane.
  it('a/A opens the agents tab and the new-agent modal when a session is active', () => {
    const { ctx, spies } = fakeCtx({ getActiveSessionId: () => 'sess-1' });
    buildShortcutActions(ctx).a();
    expect(spies.preventDefault).toHaveBeenCalledTimes(1);
    expect(spies.setFocusedPane).toHaveBeenCalledWith('main');
    expect(spies.setMainTab).toHaveBeenCalledWith('agents');
    expect(spies.setNewAgentOpen).toHaveBeenCalledWith(true);
  });

  // design 7a: 1/2 still move focus between the roster and the pane; 3-6 open
  // the four dissolved panes as MAIN TABS, since there is no column to focus.
  it('1-2 focus their pane and 3-6 open their panel tab, without preventing default', () => {
    const { ctx, spies } = fakeCtx();
    const actions = buildShortcutActions(ctx);
    actions['1']();
    actions['2']();
    actions['3']();
    actions['4']();
    actions['5']();
    actions['6']();
    expect(spies.setFocusedPane.mock.calls.map((c) => c[0])).toEqual(['sidebar', 'main', 'main', 'main', 'main', 'main']);
    expect(spies.setMainTab.mock.calls.map((c) => c[0])).toEqual(['agents', 'mcp', 'skills', 'workflows']);
    expect(spies.preventDefault).not.toHaveBeenCalled();
  });

  it('a panel key pressed twice returns to SESSION rather than being a one-way door', () => {
    const { ctx, spies } = fakeCtx({ getMainTab: () => 'skills' });
    buildShortcutActions(ctx)['5']();
    expect(spies.setMainTab).toHaveBeenCalledWith('session');
  });

  it('d toggles diff <-> session off the live mainTab, not a stale one', () => {
    const { ctx, spies } = fakeCtx({ getMainTab: () => 'diff' });
    buildShortcutActions(ctx).d();
    expect(spies.setFocusedPane).toHaveBeenCalledWith('main');
    expect(spies.setMainTab).toHaveBeenCalledWith('session');
  });

  it('t toggles session -> shell', () => {
    const { ctx, spies } = fakeCtx({ getMainTab: () => 'session' });
    buildShortcutActions(ctx).t();
    expect(spies.setMainTab).toHaveBeenCalledWith('shell');
  });

  it('o toggles overview <-> session', () => {
    const { ctx, spies } = fakeCtx({ getMainTab: () => 'overview' });
    buildShortcutActions(ctx).o();
    expect(spies.setMainTab).toHaveBeenCalledWith('session');
  });

  it('w closes the active agent tab only when mainTab is a dynamic agent:<id> tab', () => {
    const { ctx, spies } = fakeCtx({ getMainTab: () => 'session' });
    buildShortcutActions(ctx).w();
    expect(spies.preventDefault).not.toHaveBeenCalled();
    expect(spies.closeAgentTab).not.toHaveBeenCalled();

    const { ctx: ctx2, spies: spies2 } = fakeCtx({ getMainTab: () => 'agent:xyz' });
    buildShortcutActions(ctx2).w();
    expect(spies2.preventDefault).toHaveBeenCalledTimes(1);
    expect(spies2.closeAgentTab).toHaveBeenCalledWith('xyz');
  });

  // workflow-details FR-12: `w` closes whichever dynamic tab is active.
  it('w closes the active workflow tab too', () => {
    const { ctx, spies } = fakeCtx({ getMainTab: () => 'workflow:run-1' });
    buildShortcutActions(ctx).w();
    expect(spies.preventDefault).toHaveBeenCalledTimes(1);
    expect(spies.closeAgentTab).toHaveBeenCalledWith('run-1');
  });

  it('[ folds the roster (design 7a: the only column left to fold)', () => {
    const { ctx, spies } = fakeCtx();
    const actions = buildShortcutActions(ctx);
    actions['[']();
    expect(spies.toggleLeftPane).toHaveBeenCalledTimes(1);
    // design 7a: `]` and `c` acted on a right column that no longer exists.
    expect(actions[']']).toBeUndefined();
    expect(actions.c).toBeUndefined();
    expect(actions.C).toBeUndefined();
  });
});

// split-session §5 re-exports the two pure helpers under this module; their
// implementation (and their unit tests) live in src/lib/layoutStore.ts beside
// the PaneTab type the store slice needs at set() time.
describe('split-session re-exports (§5)', () => {
  it('exposes clampToPaneTab and splitCandidate from appShell', () => {
    expect(clampToPaneTab('overview')).toBe('session');
    expect(splitCandidate([], null)).toBeNull();
  });
});

// ── unbound-panes FR-9/FR-8 — the pane header's `⋯` hover menu ───────────────

describe('paneMenuEntries (unbound-panes FR-9)', () => {
  const ids = (...args: Parameters<typeof paneMenuEntries>) => paneMenuEntries(...args).map((e) => e.id);

  it('offers both entries on a non-zero SESSION pane with room and a project', () => {
    expect(ids(1, 'session', 2, 1)).toEqual(['convert-to-shell', 'open-shell-beside']);
  });

  it('FR-8: never offers `convert` on pane 0 — pane 0 is always a session pane', () => {
    expect(ids(0, 'session', 2, 1)).toEqual(['open-shell-beside']);
  });

  it('never offers `convert` on a pane that is ALREADY a shell', () => {
    expect(ids(1, 'shell', 2, 1)).toEqual(['open-shell-beside']);
  });

  it('drops `open beside` once the grid is full — there is no slot to open into', () => {
    expect(ids(1, 'session', 4, 1)).toEqual(['convert-to-shell']);
  });

  it('is EMPTY with no registered project — nothing could root a shell', () => {
    expect(ids(1, 'session', 2, 0)).toEqual([]);
    expect(ids(0, 'session', 1, 0)).toEqual([]);
  });

  it('labels each entry in ui_language, with the picker ellipsis', () => {
    const entries = paneMenuEntries(1, 'session', 2, 3);
    expect(entries.map((e) => e.label)).toEqual(['Convert to shell…', 'Open a shell pane beside…']);
  });
});

// ── unbound-panes FR-1 — OVERVIEW while split ────────────────────────────────
// split-by-4 FR-21 used to `unsplit()` before selecting OVERVIEW. FR-1 deletes
// that, which left OVERVIEW unreachable while split: the main view rendered the
// panes, and pane 0's tab clamps 'overview' to 'session'. OVERVIEW takes the
// view over instead, and the panes survive underneath.
describe('showsPanes (FR-1)', () => {
  it('shows the panes when split on any pane-scoped tab', () => {
    expect(showsPanes(2, 'session')).toBe(true);
    expect(showsPanes(3, 'diff')).toBe(true);
    expect(showsPanes(4, 'shell')).toBe(true);
  });

  it('yields the view to OVERVIEW at every split count', () => {
    expect(showsPanes(2, 'overview')).toBe(false);
    expect(showsPanes(3, 'overview')).toBe(false);
    expect(showsPanes(4, 'overview')).toBe(false);
  });

  it('never shows panes at one pane', () => {
    expect(showsPanes(1, 'session')).toBe(false);
    expect(showsPanes(1, 'overview')).toBe(false);
  });
});
