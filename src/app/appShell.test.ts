import { describe, expect, it, vi } from 'vitest';
import {
  buildShortcutActions,
  clampToPaneTab,
  dividerGridArea,
  mainPaneBranch,
  paneGridArea,
  shellColumns,
  shellFooterPath,
  splitCandidate,
  tabClassName,
  type ShortcutActionsContext,
} from './appShell';

describe('shellColumns', () => {
  it('gives each column its full width when both are shown', () => {
    expect(shellColumns('single', true, true)).toEqual({
      template: '276px 1fr 296px',
      leftRail: false,
      rightRail: false,
    });
  });

  it('narrows the roster while split, and keeps 276px only at one pane', () => {
    expect(shellColumns('split', true, true).template).toBe('238px 1fr 296px');
    expect(shellColumns('grid', true, true).template).toBe('238px 1fr 296px');
  });

  it('folds a hidden column to the 46px rail in EVERY regime — never to nothing', () => {
    for (const regime of ['single', 'split', 'grid'] as const) {
      expect(shellColumns(regime, false, false)).toEqual({
        template: expect.stringMatching(/^46px 1fr 46px$/),
        leftRail: true,
        rightRail: true,
      });
    }
  });

  it('folds each side independently', () => {
    expect(shellColumns('single', false, true)).toEqual({
      template: '46px 1fr 296px',
      leftRail: true,
      rightRail: false,
    });
    expect(shellColumns('grid', true, false)).toEqual({
      template: '238px 1fr 46px',
      leftRail: false,
      rightRail: true,
    });
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

describe('tabClassName', () => {
  it('adds the --on modifier only when active', () => {
    expect(tabClassName(true)).toBe('app-tab app-tab--on');
    expect(tabClassName(false)).toBe('app-tab');
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
      toggleRightPane: vi.fn(),
      toggleCollapsedPane: vi.fn(),
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
      toggleRightPane: spies.toggleRightPane,
      toggleCollapsedPane: spies.toggleCollapsedPane,
      ...overrides,
    };
    return { ctx, spies };
  }

  it('covers every key the original if/else chain handled, both cases', () => {
    const { ctx } = fakeCtx();
    const actions = buildShortcutActions(ctx);
    expect(Object.keys(actions).sort()).toEqual(
      ['1', '2', '3', '4', '5', '6', '[', ']', 'A', 'C', 'D', 'N', 'O', 'T', 'W', 'a', 'c', 'd', 'n', 'o', 't', 'w'].sort(),
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

  it('a/A focuses the agents pane and opens the new-agent modal when a session is active', () => {
    const { ctx, spies } = fakeCtx({ getActiveSessionId: () => 'sess-1' });
    buildShortcutActions(ctx).a();
    expect(spies.preventDefault).toHaveBeenCalledTimes(1);
    expect(spies.setFocusedPane).toHaveBeenCalledWith('agents');
    expect(spies.setNewAgentOpen).toHaveBeenCalledWith(true);
  });

  it('1-6 focus their pane without preventing default', () => {
    const { ctx, spies } = fakeCtx();
    const actions = buildShortcutActions(ctx);
    actions['1']();
    actions['2']();
    actions['3']();
    actions['4']();
    actions['5']();
    actions['6']();
    expect(spies.setFocusedPane.mock.calls.map((c) => c[0])).toEqual([
      'sidebar',
      'main',
      'agents',
      'mcp',
      'skills',
      'workflows',
    ]);
    expect(spies.preventDefault).not.toHaveBeenCalled();
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

  it('[ and ] toggle the side columns', () => {
    const { ctx, spies } = fakeCtx();
    const actions = buildShortcutActions(ctx);
    actions['[']();
    actions[']']();
    expect(spies.toggleLeftPane).toHaveBeenCalledTimes(1);
    expect(spies.toggleRightPane).toHaveBeenCalledTimes(1);
  });

  it('c/C collapses the focused right pane (FR-10)', () => {
    const { ctx, spies } = fakeCtx({ getFocusedPane: () => 'mcp' });
    buildShortcutActions(ctx).c();
    expect(spies.toggleCollapsedPane).toHaveBeenCalledWith('mcp');
    buildShortcutActions(ctx).C();
    expect(spies.toggleCollapsedPane).toHaveBeenCalledTimes(2);
  });

  it('c is a no-op when focusedPane is sidebar or main (FR-10)', () => {
    const { ctx: sidebarCtx, spies: sidebarSpies } = fakeCtx({ getFocusedPane: () => 'sidebar' });
    buildShortcutActions(sidebarCtx).c();
    expect(sidebarSpies.toggleCollapsedPane).not.toHaveBeenCalled();

    const { ctx: mainCtx, spies: mainSpies } = fakeCtx({ getFocusedPane: () => 'main' });
    buildShortcutActions(mainCtx).c();
    expect(mainSpies.toggleCollapsedPane).not.toHaveBeenCalled();
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
