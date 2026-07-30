import { describe, expect, it, vi } from 'vitest';
import { buildShortcutActions, mainPaneBranch, shellFooterPath, tabClassName, type ShortcutActionsContext } from './appShell';

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
    };
    const ctx: ShortcutActionsContext = {
      preventDefault: spies.preventDefault,
      getActiveSessionId: () => null,
      getMainTab: () => 'session',
      setFocusedPane: spies.setFocusedPane,
      setMainTab: spies.setMainTab,
      setNewSessionOpen: spies.setNewSessionOpen,
      setNewAgentOpen: spies.setNewAgentOpen,
      closeAgentTab: spies.closeAgentTab,
      toggleLeftPane: spies.toggleLeftPane,
      toggleRightPane: spies.toggleRightPane,
      ...overrides,
    };
    return { ctx, spies };
  }

  it('covers every key the original if/else chain handled, both cases', () => {
    const { ctx } = fakeCtx();
    const actions = buildShortcutActions(ctx);
    expect(Object.keys(actions).sort()).toEqual(
      ['1', '2', '3', '4', '5', '[', ']', 'A', 'D', 'N', 'O', 'T', 'W', 'a', 'd', 'n', 'o', 't', 'w'].sort(),
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

  it('1-5 focus their pane without preventing default', () => {
    const { ctx, spies } = fakeCtx();
    const actions = buildShortcutActions(ctx);
    actions['1']();
    actions['2']();
    actions['3']();
    actions['4']();
    actions['5']();
    expect(spies.setFocusedPane.mock.calls.map((c) => c[0])).toEqual(['sidebar', 'main', 'agents', 'mcp', 'skills']);
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

  it('[ and ] toggle the side columns', () => {
    const { ctx, spies } = fakeCtx();
    const actions = buildShortcutActions(ctx);
    actions['[']();
    actions[']']();
    expect(spies.toggleLeftPane).toHaveBeenCalledTimes(1);
    expect(spies.toggleRightPane).toHaveBeenCalledTimes(1);
  });
});
