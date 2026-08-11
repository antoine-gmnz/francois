// collapse-right-column: covers the collapsedPanes slice — parseCollapsedPanes
// (FR-4 malformed-input normalization), toggle/set + localStorage round-trip
// (FR-1/2/3), and the focus invariants (FR-5 collapsing the focused pane hands
// focus to main; FR-6 focusing a collapsed right pane expands it).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../contract/common';
import {
  clampToPaneTab,
  COLLAPSED_PANES_STORAGE_KEY,
  focusedSessionId,
  focusedTab,
  isShellVisible,
  parseCollapsedPanes,
  parseSplitState,
  SESSION_META_KEY,
  splitCandidate,
  SPLIT_STORAGE_KEY,
  visibleSessionIds,
} from './layoutStore';

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

async function freshStore() {
  vi.resetModules();
  const mod = await import('./store');
  return mod.useStore;
}

describe('parseCollapsedPanes (FR-4)', () => {
  it('defaults to all-expanded for null input', () => {
    expect(parseCollapsedPanes(null)).toEqual({ agents: false, mcp: false, skills: false });
  });

  it('defaults to all-expanded for malformed JSON', () => {
    expect(parseCollapsedPanes('not json')).toEqual({ agents: false, mcp: false, skills: false });
  });

  it('defaults to all-expanded for a non-object value (array, number, string)', () => {
    expect(parseCollapsedPanes('[1,2,3]')).toEqual({ agents: false, mcp: false, skills: false });
    expect(parseCollapsedPanes('42')).toEqual({ agents: false, mcp: false, skills: false });
    expect(parseCollapsedPanes('"hi"')).toEqual({ agents: false, mcp: false, skills: false });
    expect(parseCollapsedPanes('null')).toEqual({ agents: false, mcp: false, skills: false });
  });

  it('drops unknown keys and defaults missing keys to false', () => {
    expect(parseCollapsedPanes(JSON.stringify({ mcp: true, bogus: true }))).toEqual({
      agents: false,
      mcp: true,
      skills: false,
    });
  });

  it('defaults non-boolean values to false', () => {
    expect(parseCollapsedPanes(JSON.stringify({ agents: 'yes', mcp: 1, skills: null }))).toEqual({
      agents: false,
      mcp: false,
      skills: false,
    });
  });

  it('round-trips a fully valid record', () => {
    expect(parseCollapsedPanes(JSON.stringify({ agents: true, mcp: false, skills: true }))).toEqual({
      agents: true,
      mcp: false,
      skills: true,
    });
  });
});

describe('collapsedPanes store slice', () => {
  let storage: { store: Record<string, string> };

  beforeEach(() => {
    storage = mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to all-expanded when storage is empty', async () => {
    const useStore = await freshStore();
    expect(useStore.getState().collapsedPanes).toEqual({ agents: false, mcp: false, skills: false });
  });

  it('initializes from a persisted record', async () => {
    storage.store[COLLAPSED_PANES_STORAGE_KEY] = JSON.stringify({ agents: false, mcp: true, skills: true });
    const useStore = await freshStore();
    expect(useStore.getState().collapsedPanes).toEqual({ agents: false, mcp: true, skills: true });
  });

  it('toggleCollapsedPane flips one entry and persists the whole record (FR-2/FR-3)', async () => {
    const useStore = await freshStore();
    useStore.getState().toggleCollapsedPane('mcp');
    expect(useStore.getState().collapsedPanes).toEqual({ agents: false, mcp: true, skills: false });
    expect(JSON.parse(storage.store[COLLAPSED_PANES_STORAGE_KEY])).toEqual({ agents: false, mcp: true, skills: false });
    useStore.getState().toggleCollapsedPane('mcp');
    expect(useStore.getState().collapsedPanes.mcp).toBe(false);
  });

  it('setCollapsedPane sets explicitly and persists', async () => {
    const useStore = await freshStore();
    useStore.getState().setCollapsedPane('skills', true);
    expect(useStore.getState().collapsedPanes.skills).toBe(true);
    expect(JSON.parse(storage.store[COLLAPSED_PANES_STORAGE_KEY]).skills).toBe(true);
    useStore.getState().setCollapsedPane('skills', false);
    expect(useStore.getState().collapsedPanes.skills).toBe(false);
  });

  it('FR-5: collapsing the focused pane hands focus to main', async () => {
    const useStore = await freshStore();
    useStore.getState().setFocusedPane('mcp');
    expect(useStore.getState().focusedPane).toBe('mcp');
    useStore.getState().toggleCollapsedPane('mcp');
    expect(useStore.getState().focusedPane).toBe('main');
  });

  it('FR-5: setCollapsedPane collapsing the focused pane also hands focus to main', async () => {
    const useStore = await freshStore();
    useStore.getState().setFocusedPane('skills');
    useStore.getState().setCollapsedPane('skills', true);
    expect(useStore.getState().focusedPane).toBe('main');
  });

  it('FR-5: collapsing a pane that does not own focus leaves focusedPane untouched', async () => {
    const useStore = await freshStore();
    useStore.getState().setFocusedPane('agents');
    useStore.getState().toggleCollapsedPane('mcp');
    expect(useStore.getState().focusedPane).toBe('agents');
  });

  it('FR-6: setFocusedPane on a collapsed right pane expands it and persists', async () => {
    const useStore = await freshStore();
    useStore.getState().setCollapsedPane('agents', true);
    expect(useStore.getState().collapsedPanes.agents).toBe(true);
    useStore.getState().setFocusedPane('agents');
    expect(useStore.getState().focusedPane).toBe('agents');
    expect(useStore.getState().collapsedPanes.agents).toBe(false);
    expect(JSON.parse(storage.store[COLLAPSED_PANES_STORAGE_KEY]).agents).toBe(false);
  });

  it('FR-6: setFocusedPane on an already-expanded pane is a no-op on collapsedPanes', async () => {
    const useStore = await freshStore();
    useStore.getState().setFocusedPane('skills');
    expect(useStore.getState().collapsedPanes).toEqual({ agents: false, mcp: false, skills: false });
  });

  it('FR-7: toggleRightPane never mutates collapsedPanes', async () => {
    const useStore = await freshStore();
    useStore.getState().setCollapsedPane('mcp', true);
    useStore.getState().toggleRightPane(); // hide the column
    expect(useStore.getState().collapsedPanes.mcp).toBe(true);
    useStore.getState().toggleRightPane(); // show it again
    expect(useStore.getState().collapsedPanes.mcp).toBe(true);
  });

  it('showSessionMeta defaults to visible, toggles, and persists', async () => {
    const useStore = await freshStore();
    expect(useStore.getState().showSessionMeta).toBe(true);
    useStore.getState().toggleSessionMeta();
    expect(useStore.getState().showSessionMeta).toBe(false);
    expect(storage.store[SESSION_META_KEY]).toBe('0');
    useStore.getState().toggleSessionMeta();
    expect(useStore.getState().showSessionMeta).toBe(true);
    expect(storage.store[SESSION_META_KEY]).toBe('1');
  });

  it('showSessionMeta initializes from a persisted collapse', async () => {
    storage.store[SESSION_META_KEY] = '0';
    const useStore = await freshStore();
    expect(useStore.getState().showSessionMeta).toBe(false);
  });

  it('toggleSessionMeta touches no other layout state', async () => {
    const useStore = await freshStore();
    useStore.getState().setFocusedPane('mcp');
    useStore.getState().setCollapsedPane('agents', true);
    useStore.getState().toggleSessionMeta();
    expect(useStore.getState().focusedPane).toBe('mcp');
    expect(useStore.getState().collapsedPanes.agents).toBe(true);
    expect(useStore.getState().showLeftPane).toBe(true);
    expect(useStore.getState().showRightPane).toBe(true);
  });

  it('degrades silently to all-expanded when localStorage throws (FR-3)', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const useStore = await freshStore();
    expect(useStore.getState().collapsedPanes).toEqual({ agents: false, mcp: false, skills: false });
    // toggles still work for the session even though persistence is impossible
    expect(() => useStore.getState().toggleCollapsedPane('agents')).not.toThrow();
    expect(useStore.getState().collapsedPanes.agents).toBe(true);
  });
});

// ── split-session ───────────────────────────────────────────────────────────

describe('parseSplitState (FR-16)', () => {
  const NOT_SPLIT = { splitSessionId: null, splitTab: 'session', focusedSide: 'left' };

  it('defaults to not-split for null input', () => {
    expect(parseSplitState(null)).toEqual(NOT_SPLIT);
  });

  it('defaults to not-split for malformed JSON', () => {
    expect(parseSplitState('{oops')).toEqual(NOT_SPLIT);
  });

  it('defaults to not-split for a non-object value (array, number, string, null)', () => {
    expect(parseSplitState('[1,2]')).toEqual(NOT_SPLIT);
    expect(parseSplitState('42')).toEqual(NOT_SPLIT);
    expect(parseSplitState('"hi"')).toEqual(NOT_SPLIT);
    expect(parseSplitState('null')).toEqual(NOT_SPLIT);
  });

  it('degrades a record with no usable splitSessionId to not-split', () => {
    expect(parseSplitState(JSON.stringify({ splitTab: 'diff', focusedSide: 'right' }))).toEqual(NOT_SPLIT);
    expect(parseSplitState(JSON.stringify({ splitSessionId: 7, focusedSide: 'right' }))).toEqual(NOT_SPLIT);
    expect(parseSplitState(JSON.stringify({ splitSessionId: '' }))).toEqual(NOT_SPLIT);
  });

  it('defaults an unknown splitTab / focusedSide rather than trusting it', () => {
    expect(parseSplitState(JSON.stringify({ splitSessionId: 's2', splitTab: 'overview', focusedSide: 'up' }))).toEqual({
      splitSessionId: 's2',
      splitTab: 'session',
      focusedSide: 'left',
    });
  });

  it('round-trips a fully valid record', () => {
    expect(parseSplitState(JSON.stringify({ splitSessionId: 's2', splitTab: 'shell', focusedSide: 'right' }))).toEqual({
      splitSessionId: 's2',
      splitTab: 'shell',
      focusedSide: 'right',
    });
  });
});

describe('clampToPaneTab (FR-13)', () => {
  it('keeps the three tabs a split pane can show', () => {
    expect(clampToPaneTab('session')).toBe('session');
    expect(clampToPaneTab('diff')).toBe('diff');
    expect(clampToPaneTab('shell')).toBe('shell');
  });

  it('clamps overview and the dynamic tabs to session', () => {
    expect(clampToPaneTab('overview')).toBe('session');
    expect(clampToPaneTab('agent:abc')).toBe('session');
    expect(clampToPaneTab('workflow:run-1')).toBe('session');
  });
});

function meta(id: string, lastActivityAt: number): SessionMeta {
  return { id, lastActivityAt } as unknown as SessionMeta;
}

describe('splitCandidate (FR-9/FR-10)', () => {
  it('picks the most recently active session other than the excluded one', () => {
    const list = [meta('a', 10), meta('b', 50), meta('c', 30)];
    expect(splitCandidate(list, 'b')?.id).toBe('c');
    expect(splitCandidate(list, 'a')?.id).toBe('b');
  });

  it('returns null when the excluded session is the only one', () => {
    expect(splitCandidate([meta('a', 1)], 'a')).toBeNull();
  });

  it('returns null for an empty list, and ignores a null exclude', () => {
    expect(splitCandidate([], null)).toBeNull();
    expect(splitCandidate([meta('a', 1), meta('b', 2)], null)?.id).toBe('b');
  });
});

describe('focusedSessionId (FR-7)', () => {
  it('is activeSessionId on the left side', () => {
    expect(focusedSessionId({ activeSessionId: 's1', splitSessionId: 's2', focusedSide: 'left' })).toBe('s1');
  });

  it('is splitSessionId on the right side', () => {
    expect(focusedSessionId({ activeSessionId: 's1', splitSessionId: 's2', focusedSide: 'right' })).toBe('s2');
  });

  it('is activeSessionId whenever not split, whatever focusedSide says', () => {
    expect(focusedSessionId({ activeSessionId: 's1', splitSessionId: null, focusedSide: 'right' })).toBe('s1');
    expect(focusedSessionId({ activeSessionId: null, splitSessionId: null, focusedSide: 'left' })).toBeNull();
  });
});

describe('focusedTab', () => {
  it('follows the focused side while split and mainTab otherwise', () => {
    expect(focusedTab({ mainTab: 'diff', splitTab: 'shell', splitSessionId: 's2', focusedSide: 'right' })).toBe('shell');
    expect(focusedTab({ mainTab: 'diff', splitTab: 'shell', splitSessionId: 's2', focusedSide: 'left' })).toBe('diff');
    expect(focusedTab({ mainTab: 'overview', splitTab: 'shell', splitSessionId: null, focusedSide: 'right' })).toBe('overview');
  });
});

describe('visibleSessionIds (FR-19)', () => {
  it('is the single active session when not split', () => {
    expect(visibleSessionIds({ activeSessionId: 's1', splitSessionId: null })).toEqual(['s1']);
    expect(visibleSessionIds({ activeSessionId: null, splitSessionId: null })).toEqual([]);
  });

  it('is both paned sessions while split, deduped', () => {
    expect(visibleSessionIds({ activeSessionId: 's1', splitSessionId: 's2' })).toEqual(['s1', 's2']);
    expect(visibleSessionIds({ activeSessionId: 's1', splitSessionId: 's1' })).toEqual(['s1']);
    expect(visibleSessionIds({ activeSessionId: null, splitSessionId: 's2' })).toEqual(['s2']);
  });
});

describe('isShellVisible (FR-18)', () => {
  it('tests the left pane', () => {
    const s = { activeSessionId: 's1', mainTab: 'shell' as const, splitSessionId: null, splitTab: 'session' as const };
    expect(isShellVisible(s, 's1')).toBe(true);
    expect(isShellVisible(s, 's2')).toBe(false);
    expect(isShellVisible({ ...s, mainTab: 'diff' as const }, 's1')).toBe(false);
  });

  it('tests the RIGHT pane too — a shell stays visible whichever side is on SHELL', () => {
    const s = { activeSessionId: 's1', mainTab: 'session' as const, splitSessionId: 's2', splitTab: 'shell' as const };
    expect(isShellVisible(s, 's2')).toBe(true);
    expect(isShellVisible(s, 's1')).toBe(false);
    expect(isShellVisible({ ...s, splitTab: 'diff' as const }, 's2')).toBe(false);
  });

  it('is true for both sessions when both panes are on SHELL', () => {
    const s = { activeSessionId: 's1', mainTab: 'shell' as const, splitSessionId: 's2', splitTab: 'shell' as const };
    expect(isShellVisible(s, 's1')).toBe(true);
    expect(isShellVisible(s, 's2')).toBe(true);
  });
});

describe('split store slice', () => {
  let storage: { store: Record<string, string> };

  beforeEach(() => {
    storage = mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const readSplit = () => JSON.parse(storage.store[SPLIT_STORAGE_KEY]);

  it('defaults to not-split with an empty storage', async () => {
    const useStore = await freshStore();
    const s = useStore.getState();
    expect(s.splitSessionId).toBeNull();
    expect(s.splitTab).toBe('session');
    expect(s.focusedSide).toBe('left');
  });

  it('hydrates from a persisted record (FR-16)', async () => {
    storage.store[SPLIT_STORAGE_KEY] = JSON.stringify({ splitSessionId: 's2', splitTab: 'diff', focusedSide: 'right' });
    const useStore = await freshStore();
    expect(useStore.getState().splitSessionId).toBe('s2');
    expect(useStore.getState().splitTab).toBe('diff');
    expect(useStore.getState().focusedSide).toBe('right');
  });

  it('openInRightPane splits, focuses right, folds the right column without persisting it (FR-3/FR-5)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff', focusedPane: 'sidebar' });
    useStore.getState().openInRightPane('s2');
    const s = useStore.getState();
    expect(s.splitSessionId).toBe('s2');
    expect(s.splitTab).toBe('session');
    expect(s.focusedSide).toBe('right');
    expect(s.focusedPane).toBe('main');
    expect(s.activeSessionId).toBe('s1');
    expect(s.mainTab).toBe('diff'); // the left pane keeps its tab
    expect(s.showRightPane).toBe(false);
    expect(storage.store['francois.showRightPane']).toBeUndefined(); // FR-3: not persisted
    expect(readSplit()).toEqual({ splitSessionId: 's2', splitTab: 'session', focusedSide: 'right' });
  });

  it('openInRightPane clamps the left pane out of overview and closes dynamic tabs (FR-13)', async () => {
    const useStore = await freshStore();
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'overview',
      agentTabs: [{ kind: 'agent', id: 'a1', name: 'a', status: 'running' }],
    });
    useStore.getState().openInRightPane('s2');
    expect(useStore.getState().mainTab).toBe('session');
    expect(useStore.getState().agentTabs).toEqual([]);
  });

  it('openInRightPane on the LEFT pane’s session swaps the two panes (FR-8)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().openInRightPane('s2');
    useStore.getState().setSplitTab('shell');
    useStore.getState().openInRightPane('s1'); // s1 is the left pane's session
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s2');
    expect(s.splitSessionId).toBe('s1');
    expect(s.mainTab).toBe('shell'); // the right pane's tab moved left
    expect(s.splitTab).toBe('diff'); // and the left pane's tab moved right
  });

  it('openInRightPane is a no-op when not split and the target is already the left pane', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1' });
    useStore.getState().openInRightPane('s1');
    expect(useStore.getState().splitSessionId).toBeNull();
  });

  it('openInRightPane on the session ALREADY in the right pane keeps that pane’s tab (FR-4)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().openInRightPane('s2');
    useStore.getState().setSplitTab('shell');
    useStore.getState().setFocusedSide('left');
    // The roster row of the session the right pane already shows: a focus, not
    // a re-assignment — the left-pane equivalent (setActiveSessionId with the
    // id already active) is a no-op too.
    useStore.getState().openInRightPane('s2');
    const s = useStore.getState();
    expect(s.splitSessionId).toBe('s2');
    expect(s.splitTab).toBe('shell'); // NOT reset to 'session'
    expect(s.activeSessionId).toBe('s1');
    expect(s.mainTab).toBe('diff');
    expect(s.focusedSide).toBe('right'); // it still takes focus (FR-11)
    expect(s.focusedPane).toBe('main');
    expect(readSplit()).toEqual({ splitSessionId: 's2', splitTab: 'shell', focusedSide: 'right' });
  });

  it('openInRightPane on the already-focused right pane changes nothing but the pane focus', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1' });
    useStore.getState().openInRightPane('s2');
    useStore.getState().setSplitTab('diff');
    useStore.getState().toggleRightPane(); // `]` — unfold the column while split
    expect(useStore.getState().showRightPane).toBe(true);
    useStore.getState().setFocusedPane('agents');
    useStore.getState().openInRightPane('s2');
    const s = useStore.getState();
    expect(s.splitTab).toBe('diff');
    expect(s.focusedSide).toBe('right');
    expect(s.focusedPane).toBe('main');
    expect(s.showRightPane).toBe(true); // FR-3: never re-folds a column the user unfolded
  });

  it('setActiveSessionId on the RIGHT pane’s session swaps the panes (FR-8)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().openInRightPane('s2');
    useStore.getState().setActiveSessionId('s2');
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s2');
    expect(s.splitSessionId).toBe('s1');
    expect(s.mainTab).toBe('session'); // the right pane's tab
    expect(s.splitTab).toBe('diff'); // the left pane's tab
  });

  it('unsplit() promotes the FOCUSED pane by default (FR-10/FR-12)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().openInRightPane('s2');
    useStore.getState().setSplitTab('shell');
    useStore.getState().unsplit(); // focusedSide === 'right'
    const s = useStore.getState();
    expect(s.splitSessionId).toBeNull();
    expect(s.activeSessionId).toBe('s2');
    expect(s.mainTab).toBe('shell');
    expect(s.focusedSide).toBe('left');
    expect(readSplit()).toEqual({ splitSessionId: null, splitTab: 'session', focusedSide: 'left' });
  });

  it('unsplit("left") keeps the left pane and its tab (FR-12)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().openInRightPane('s2');
    useStore.getState().unsplit('left');
    expect(useStore.getState().activeSessionId).toBe('s1');
    expect(useStore.getState().mainTab).toBe('diff');
    expect(useStore.getState().splitSessionId).toBeNull();
  });

  it('unsplit restores the right column to the persisted preference (FR-3)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1' });
    expect(useStore.getState().showRightPane).toBe(true);
    useStore.getState().openInRightPane('s2');
    expect(useStore.getState().showRightPane).toBe(false);
    useStore.getState().unsplit();
    expect(useStore.getState().showRightPane).toBe(true);
  });

  it('unsplit is a no-op when not split', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().unsplit('right');
    expect(useStore.getState().activeSessionId).toBe('s1');
    expect(useStore.getState().mainTab).toBe('diff');
  });

  it('setFocusedSide moves the keyboard and focuses the main pane (FR-5)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', focusedPane: 'agents' });
    useStore.getState().openInRightPane('s2');
    useStore.getState().setFocusedSide('left');
    expect(useStore.getState().focusedSide).toBe('left');
    expect(useStore.getState().focusedPane).toBe('main');
    expect(readSplit().focusedSide).toBe('left');
  });

  it('setSplitTab persists and never touches the left pane (FR-4)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().openInRightPane('s2');
    useStore.getState().setSplitTab('shell');
    expect(useStore.getState().splitTab).toBe('shell');
    expect(useStore.getState().mainTab).toBe('diff');
    expect(readSplit().splitTab).toBe('shell');
  });

  it('FR-13: openAgentTab is a no-op while split', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1' });
    useStore.getState().openInRightPane('s2');
    useStore.getState().openAgentTab({ kind: 'agent', id: 'a1', name: 'agent', status: 'running' });
    expect(useStore.getState().agentTabs).toEqual([]);
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('FR-20: removing the right pane’s session leaves split', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', sessions: [meta('s1', 1), meta('s2', 2)] });
    useStore.getState().openInRightPane('s2');
    useStore.getState().removeSession('s2');
    expect(useStore.getState().splitSessionId).toBeNull();
    expect(useStore.getState().activeSessionId).toBe('s1');
    expect(readSplit().splitSessionId).toBeNull();
    // FR-3: and the right column unfolds again, exactly as unsplit() would
    expect(useStore.getState().showRightPane).toBe(true);
  });

  it('FR-20: removing a session in neither pane leaves split alone', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', sessions: [meta('s1', 1), meta('s2', 2), meta('s3', 3)] });
    useStore.getState().openInRightPane('s2');
    useStore.getState().removeSession('s3');
    expect(useStore.getState().splitSessionId).toBe('s2');
  });

  it('degrades to not-split when localStorage throws (FR-16)', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const useStore = await freshStore();
    expect(useStore.getState().splitSessionId).toBeNull();
    useStore.setState({ activeSessionId: 's1' });
    expect(() => useStore.getState().openInRightPane('s2')).not.toThrow();
    expect(useStore.getState().splitSessionId).toBe('s2');
  });
});

// cloud-sessions FR-14: the "Adopt cloud session" modal is opened from BOTH a
// pane [1] action and a ⌘K command, so its open flag lives in the store like
// every other shared modal's — not inside the sidebar.
describe('adoptCloudOpen (cloud-sessions FR-14)', () => {
  beforeEach(() => {
    mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts closed and is not persisted — a modal is never restored across launches', async () => {
    const useStore = await freshStore();
    expect(useStore.getState().adoptCloudOpen).toBe(false);
  });

  it('opens and closes independently of the new-session modal', async () => {
    const useStore = await freshStore();
    useStore.getState().setAdoptCloudOpen(true);
    expect(useStore.getState().adoptCloudOpen).toBe(true);
    expect(useStore.getState().newSessionOpen).toBe(false);
    useStore.getState().setAdoptCloudOpen(false);
    expect(useStore.getState().adoptCloudOpen).toBe(false);
  });
});
