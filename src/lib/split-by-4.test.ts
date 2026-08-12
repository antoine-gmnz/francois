// split-by-4: the pane list — the pure selectors (paneCount/layoutRegime/
// clampPaneIndex/paneIndexOf/focusedSessionId/focusedTab/visibleSessionIds/
// isShellVisible/splitCandidates/clampToPaneTab), parseSplitState's
// normalization INCLUDING the legacy split-session record (FR-23), and the
// store slice's count changes (FR-15..FR-19) with their localStorage round-trip.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../contract/common';
import {
  clampPaneIndex,
  clampToPaneTab,
  focusedSessionId,
  focusedTab,
  isShellVisible,
  layoutModeState,
  layoutRegime,
  MAX_PANES,
  paneCount,
  paneIndexOf,
  paneSessionIdAt,
  paneTabAt,
  panesWithout,
  parseSplitState,
  splitCandidate,
  splitCandidates,
  SPLIT_STORAGE_KEY,
  visibleSessionIds,
  type PaneSlot,
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

function meta(id: string, lastActivityAt: number, status: SessionMeta['status'] = 'idle'): SessionMeta {
  return { id, lastActivityAt, status } as unknown as SessionMeta;
}

/** The minimum a pane reader needs — cast at the call sites, not here. */
function panes(activeSessionId: string | null, mainTab: string, extraPanes: PaneSlot[]) {
  return { activeSessionId, mainTab, extraPanes } as unknown as Parameters<typeof visibleSessionIds>[0];
}

// ── pure selectors ──────────────────────────────────────────────────────────

describe('layoutRegime (FR-3)', () => {
  it('maps the pane count to the two chromes', () => {
    expect(layoutRegime(0)).toBe('single'); // defensive: never reached
    expect(layoutRegime(1)).toBe('single');
    expect(layoutRegime(2)).toBe('split');
    expect(layoutRegime(3)).toBe('grid');
    expect(layoutRegime(4)).toBe('grid');
  });
});

describe('layoutModeState — the ▯ / ▯▯ / ⊞ segmented control (FR-15)', () => {
  const at = (panes: number, canSplit = true) => ({
    single: layoutModeState(1, panes, canSplit),
    split: layoutModeState(2, panes, canSplit),
    grid: layoutModeState(MAX_PANES, panes, canSplit),
  });

  it('lights exactly one button per layout, ⊞ across the whole grid range', () => {
    expect([at(1).single.on, at(1).split.on, at(1).grid.on]).toEqual([true, false, false]);
    expect([at(2).single.on, at(2).split.on, at(2).grid.on]).toEqual([false, true, false]);
    expect([at(3).single.on, at(3).split.on, at(3).grid.on]).toEqual([false, false, true]);
    expect([at(4).single.on, at(4).split.on, at(4).grid.on]).toEqual([false, false, true]);
  });

  it('AT THREE PANES every button still does something — ⊞ is lit but a fourth pane is missing', () => {
    expect(at(3).single.actionable).toBe(true); // → 1
    expect(at(3).split.actionable).toBe(true); // → 2
    expect(at(3).grid.actionable).toBe(true); // → 4, even though it reads as pressed
  });

  it('is a no-op only when the target IS the current count', () => {
    expect(at(1).single.actionable).toBe(false);
    expect(at(2).split.actionable).toBe(false);
    expect(at(4).grid.actionable).toBe(false);
    // …and at 3 panes NO button is the current count, so none is inert
    expect(Object.values(at(3)).every((m) => m.actionable)).toBe(true);
  });

  it('gates only ENTERING a split on a splittable scope — never leaving or resizing one', () => {
    expect(at(1, false).split.disabled).toBe(true);
    expect(at(1, false).grid.disabled).toBe(true);
    expect(at(1, false).single.disabled).toBe(false);
    // already split with an unsplittable scope (All projects): still steerable
    expect(at(3, false).split.disabled).toBe(false);
    expect(at(3, false).split.actionable).toBe(true);
    expect(at(3, false).grid.actionable).toBe(true);
    expect(at(3, false).single.actionable).toBe(true);
  });
});

describe('clampPaneIndex (FR-12)', () => {
  it('clamps into 0..count-1', () => {
    expect(clampPaneIndex(3, 2)).toBe(1);
    expect(clampPaneIndex(1, 4)).toBe(1);
    expect(clampPaneIndex(0, 1)).toBe(0);
  });

  it('treats a negative, fractional or non-integer index as 0', () => {
    expect(clampPaneIndex(-1, 4)).toBe(0);
    expect(clampPaneIndex(1.5, 4)).toBe(0);
    expect(clampPaneIndex(NaN, 4)).toBe(0);
  });
});

describe('paneCount / paneSessionIdAt / paneTabAt / paneIndexOf (FR-1)', () => {
  const s = panes('s1', 'diff', [
    { sessionId: 's2', tab: 'shell' },
    { sessionId: 's3', tab: 'session' },
  ]);

  it('counts pane 0 plus the extras', () => {
    expect(paneCount({ extraPanes: [] } as never)).toBe(1);
    expect(paneCount(s)).toBe(3);
  });

  it('reads pane 0 off activeSessionId/mainTab and the rest off extraPanes', () => {
    expect(paneSessionIdAt(s, 0)).toBe('s1');
    expect(paneTabAt(s, 0)).toBe('diff');
    expect(paneSessionIdAt(s, 2)).toBe('s3');
    expect(paneTabAt(s, 1)).toBe('shell');
  });

  it('clamps pane 0 out of a tab a pane cannot show', () => {
    expect(paneTabAt(panes('s1', 'overview', []), 0)).toBe('session');
    // design 7a: the four dissolved panels overlay the whole cell, so they are
    // not a pane's view either.
    expect(paneTabAt(panes('s1', 'agents', []), 0)).toBe('session');
  });

  it('KEEPS a dynamic tab below the grid, and flattens it inside it (fix-agent-view FR-3/FR-13)', () => {
    // single + split: `agent:<id>` is a PaneTab now, so the pane really shows it
    expect(paneTabAt(panes('s1', 'agent:a1', []), 0)).toBe('agent:a1');
    expect(paneTabAt(panes('s1', 'agent:a1', [{ sessionId: 's2', tab: 'diff' }]), 0)).toBe('agent:a1');
    // grid: a dense pane has no strip to hang the chip on, so it reads as session
    const grid = panes('s1', 'agent:a1', [
      { sessionId: 's2', tab: 'workflow:w1' },
      { sessionId: 's3', tab: 'diff' },
    ]);
    expect(paneTabAt(grid, 0)).toBe('session');
    expect(paneTabAt(grid, 1)).toBe('session');
    expect(paneTabAt(grid, 2)).toBe('diff'); // built-ins are untouched
  });

  it('answers null for an out-of-range pane', () => {
    expect(paneSessionIdAt(s, 9)).toBeNull();
    expect(paneTabAt(s, 9)).toBe('session');
  });

  it('locates a session by pane, or null when no pane shows it', () => {
    expect(paneIndexOf(s, 's1')).toBe(0);
    expect(paneIndexOf(s, 's3')).toBe(2);
    expect(paneIndexOf(s, 'nope')).toBeNull();
  });
});

describe('focusedSessionId / focusedTab (FR-13)', () => {
  const s = panes('s1', 'diff', [
    { sessionId: 's2', tab: 'shell' },
    { sessionId: 's3', tab: 'session' },
  ]);

  it('is the focused pane’s session and tab', () => {
    expect(focusedSessionId({ ...s, focusedPaneIndex: 0 })).toBe('s1');
    expect(focusedSessionId({ ...s, focusedPaneIndex: 2 })).toBe('s3');
    expect(focusedTab({ ...s, focusedPaneIndex: 1 })).toBe('shell');
  });

  it('equals activeSessionId when not split, so every consumer is unchanged', () => {
    const single = panes('s1', 'overview', []);
    expect(focusedSessionId({ ...single, focusedPaneIndex: 0 })).toBe('s1');
    // pane 0 answers with the RAW mainTab, so `o` still toggles OVERVIEW
    expect(focusedTab({ ...single, focusedPaneIndex: 0 })).toBe('overview');
  });

  it('clamps a stale focused index rather than reading past the list', () => {
    expect(focusedSessionId({ ...s, focusedPaneIndex: 7 })).toBe('s3');
  });
});

describe('visibleSessionIds (FR-26)', () => {
  it('lists every pane’s session once', () => {
    expect(
      visibleSessionIds(panes('s1', 'session', [{ sessionId: 's2', tab: 'session' }, { sessionId: 's3', tab: 'diff' }])),
    ).toEqual(['s1', 's2', 's3']);
  });

  it('is just the active session when not split', () => {
    expect(visibleSessionIds(panes('s1', 'session', []))).toEqual(['s1']);
    expect(visibleSessionIds(panes(null, 'session', []))).toEqual([]);
  });
});

describe('isShellVisible (FR-25)', () => {
  it('is true for pane 0 on SHELL, whatever the other panes show', () => {
    expect(isShellVisible(panes('s1', 'shell', [{ sessionId: 's2', tab: 'diff' }]), 's1')).toBe(true);
    expect(isShellVisible(panes('s1', 'diff', [{ sessionId: 's2', tab: 'diff' }]), 's1')).toBe(false);
  });

  it('is true for ANY pane on SHELL — not just the focused one', () => {
    const s = panes('s1', 'session', [{ sessionId: 's2', tab: 'shell' }]);
    expect(isShellVisible(s, 's2')).toBe(true);
    expect(isShellVisible(s, 's1')).toBe(false);
  });

  it('is false throughout the grid chrome — no pane there renders a shell (FR-9)', () => {
    const s = panes('s1', 'shell', [
      { sessionId: 's2', tab: 'shell' },
      { sessionId: 's3', tab: 'shell' },
    ]);
    expect(isShellVisible(s, 's1')).toBe(false);
    expect(isShellVisible(s, 's3')).toBe(false);
  });
});

describe('splitCandidates / splitCandidate (FR-15)', () => {
  const list = [meta('a', 10), meta('b', 50), meta('c', 30), meta('d', 40)];

  it('returns the n most recently active sessions no pane holds', () => {
    expect(splitCandidates(list, ['b'], 2).map((m) => m.id)).toEqual(['d', 'c']);
    expect(splitCandidates(list, [], 3).map((m) => m.id)).toEqual(['b', 'd', 'c']);
  });

  it('returns fewer than n rather than padding, and nothing for n <= 0', () => {
    expect(splitCandidates(list, ['a', 'b', 'c'], 3).map((m) => m.id)).toEqual(['d']);
    expect(splitCandidates(list, [], 0)).toEqual([]);
  });

  it('does not mutate the input order', () => {
    const copy = list.slice();
    splitCandidates(list, [], 4);
    expect(list).toEqual(copy);
  });

  it('splitCandidate is the single-slot case', () => {
    expect(splitCandidate(list, 'b')?.id).toBe('d');
    expect(splitCandidate([meta('a', 1)], 'a')).toBeNull();
    expect(splitCandidate([], null)).toBeNull();
  });
});

describe('clampToPaneTab (FR-20)', () => {
  it('keeps the three tabs a pane can show', () => {
    expect(clampToPaneTab('session')).toBe('session');
    expect(clampToPaneTab('diff')).toBe('diff');
    expect(clampToPaneTab('shell')).toBe('shell');
  });

  it('clamps overview and the dissolved panel tabs to session', () => {
    expect(clampToPaneTab('overview')).toBe('session');
    for (const panel of ['agents', 'mcp', 'skills', 'workflows'] as const) {
      expect(clampToPaneTab(panel)).toBe('session');
    }
  });

  it('passes the dynamic tabs through — they are PaneTab members (fix-agent-view FR-3)', () => {
    expect(clampToPaneTab('agent:a1')).toBe('agent:a1');
    expect(clampToPaneTab('workflow:run-1')).toBe('workflow:run-1');
  });
});

describe('panesWithout (FR-27)', () => {
  it('drops every pane on that session', () => {
    const list: PaneSlot[] = [
      { sessionId: 's2', tab: 'session' },
      { sessionId: 's3', tab: 'diff' },
    ];
    expect(panesWithout(list, 's2')).toEqual([{ sessionId: 's3', tab: 'diff' }]);
    expect(panesWithout(list, 'nope')).toHaveLength(2);
  });
});

// ── persistence ─────────────────────────────────────────────────────────────

describe('parseSplitState (FR-23)', () => {
  const NOT_SPLIT = { extraPanes: [], focusedPaneIndex: 0 };

  it('defaults to not-split for null input and malformed JSON', () => {
    expect(parseSplitState(null)).toEqual(NOT_SPLIT);
    expect(parseSplitState('{oops')).toEqual(NOT_SPLIT);
  });

  it('defaults to not-split for a non-object value (array, number, string, null)', () => {
    expect(parseSplitState('[1,2]')).toEqual(NOT_SPLIT);
    expect(parseSplitState('42')).toEqual(NOT_SPLIT);
    expect(parseSplitState('"hi"')).toEqual(NOT_SPLIT);
    expect(parseSplitState('null')).toEqual(NOT_SPLIT);
  });

  it('degrades a record with no usable panes to not-split', () => {
    expect(parseSplitState(JSON.stringify({ focusedPaneIndex: 2 }))).toEqual(NOT_SPLIT);
    expect(parseSplitState(JSON.stringify({ extraPanes: [] }))).toEqual(NOT_SPLIT);
    expect(parseSplitState(JSON.stringify({ extraPanes: [{ sessionId: 7 }, null, 'x'] }))).toEqual(NOT_SPLIT);
  });

  it('defaults an unknown tab and clamps the focused index rather than trusting them', () => {
    expect(
      parseSplitState(JSON.stringify({ extraPanes: [{ sessionId: 's2', tab: 'overview' }], focusedPaneIndex: 9 })),
    ).toEqual({ extraPanes: [{ sessionId: 's2', tab: 'session' }], focusedPaneIndex: 1 });
  });

  it('drops a duplicate pane — a session is never shown twice (FR-19)', () => {
    expect(
      parseSplitState(
        JSON.stringify({ extraPanes: [{ sessionId: 's2', tab: 'diff' }, { sessionId: 's2', tab: 'shell' }] }),
      ).extraPanes,
    ).toEqual([{ sessionId: 's2', tab: 'diff' }]);
  });

  it('caps the list at MAX_PANES - 1 extras', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ sessionId: `s${i}`, tab: 'session' }));
    expect(parseSplitState(JSON.stringify({ extraPanes: many })).extraPanes).toHaveLength(MAX_PANES - 1);
  });

  it('round-trips a fully valid record', () => {
    const rec = {
      extraPanes: [
        { sessionId: 's2', tab: 'shell' },
        { sessionId: 's3', tab: 'diff' },
      ],
      focusedPaneIndex: 2,
    };
    expect(parseSplitState(JSON.stringify(rec))).toEqual(rec);
  });

  it('reads a LEGACY split-session record as one extra pane', () => {
    expect(parseSplitState(JSON.stringify({ splitSessionId: 's2', splitTab: 'diff', focusedSide: 'right' }))).toEqual({
      extraPanes: [{ sessionId: 's2', tab: 'diff' }],
      focusedPaneIndex: 1,
    });
    expect(parseSplitState(JSON.stringify({ splitSessionId: 's2', splitTab: 'nope', focusedSide: 'left' }))).toEqual({
      extraPanes: [{ sessionId: 's2', tab: 'session' }],
      focusedPaneIndex: 0,
    });
  });

  it('degrades a legacy not-split record to not-split', () => {
    expect(parseSplitState(JSON.stringify({ splitSessionId: null, splitTab: 'diff', focusedSide: 'left' }))).toEqual(
      NOT_SPLIT,
    );
  });
});

// ── store slice ─────────────────────────────────────────────────────────────

describe('pane store slice', () => {
  let storage: { store: Record<string, string> };

  beforeEach(() => {
    storage = mockStorage();
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
    expect(useStore.getState().extraPanes).toEqual([{ sessionId: 's2', tab: 'diff' }]);
    expect(useStore.getState().focusedPaneIndex).toBe(1);
  });

  it('openInNewPane appends, focuses it, and folds the right column without persisting (FR-5/FR-18)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff', focusedPane: 'sidebar' });
    useStore.getState().openInNewPane('s2');
    const s = useStore.getState();
    expect(s.extraPanes).toEqual([{ sessionId: 's2', tab: 'session' }]);
    expect(s.focusedPaneIndex).toBe(1);
    expect(s.focusedPane).toBe('main');
    expect(s.activeSessionId).toBe('s1');
    expect(s.mainTab).toBe('diff'); // pane 0 keeps its tab
    expect(s.showRightPane).toBe(false);
    expect(storage.store['francois.showRightPane']).toBeUndefined(); // FR-5: not persisted
    expect(readSplit()).toEqual({ extraPanes: [{ sessionId: 's2', tab: 'session' }], focusedPaneIndex: 1 });
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
    // the tab belongs to s1, which is still pane 0's session — entering split
    // has no reason to close it (supersedes split-by-4 FR-20's second half).
    expect(useStore.getState().mainTab).toBe('agent:a1');
    expect(useStore.getState().agentTabs.get('s1')).toHaveLength(1);
  });

  it('openInNewPane FOCUSES a session already on screen rather than duplicating it (FR-19)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session' });
    useStore.getState().openInNewPane('s2');
    useStore.getState().setPaneTab(1, 'diff');
    useStore.getState().setFocusedPaneIndex(0);

    useStore.getState().openInNewPane('s2');
    expect(useStore.getState().extraPanes).toEqual([{ sessionId: 's2', tab: 'diff' }]); // tab preserved
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

  it('setPaneCount grows with the most recently active in-scope sessions, folding both columns in the grid (FR-4/FR-15)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: FLEET, activeProjectId: null });
    useStore.getState().setPaneCount(4);
    const s = useStore.getState();
    expect(s.extraPanes.map((p) => p.sessionId)).toEqual(['s2', 's3', 's4']);
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
    // pane 0 is kept as the lowest index; the focused pane is the other survivor
    expect(s.activeSessionId).toBe('s1');
    expect(s.extraPanes.map((p) => p.sessionId)).toEqual(['s3']);
    expect(s.focusedPaneIndex).toBe(1);
    expect(s.showLeftPane).toBe(true); // the grid's fold is undone
    expect(s.showRightPane).toBe(false); // two panes still fold the right column
  });

  // The reported bug: at three panes the control changed nothing. The store was
  // never at fault — `⊞` read as pressed and the button treated "pressed" as
  // "already there", and `disabled` still gated on a splittable scope while
  // ALREADY split. Both live in layoutModeState now; this pins the store half.
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
    expect(useStore.getState().extraPanes.map((p) => p.sessionId)).toEqual(['s2', null, null]);
  });

  it('a ONE-session project still splits — the second pane is simply empty (FR-15)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: [meta('s1', 1)], activeProjectId: null });
    useStore.getState().setPaneCount(2);
    expect(useStore.getState().extraPanes).toEqual([{ sessionId: null, tab: 'session' }]);
    expect(useStore.getState().showRightPane).toBe(false);
    expect(readSplit().extraPanes).toEqual([{ sessionId: null, tab: 'session' }]);
  });

  it('openInNewPane FILLS the first empty pane rather than opening another beside it', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: [meta('s1', 1)], activeProjectId: null });
    useStore.getState().setPaneCount(4); // s1 | ∅ ∅ ∅
    useStore.getState().openInNewPane('s9');
    const s = useStore.getState();
    expect(s.extraPanes.map((p) => p.sessionId)).toEqual(['s9', null, null]);
    expect(s.focusedPaneIndex).toBe(1);
  });

  it('assignToFocusedPane fills an empty focused pane', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: [meta('s1', 1)], activeProjectId: null });
    useStore.getState().setPaneCount(2);
    useStore.getState().setFocusedPaneIndex(1);
    useStore.getState().assignToFocusedPane('s9');
    expect(useStore.getState().extraPanes).toEqual([{ sessionId: 's9', tab: 'session' }]);
  });

  it('keeps an empty pane through a shrink and a close — it is a layout, not a leftover', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: [meta('s1', 1), meta('s2', 2)], activeProjectId: null });
    useStore.getState().setPaneCount(4); // s1 | s2 ∅ ∅
    useStore.getState().setPaneCount(2);
    expect(useStore.getState().extraPanes.map((p) => p.sessionId)).toEqual(['s2']);

    useStore.getState().setPaneCount(4); // s1 | s2 ∅ ∅ again
    useStore.getState().closePane(1); // drop s2
    expect(useStore.getState().extraPanes.map((p) => p.sessionId)).toEqual([null, null]);
  });

  it('parseSplitState round-trips an empty pane, and allows several (FR-15/FR-23)', () => {
    const rec = {
      extraPanes: [
        { sessionId: null, tab: 'session' },
        { sessionId: null, tab: 'session' },
      ],
      focusedPaneIndex: 1,
    };
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
    expect(s.extraPanes.map((p) => p.sessionId)).toEqual(['s2', 's4']);
    expect(s.focusedPaneIndex).toBe(2); // s4 slid into the slot

    // closing pane 0 shifts pane 1 into it
    useStore.getState().closePane(0);
    s = useStore.getState();
    expect(s.activeSessionId).toBe('s2');
    expect(s.extraPanes.map((p) => p.sessionId)).toEqual(['s4']);

    // the last close leaves a single pane
    useStore.getState().closePane(1);
    s = useStore.getState();
    expect(s.extraPanes).toEqual([]);
    expect(s.activeSessionId).toBe('s2');
    expect(s.showLeftPane).toBe(true);
  });

  it('assignToFocusedPane replaces the focused pane, and swaps when the session is elsewhere (FR-19)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff', sessions: FLEET, activeProjectId: null });
    useStore.getState().setPaneCount(2); // s1 | s2
    useStore.getState().setFocusedPaneIndex(1);

    useStore.getState().assignToFocusedPane('s5');
    expect(useStore.getState().extraPanes).toEqual([{ sessionId: 's5', tab: 'session' }]);

    // assigning pane 0's session to the focused pane swaps the two
    useStore.getState().assignToFocusedPane('s1');
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s5');
    expect(s.mainTab).toBe('session');
    expect(s.extraPanes).toEqual([{ sessionId: 's1', tab: 'diff' }]);
  });

  it('assignToFocusedPane is a no-op at pane 0 — setActiveSessionId owns that path', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session' });
    useStore.getState().openInNewPane('s2');
    useStore.getState().setFocusedPaneIndex(0);
    useStore.getState().assignToFocusedPane('s5');
    expect(useStore.getState().activeSessionId).toBe('s1');
    expect(useStore.getState().extraPanes).toEqual([{ sessionId: 's2', tab: 'session' }]);
  });

  it('setActiveSessionId SWAPS rather than showing a session twice (FR-19)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff', sessions: FLEET, activeProjectId: null });
    useStore.getState().openInNewPane('s2');
    useStore.getState().setPaneTab(1, 'shell');
    useStore.getState().setActiveSessionId('s2');
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s2');
    expect(s.mainTab).toBe('shell');
    expect(s.extraPanes).toEqual([{ sessionId: 's1', tab: 'diff' }]);
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
    expect(s.extraPanes.map((p) => p.sessionId)).toEqual(['s2', 's4']);
    expect(s.focusedPaneIndex).toBe(2);
    expect(readSplit().extraPanes).toHaveLength(2);
  });

  it('removeSession leaves the panes alone when the session was not in one', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: FLEET, activeProjectId: null });
    useStore.getState().openInNewPane('s2');
    useStore.getState().removeSession('s5');
    expect(useStore.getState().extraPanes).toEqual([{ sessionId: 's2', tab: 'session' }]);
  });

  it('reassignActiveSessionId drops the duplicate pane when the fallback lands on a paned session (FR-27)', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1', mainTab: 'session', sessions: FLEET, activeProjectId: null });
    useStore.getState().setPaneCount(4); // s1 | s2 s3 s4
    useStore.getState().reassignActiveSessionId('s3');
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s3');
    expect(s.extraPanes.map((p) => p.sessionId)).toEqual(['s2', 's4']);
  });
});
