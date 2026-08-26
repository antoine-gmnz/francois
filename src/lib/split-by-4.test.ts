// split-by-4 / unbound-panes: the pane list store slice's stateful behavior —
// pane count/shell-pane changes, focus, shell disposal side effects, and the
// localStorage round-trip. Pure selectors live in
// split-by-4-selectors.test.ts; parseSplitState's normalization lives in
// split-by-4-persistence.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../contract/common';

// unbound-panes FR-10: closePane/unsplit/assignToFocusedPane can call
// shellDispose on a dropped shell pane — mocked exactly like shellActions.test.ts,
// since this file imports layoutStore.ts directly (not through the app's own
// Tauri bootstrap).
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { MAX_PANES, paneCount, parseSplitState, SPLIT_STORAGE_KEY, type PaneSlot } from './layoutStore';

function mockStorage(seed: Record<string, string> = {}): { store: Record<string, string> } {
  const state = { store: { ...seed } };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in state.store ? state.store[k] : null),
    setItem: (k: string, v: string) => {
      state.store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete state.store[k];
    },
    clear: () => {
      state.store = {};
    },
  });
  return state;
}

// Every test here that calls freshStore re-imports the whole store graph, and
// the first one to do so pays its cold transform — which on a loaded machine
// (126 files in parallel) overruns the 5s default and fails a test that does
// nothing but import. Same guard as projectsStore.test.ts: a machine-speed
// bound, not a behavioural one.
vi.setConfig({ testTimeout: 30_000 });

async function freshStore() {
  vi.resetModules();
  const mod = await import('./store');
  return mod.useStore;
}

function meta(id: string, lastActivityAt: number, status: SessionMeta['status'] = 'idle'): SessionMeta {
  return {
    id,
    name: id,
    cwd: '/repo',
    model: { id: 'm', label: 'M' },
    status,
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt,
    permissionMode: 'default',
    permissionModeSince: 0,
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    responseMode: 'default',
    allowGit: false,
  };
}

function sessionPane(sessionId: string | null, tab = 'session'): PaneSlot {
  return { kind: 'session', sessionId, tab } as PaneSlot;
}

function shellPane(projectId: string, shellId: string | null = null): PaneSlot {
  return { kind: 'shell', projectId, shellId };
}

// ── store slice ─────────────────────────────────────────────────────────────

describe('pane store slice', () => {
  let storage: { store: Record<string, string> };

  beforeEach(() => {
    storage = mockStorage();
    invokeMock.mockReset().mockResolvedValue({ ok: true, data: null });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const readSplit = () => JSON.parse(storage.store[SPLIT_STORAGE_KEY]);

  const FLEET = [meta('s1', 10), meta('s2', 40), meta('s3', 30), meta('s4', 20), meta('s5', 5)];

  it('defaults to one pane with an empty storage', async () => {
    const useStore = await freshStore();
    expect(useStore.getState().extraPanes).toEqual([]);
    expect(useStore.getState().focusedPaneIndex).toBe(0);
  });

  it('hydrates from a persisted record, legacy shape included (FR-23)', async () => {
    storage.store[SPLIT_STORAGE_KEY] = JSON.stringify({ splitSessionId: 's2', splitTab: 'diff', focusedSide: 'right' });
    const useStore = await freshStore();
    expect(useStore.getState().extraPanes).toEqual([sessionPane('s2', 'diff')]);
    expect(useStore.getState().focusedPaneIndex).toBe(1);
  });

  it('openInNewPane appends, focuses it, and folds the right column without persisting (FR-5/FR-18)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff', focusedPane: 'sidebar' });
    useStore.getState().openInNewPane('s2');
    const s = useStore.getState();
    expect(s.extraPanes).toEqual([sessionPane('s2', 'session')]);
    expect(s.focusedPaneIndex).toBe(1);
    expect(s.focusedPane).toBe('main');
    expect(s.activeSessionId).toBe('s1');
    expect(s.mainTab).toBe('diff'); // pane 0 keeps its tab
    expect(s.showRightPane).toBe(false);
    expect(storage.store['francois.showRightPane']).toBeUndefined(); // FR-5: not persisted
    expect(readSplit()).toEqual({ extraPanes: [sessionPane('s2', 'session')], focusedPaneIndex: 1 });
  });

  it('openInNewPane clamps pane 0 out of overview (FR-20)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'overview' });
    useStore.getState().openInNewPane('s2');
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('openInNewPane KEEPS pane 0’s dynamic tab and its tabs (fix-agent-view FR-10)', async () => {
    const useStore = await freshStore();
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'agent:a1',
      agentTabs: new Map([['s1', [{ id: 'a1', name: 'x', status: 'running' } as const]]]),
    });
    useStore.getState().openInNewPane('s2');
    expect(useStore.getState().mainTab).toBe('agent:a1');
    expect(useStore.getState().agentTabs.get('s1')).toHaveLength(1);
  });

  it('openInNewPane FOCUSES a session already on screen rather than duplicating it', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session' });
    useStore.getState().openInNewPane('s2');
    useStore.getState().setPaneTab(1, 'diff');
    useStore.getState().setFocusedPaneIndex(0);

    useStore.getState().openInNewPane('s2');
    expect(useStore.getState().extraPanes).toEqual([sessionPane('s2', 'diff')]); // tab preserved
    expect(useStore.getState().focusedPaneIndex).toBe(1);

    useStore.getState().openInNewPane('s1');
    expect(useStore.getState().extraPanes).toHaveLength(1);
    expect(useStore.getState().focusedPaneIndex).toBe(0);
  });

  it('openInNewPane is a no-op once the grid is full (FR-18)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', sessions: FLEET, activeProjectId: null });
    useStore.getState().openInNewPane('s2');
    useStore.getState().openInNewPane('s3');
    useStore.getState().openInNewPane('s4');
    expect(useStore.getState().extraPanes).toHaveLength(MAX_PANES - 1);
    useStore.getState().openInNewPane('s5');
    expect(useStore.getState().extraPanes).toHaveLength(MAX_PANES - 1);
  });

  it('setPaneCount grows from the WHOLE FLEET regardless of scope (unbound-panes FR-3, folding both columns)', async () => {
    const useStore = await freshStore();
    // activeProjectId scopes only the roster/OVERVIEW now — growth ignores it.
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: FLEET, activeProjectId: 'some-other-project' });
    useStore.getState().setPaneCount(4);
    const s = useStore.getState();
    expect(s.extraPanes.map((p) => (p.kind === 'session' ? p.sessionId : null))).toEqual(['s2', 's3', 's4']);
    expect(s.showLeftPane).toBe(false);
    expect(s.showRightPane).toBe(false);
    expect(storage.store['francois.showLeftPane']).toBeUndefined();
  });

  it('setPaneCount(2) from the grid keeps the FOCUSED pane and restores the roster (FR-4/FR-15)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: FLEET, activeProjectId: null });
    useStore.getState().setPaneCount(4);
    useStore.getState().setFocusedPaneIndex(2); // s3
    useStore.getState().setPaneCount(2);
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s1');
    expect(s.extraPanes.map((p) => (p.kind === 'session' ? p.sessionId : null))).toEqual(['s3']);
    expect(s.focusedPaneIndex).toBe(1);
    expect(s.showLeftPane).toBe(true);
    expect(s.showRightPane).toBe(false);
  });

  it('every setPaneCount target lands from THREE panes', async () => {
    for (const [target, expected] of [
      [1, 0],
      [2, 1],
      [4, 3],
    ] as const) {
      const useStore = await freshStore();
      useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: FLEET, activeProjectId: null });
      useStore.getState().setPaneCount(4);
      useStore.getState().closePane(3); // 4 → 3, the only way to reach three
      expect(paneCount(useStore.getState())).toBe(3);

      useStore.getState().setPaneCount(target);
      expect(useStore.getState().extraPanes).toHaveLength(expected);
    }
  });

  it('setPaneCount(1) promotes the focused pane and restores both columns (FR-15/FR-16)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: FLEET, activeProjectId: null });
    useStore.getState().setPaneCount(4);
    useStore.getState().setFocusedPaneIndex(1); // s2
    useStore.getState().setPaneTab(1, 'shell');
    useStore.getState().setPaneCount(1);
    const s = useStore.getState();
    expect(s.extraPanes).toEqual([]);
    expect(s.focusedPaneIndex).toBe(0);
    expect(s.activeSessionId).toBe('s2');
    expect(s.mainTab).toBe('shell');
    expect(s.showLeftPane).toBe(true);
    expect(s.showRightPane).toBe(true);
    expect(readSplit()).toEqual({ extraPanes: [], focusedPaneIndex: 0 });
  });

  it('setPaneCount pads with EMPTY panes when the candidates run out (FR-15)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: [meta('s1', 1), meta('s2', 2)], activeProjectId: null });
    useStore.getState().setPaneCount(4);
    expect(useStore.getState().extraPanes.map((p) => (p.kind === 'session' ? p.sessionId : null))).toEqual(['s2', null, null]);
  });

  it('a ONE-session project still splits — the second pane is simply empty (FR-15)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: [meta('s1', 1)], activeProjectId: null });
    useStore.getState().setPaneCount(2);
    expect(useStore.getState().extraPanes).toEqual([sessionPane(null)]);
    expect(useStore.getState().showRightPane).toBe(false);
    expect(readSplit().extraPanes).toEqual([sessionPane(null)]);
  });

  it('openInNewPane FILLS the first empty pane rather than opening another beside it', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: [meta('s1', 1)], activeProjectId: null });
    useStore.getState().setPaneCount(4); // s1 | ∅ ∅ ∅
    useStore.getState().openInNewPane('s9');
    const s = useStore.getState();
    expect(s.extraPanes.map((p) => (p.kind === 'session' ? p.sessionId : null))).toEqual(['s9', null, null]);
    expect(s.focusedPaneIndex).toBe(1);
  });

  it('assignToFocusedPane fills an empty focused pane', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: [meta('s1', 1)], activeProjectId: null });
    useStore.getState().setPaneCount(2);
    useStore.getState().setFocusedPaneIndex(1);
    useStore.getState().assignToFocusedPane('s9');
    expect(useStore.getState().extraPanes).toEqual([sessionPane('s9')]);
  });

  it('unbound-panes FR-5: assignToFocusedPane is a PLAIN assign — duplicates a session already elsewhere', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff', sessions: FLEET, activeProjectId: null });
    useStore.getState().setPaneCount(2); // s1 | s2
    useStore.getState().setFocusedPaneIndex(1);
    useStore.getState().assignToFocusedPane('s1'); // pane 0's own session
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s1'); // pane 0 untouched — no swap
    expect(s.extraPanes).toEqual([sessionPane('s1')]);
  });

  it('keeps an empty pane through a shrink and a close — it is a layout, not a leftover', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: [meta('s1', 1), meta('s2', 2)], activeProjectId: null });
    useStore.getState().setPaneCount(4); // s1 | s2 ∅ ∅
    useStore.getState().setPaneCount(2);
    expect(useStore.getState().extraPanes.map((p) => (p.kind === 'session' ? p.sessionId : null))).toEqual(['s2']);

    useStore.getState().setPaneCount(4); // s1 | s2 ∅ ∅ again
    useStore.getState().closePane(1); // drop s2
    expect(useStore.getState().extraPanes.map((p) => (p.kind === 'session' ? p.sessionId : null))).toEqual([null, null]);
  });

  it('parseSplitState round-trips an empty pane, and allows several (FR-15/FR-23)', () => {
    const rec = { extraPanes: [sessionPane(null), sessionPane(null)], focusedPaneIndex: 1 };
    expect(parseSplitState(JSON.stringify(rec))).toEqual(rec);
  });

  it('unsplit(index) promotes THAT pane, and unsplit(index, tab) overrides its tab (FR-16/FR-11)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: FLEET, activeProjectId: null });
    useStore.getState().setPaneCount(4);
    useStore.getState().unsplit(2, 'diff');
    const s = useStore.getState();
    expect(s.extraPanes).toEqual([]);
    expect(s.activeSessionId).toBe('s3');
    expect(s.mainTab).toBe('diff');
  });

  it('closePane compacts the grid and keeps focus on the slot (FR-17)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: FLEET, activeProjectId: null });
    useStore.getState().setPaneCount(4); // s1 | s2 s3 s4
    useStore.getState().setFocusedPaneIndex(2); // s3
    useStore.getState().closePane(2);
    let s = useStore.getState();
    expect(s.extraPanes.map((p) => (p.kind === 'session' ? p.sessionId : null))).toEqual(['s2', 's4']);
    expect(s.focusedPaneIndex).toBe(2); // s4 slid into the slot

    // closing pane 0 promotes pane 1 (unbound-panes FR-8: the next SESSION pane)
    useStore.getState().closePane(0);
    s = useStore.getState();
    expect(s.activeSessionId).toBe('s2');
    expect(s.extraPanes.map((p) => (p.kind === 'session' ? p.sessionId : null))).toEqual(['s4']);

    // the last close leaves a single pane
    useStore.getState().closePane(1);
    s = useStore.getState();
    expect(s.extraPanes).toEqual([]);
    expect(s.activeSessionId).toBe('s2');
    expect(s.showLeftPane).toBe(true);
  });

  it('setFocusedPaneIndex clamps, persists, and hands focus to main (FR-12)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', focusedPane: 'sidebar' });
    useStore.getState().openInNewPane('s2');
    useStore.getState().setFocusedPaneIndex(9);
    expect(useStore.getState().focusedPaneIndex).toBe(1);
    useStore.setState({ focusedPane: 'agents' });
    useStore.getState().setFocusedPaneIndex(0);
    expect(useStore.getState().focusedPaneIndex).toBe(0);
    expect(useStore.getState().focusedPane).toBe('main');
    expect(readSplit().focusedPaneIndex).toBe(0);
  });

  it('focusNextWaitingPane walks to the next parked pane and wraps, ignoring the working ones (FR-14)', async () => {
    const useStore = await freshStore();
    const fleet = [
      meta('s1', 10, 'running'),
      meta('s2', 40, 'running'),
      meta('s3', 30, 'awaiting_approval'),
      meta('s4', 20, 'awaiting_input'),
    ];
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: fleet, activeProjectId: null });
    useStore.getState().setPaneCount(4); // s1 | s2 s3 s4
    useStore.getState().setFocusedPaneIndex(0);

    useStore.getState().focusNextWaitingPane();
    expect(useStore.getState().focusedPaneIndex).toBe(2); // skipped s2 (running)
    useStore.getState().focusNextWaitingPane();
    expect(useStore.getState().focusedPaneIndex).toBe(3);
    useStore.getState().focusNextWaitingPane();
    expect(useStore.getState().focusedPaneIndex).toBe(2); // wrapped
  });

  it('focusNextWaitingPane is a no-op when nothing is parked', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: FLEET, activeProjectId: null });
    useStore.getState().setPaneCount(2);
    useStore.getState().focusNextWaitingPane();
    expect(useStore.getState().focusedPaneIndex).toBe(0);
  });

  it('removeSession drops the session from its pane and compacts (FR-27)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: FLEET, activeProjectId: null });
    useStore.getState().setPaneCount(4); // s1 | s2 s3 s4
    useStore.getState().setFocusedPaneIndex(3);
    useStore.getState().removeSession('s3');
    const s = useStore.getState();
    expect(s.extraPanes.map((p) => (p.kind === 'session' ? p.sessionId : null))).toEqual(['s2', 's4']);
    expect(s.focusedPaneIndex).toBe(2);
    expect(readSplit().extraPanes).toHaveLength(2);
  });

  it('removeSession leaves the panes alone when the session was not in one', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: FLEET, activeProjectId: null });
    useStore.getState().openInNewPane('s2');
    useStore.getState().removeSession('s5');
    expect(useStore.getState().extraPanes).toEqual([sessionPane('s2')]);
  });

  // ── unbound-panes: shell panes ──────────────────────────────────────────

  it('openShellPane fills the first empty pane, else appends and folds the columns (FR-9)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session' });
    useStore.getState().openShellPane('p1');
    let s = useStore.getState();
    expect(s.extraPanes).toEqual([shellPane('p1')]);
    expect(s.focusedPaneIndex).toBe(1);
    expect(s.focusedPane).toBe('main');
    expect(readSplit()).toEqual({ extraPanes: [{ kind: 'shell', projectId: 'p1' }], focusedPaneIndex: 1 });

    useStore.getState().openShellPane('p2');
    s = useStore.getState();
    expect(s.extraPanes).toEqual([shellPane('p1'), shellPane('p2')]);
    expect(s.focusedPaneIndex).toBe(2);
  });

  it('openShellPane is a no-op once the grid is full', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', sessions: FLEET, activeProjectId: null });
    useStore.getState().setPaneCount(4);
    const before = useStore.getState().extraPanes;
    useStore.getState().openShellPane('p1');
    expect(useStore.getState().extraPanes).toBe(before);
  });

  it('convertPaneToShell turns pane `index` into a shell pane, and is a no-op at index 0 (FR-9/FR-8)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session' });
    useStore.getState().openInNewPane('s2');
    useStore.getState().convertPaneToShell(1, 'p1');
    expect(useStore.getState().extraPanes).toEqual([shellPane('p1')]);

    useStore.getState().convertPaneToShell(0, 'p1');
    expect(useStore.getState().activeSessionId).toBe('s1'); // untouched
  });

  it('setPaneShellId records the runtime shellId WITHOUT persisting it (FR-7/FR-17)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session' });
    useStore.getState().openShellPane('p1');
    useStore.getState().setPaneShellId(1, 'sh-1');
    expect(useStore.getState().extraPanes).toEqual([shellPane('p1', 'sh-1')]);
    expect(readSplit()).toEqual({ extraPanes: [{ kind: 'shell', projectId: 'p1' }], focusedPaneIndex: 1 });
  });

  it('closePane(0) with a session pane among the extras promotes it, not simply pane 1 (FR-8)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session' });
    useStore.getState().openShellPane('p1');
    useStore.getState().openInNewPane('s2'); // p1 | s2
    useStore.getState().closePane(0);
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s2'); // promoted, skipping the shell pane
    expect(s.extraPanes).toEqual([shellPane('p1')]); // the shell pane keeps its slot
  });

  it('closePane(0) with ONLY shell panes left clears pane 0 instead (edge case 6)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().openShellPane('p1');
    useStore.getState().closePane(0);
    const s = useStore.getState();
    expect(s.activeSessionId).toBeNull();
    expect(s.mainTab).toBe('session');
    expect(s.extraPanes).toEqual([shellPane('p1')]); // unchanged — nothing removed
  });

  it('closing (or converting away) a shell pane disposes its shell (FR-10)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session' });
    useStore.getState().openShellPane('p1');
    useStore.getState().setPaneShellId(1, 'sh-1');
    useStore.getState().closePane(1);
    expect(invokeMock).toHaveBeenCalledWith('shell_dispose', { shellId: 'sh-1' });
  });

  it('assigning a session onto a shell pane disposes it (FR-10)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', focusedPaneIndex: 0 });
    useStore.getState().openShellPane('p1');
    useStore.getState().setPaneShellId(1, 'sh-2');
    useStore.getState().setFocusedPaneIndex(1);
    useStore.getState().assignToFocusedPane('s9');
    expect(useStore.getState().extraPanes).toEqual([sessionPane('s9')]);
    expect(invokeMock).toHaveBeenCalledWith('shell_dispose', { shellId: 'sh-2' });
  });

  it('unsplit disposes every shell pane it drops (FR-10)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session' });
    useStore.getState().openShellPane('p1');
    useStore.getState().setPaneShellId(1, 'sh-3');
    useStore.getState().unsplit(0);
    expect(invokeMock).toHaveBeenCalledWith('shell_dispose', { shellId: 'sh-3' });
    expect(useStore.getState().extraPanes).toEqual([]);
  });

  it('unsplit(index) promoting a SHELL-kind pane into slot 0 coerces it to an empty session pane (FR-4/FR-8, index-0 coercion)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().openShellPane('p1'); // extra pane 1 is now a shell pane
    useStore.getState().setPaneShellId(1, 'sh-4');
    useStore.getState().unsplit(1); // promote the shell pane into slot 0
    const s = useStore.getState();
    expect(invokeMock).toHaveBeenCalledWith('shell_dispose', { shellId: 'sh-4' });
    expect(s.extraPanes).toEqual([]);
    expect(s.activeSessionId).toBeNull();
    expect(s.mainTab).toBe('session');
  });
});
