// split-by-4 / unbound-panes: the pane list — the pure selectors
// (paneCount/layoutRegime/clampPaneIndex/paneIndicesOf/focusedSessionId/
// focusedTab/visibleSessionIds/isShellVisible/splitCandidates/clampToPaneTab/
// promotionTarget/railOrder), parseSplitState's normalization (three
// generations, shell panes, index-0 coercion), and the store slice's count/
// shell-pane changes with their localStorage round-trip.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../contract/common';

// unbound-panes FR-10: closePane/unsplit/assignToFocusedPane can call
// shellDispose on a dropped shell pane — mocked exactly like shellActions.test.ts,
// since this file imports layoutStore.ts directly (not through the app's own
// Tauri bootstrap).
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import {
  canOpenShellPane,
  clampPaneIndex,
  clampToPaneTab,
  focusedSessionId,
  focusedTab,
  initialLastFocusedSessionId,
  isShellVisible,
  layoutModeState,
  layoutRegime,
  MAX_PANES,
  paneCount,
  paneIndicesOf,
  paneSessionIdAt,
  paneTabAt,
  panesWithout,
  panesWithoutStaleProjects,
  parseSplitState,
  projectShellPaneCount,
  shellPaneEligibleProjects,
  promotionTarget,
  railOrder,
  railPinnedCount,
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

function sessionPane(sessionId: string | null, tab = 'session'): PaneSlot {
  return { kind: 'session', sessionId, tab } as PaneSlot;
}

function shellPane(projectId: string, shellId: string | null = null): PaneSlot {
  return { kind: 'shell', projectId, shellId };
}

/** The minimum a pane reader needs — cast at the call sites, not here. */
function panes(activeSessionId: string | null, mainTab: string, extraPanes: PaneSlot[], lastFocusedSessionId: string | null = null) {
  return { activeSessionId, mainTab, extraPanes, lastFocusedSessionId } as unknown as Parameters<typeof visibleSessionIds>[0] &
    Parameters<typeof focusedSessionId>[0];
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
    // already split with an unsplittable scope: still steerable
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

describe('paneCount / paneSessionIdAt / paneTabAt / paneIndicesOf (FR-1, unbound-panes FR-4/FR-5)', () => {
  const s = panes('s1', 'diff', [sessionPane('s2', 'shell'), sessionPane('s3', 'session')]);

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
    expect(paneTabAt(panes('s1', 'agents', []), 0)).toBe('session');
  });

  it('KEEPS a dynamic tab below the grid, and flattens it inside it (fix-agent-view FR-3/FR-13)', () => {
    expect(paneTabAt(panes('s1', 'agent:a1', []), 0)).toBe('agent:a1');
    expect(paneTabAt(panes('s1', 'agent:a1', [sessionPane('s2', 'diff')]), 0)).toBe('agent:a1');
    const grid = panes('s1', 'agent:a1', [sessionPane('s2', 'workflow:w1'), sessionPane('s3', 'diff')]);
    expect(paneTabAt(grid, 0)).toBe('session');
    expect(paneTabAt(grid, 1)).toBe('session');
    expect(paneTabAt(grid, 2)).toBe('diff'); // built-ins are untouched
  });

  it('answers null for an out-of-range pane', () => {
    expect(paneSessionIdAt(s, 9)).toBeNull();
    expect(paneTabAt(s, 9)).toBe('session');
  });

  it('a shell-kind pane contributes no session and no PaneTab', () => {
    const withShell = panes('s1', 'session', [shellPane('p1'), sessionPane('s3', 'diff')]);
    expect(paneSessionIdAt(withShell, 1)).toBeNull();
    expect(paneTabAt(withShell, 1)).toBe('session'); // never actually rendered — kind decides chrome
  });

  it('locates every pane showing a session — unbound-panes FR-5: duplicates are legitimate', () => {
    expect(paneIndicesOf(s, 's1')).toEqual([0]);
    expect(paneIndicesOf(s, 's3')).toEqual([2]);
    expect(paneIndicesOf(s, 'nope')).toEqual([]);

    const dup = panes('s1', 'session', [sessionPane('s1', 'diff'), sessionPane('s2', 'session')]);
    expect(paneIndicesOf(dup, 's1')).toEqual([0, 1]);
  });
});

describe('focusedSessionId / focusedTab (FR-13, unbound-panes FR-12 fallback)', () => {
  const s = panes('s1', 'diff', [sessionPane('s2', 'shell'), sessionPane('s3', 'session')]);

  it('is the focused pane’s session and tab', () => {
    expect(focusedSessionId({ ...s, focusedPaneIndex: 0 })).toBe('s1');
    expect(focusedSessionId({ ...s, focusedPaneIndex: 2 })).toBe('s3');
    expect(focusedTab({ ...s, focusedPaneIndex: 1 })).toBe('shell');
  });

  it('equals activeSessionId when not split, so every consumer is unchanged', () => {
    const single = panes('s1', 'overview', []);
    expect(focusedSessionId({ ...single, focusedPaneIndex: 0 })).toBe('s1');
    expect(focusedTab({ ...single, focusedPaneIndex: 0 })).toBe('overview');
  });

  it('clamps a stale focused index rather than reading past the list', () => {
    expect(focusedSessionId({ ...s, focusedPaneIndex: 7 })).toBe('s3');
  });

  it('unbound-panes FR-12: falls back to lastFocusedSessionId when the focused pane is a shell', () => {
    const withShell = panes('s1', 'session', [shellPane('p1')], 's1');
    expect(focusedSessionId({ ...withShell, focusedPaneIndex: 1 })).toBe('s1');
  });

  it('an EMPTY session pane focused answers null even with a lastFocusedSessionId on file', () => {
    const withEmpty = panes('s1', 'session', [sessionPane(null)], 's1');
    expect(focusedSessionId({ ...withEmpty, focusedPaneIndex: 1 })).toBeNull();
  });

  it('is null when no session pane has ever been focused this run', () => {
    const withShell = panes(null, 'session', [shellPane('p1')], null);
    expect(focusedSessionId({ ...withShell, focusedPaneIndex: 1 })).toBeNull();
  });
});

describe('visibleSessionIds (FR-26, unbound-panes FR-5: duplicates count once, shells contribute nothing)', () => {
  it('lists every pane’s session once', () => {
    expect(visibleSessionIds(panes('s1', 'session', [sessionPane('s2'), sessionPane('s3', 'diff')]))).toEqual([
      's1',
      's2',
      's3',
    ]);
  });

  it('is just the active session when not split', () => {
    expect(visibleSessionIds(panes('s1', 'session', []))).toEqual(['s1']);
    expect(visibleSessionIds(panes(null, 'session', []))).toEqual([]);
  });

  it('the same session in two panes counts once', () => {
    expect(visibleSessionIds(panes('s1', 'session', [sessionPane('s1', 'diff'), sessionPane('s2')]))).toEqual([
      's1',
      's2',
    ]);
  });

  it('a shell pane contributes nothing', () => {
    expect(visibleSessionIds(panes('s1', 'session', [shellPane('p1'), sessionPane('s2')]))).toEqual(['s1', 's2']);
  });
});

describe('isShellVisible (FR-25)', () => {
  it('is true for pane 0 on SHELL, whatever the other panes show', () => {
    expect(isShellVisible(panes('s1', 'shell', [sessionPane('s2', 'diff')]), 's1')).toBe(true);
    expect(isShellVisible(panes('s1', 'diff', [sessionPane('s2', 'diff')]), 's1')).toBe(false);
  });

  it('is true for ANY pane on SHELL — not just the focused one', () => {
    const s = panes('s1', 'session', [sessionPane('s2', 'shell')]);
    expect(isShellVisible(s, 's2')).toBe(true);
    expect(isShellVisible(s, 's1')).toBe(false);
  });

  it('is false throughout the grid chrome — no pane there renders a shell (FR-9)', () => {
    const s = panes('s1', 'shell', [sessionPane('s2', 'shell'), sessionPane('s3', 'shell')]);
    expect(isShellVisible(s, 's1')).toBe(false);
    expect(isShellVisible(s, 's3')).toBe(false);
  });

  it('a shell-KIND pane never registers as a session’s SHELL tab', () => {
    const s = panes('s1', 'session', [shellPane('p1')]);
    expect(isShellVisible(s, 's1')).toBe(false);
  });
});

describe('splitCandidates / splitCandidate (unbound-panes FR-3: no scope argument — the WHOLE fleet)', () => {
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

describe('promotionTarget (unbound-panes FR-8)', () => {
  it('picks the first SESSION-kind pane, skipping shells', () => {
    expect(promotionTarget([shellPane('p1'), sessionPane('s2'), shellPane('p2')])).toBe(1);
    expect(promotionTarget([sessionPane('s1'), shellPane('p1')])).toBe(0);
  });

  it('is null when there is no session pane to promote', () => {
    expect(promotionTarget([shellPane('p1'), shellPane('p2')])).toBeNull();
    expect(promotionTarget([])).toBeNull();
  });
});

describe('railOrder (unbound-panes FR-15)', () => {
  const list = [meta('a', 10), meta('b', 50), meta('c', 30), meta('d', 40)];

  it('pins paned sessions to the top, both groups by lastActivityAt desc', () => {
    expect(railOrder(list, ['a', 'c']).map((m) => m.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('is plain recency order with nothing paned', () => {
    expect(railOrder(list, []).map((m) => m.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('never disagrees with splitCandidates’ own order', () => {
    expect(railOrder(list, []).map((m) => m.id)).toEqual(splitCandidates(list, [], list.length).map((m) => m.id));
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
  it('drops every SESSION pane on that session, leaving shell panes untouched', () => {
    const list: PaneSlot[] = [sessionPane('s2'), sessionPane('s3', 'diff'), shellPane('p1')];
    expect(panesWithout(list, 's2')).toEqual([sessionPane('s3', 'diff'), shellPane('p1')]);
    expect(panesWithout(list, 'nope')).toHaveLength(3);
  });
});

describe('panesWithoutStaleProjects (unbound-panes FR-17)', () => {
  it('drops a shell pane whose project is no longer registered', () => {
    const list: PaneSlot[] = [shellPane('p1'), shellPane('p2'), sessionPane('s1')];
    expect(panesWithoutStaleProjects(list, new Set(['p1']))).toEqual([shellPane('p1'), sessionPane('s1')]);
  });

  it('leaves session panes alone regardless of the registry', () => {
    const list: PaneSlot[] = [sessionPane('s1')];
    expect(panesWithoutStaleProjects(list, new Set())).toEqual(list);
  });
});

// ── persistence ─────────────────────────────────────────────────────────────

describe('parseSplitState (FR-23, unbound-panes FR-17)', () => {
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

  it('reads a bare {sessionId, tab} record (the split-by-4 shape, no `kind`) as a session pane', () => {
    expect(parseSplitState(JSON.stringify({ extraPanes: [{ sessionId: 's2', tab: 'diff' }] }))).toEqual({
      extraPanes: [sessionPane('s2', 'diff')],
      focusedPaneIndex: 0,
    });
  });

  it('reads the union shape’s session AND shell variants', () => {
    expect(
      parseSplitState(
        JSON.stringify({
          extraPanes: [
            { kind: 'session', sessionId: 's2', tab: 'diff' },
            { kind: 'shell', projectId: 'p1' },
          ],
        }),
      ),
    ).toEqual({ extraPanes: [sessionPane('s2', 'diff'), shellPane('p1')], focusedPaneIndex: 0 });
  });

  it('drops a shell entry with no usable projectId', () => {
    expect(parseSplitState(JSON.stringify({ extraPanes: [{ kind: 'shell' }] }))).toEqual(NOT_SPLIT);
  });

  it('defaults an unknown tab and clamps the focused index rather than trusting them', () => {
    expect(
      parseSplitState(JSON.stringify({ extraPanes: [{ sessionId: 's2', tab: 'overview' }], focusedPaneIndex: 9 })),
    ).toEqual({ extraPanes: [sessionPane('s2', 'session')], focusedPaneIndex: 1 });
  });

  it('unbound-panes FR-5: NO LONGER drops a duplicate session pane — duplicates are legitimate', () => {
    expect(
      parseSplitState(
        JSON.stringify({ extraPanes: [{ sessionId: 's2', tab: 'diff' }, { sessionId: 's2', tab: 'shell' }] }),
      ).extraPanes,
    ).toEqual([sessionPane('s2', 'diff'), sessionPane('s2', 'shell')]);
  });

  it('caps the list at MAX_PANES - 1 extras', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ sessionId: `s${i}`, tab: 'session' }));
    expect(parseSplitState(JSON.stringify({ extraPanes: many })).extraPanes).toHaveLength(MAX_PANES - 1);
  });

  it('round-trips a fully valid record', () => {
    const rec = { extraPanes: [sessionPane('s2', 'shell'), sessionPane('s3', 'diff')], focusedPaneIndex: 2 };
    expect(parseSplitState(JSON.stringify(rec))).toEqual(rec);
  });

  it('reads a LEGACY split-session record as one extra pane', () => {
    expect(parseSplitState(JSON.stringify({ splitSessionId: 's2', splitTab: 'diff', focusedSide: 'right' }))).toEqual({
      extraPanes: [sessionPane('s2', 'diff')],
      focusedPaneIndex: 1,
    });
    expect(parseSplitState(JSON.stringify({ splitSessionId: 's2', splitTab: 'nope', focusedSide: 'left' }))).toEqual({
      extraPanes: [sessionPane('s2', 'session')],
      focusedPaneIndex: 0,
    });
  });

  it('degrades a legacy not-split record to not-split', () => {
    expect(parseSplitState(JSON.stringify({ splitSessionId: null, splitTab: 'diff', focusedSide: 'left' }))).toEqual(
      NOT_SPLIT,
    );
  });

  it('FR-17: shellId is never carried by a persisted record — it round-trips as null every time', () => {
    const parsed = parseSplitState(JSON.stringify({ extraPanes: [{ kind: 'shell', projectId: 'p1', shellId: 'ignored' }] }));
    expect(parsed.extraPanes).toEqual([shellPane('p1', null)]);
  });
});

describe('initialLastFocusedSessionId (unbound-panes FR-12: seeding lastFocusedSessionId from the hydrated split BEFORE any focus subscription runs)', () => {
  it('not split ⇒ null (pane 0 is always empty this early — sessions arrive over the fleet sync)', () => {
    expect(initialLastFocusedSessionId({ extraPanes: [], focusedPaneIndex: 0 })).toBeNull();
  });

  it('reads the focused extra pane’s session directly when it is a session pane', () => {
    expect(
      initialLastFocusedSessionId({ extraPanes: [sessionPane('s2'), sessionPane('s3')], focusedPaneIndex: 2 }),
    ).toBe('s3');
  });

  it('a persisted focusedPaneIndex on a SHELL pane falls back to the first session-holding pane, not null', () => {
    expect(
      initialLastFocusedSessionId({ extraPanes: [shellPane('p1'), sessionPane('s2')], focusedPaneIndex: 1 }),
    ).toBe('s2');
  });

  it('a persisted focusedPaneIndex on an EMPTY session pane also falls back', () => {
    expect(
      initialLastFocusedSessionId({ extraPanes: [sessionPane(null), sessionPane('s2')], focusedPaneIndex: 1 }),
    ).toBe('s2');
  });

  it('no session pane anywhere ⇒ null', () => {
    expect(initialLastFocusedSessionId({ extraPanes: [shellPane('p1'), sessionPane(null)], focusedPaneIndex: 2 })).toBeNull();
  });
});

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

// ── unbound-panes FR-9 / FR-15 chrome predicates ────────────────────────────

describe('canOpenShellPane (unbound-panes FR-9)', () => {
  it('needs room in the grid AND at least one registered project', () => {
    expect(canOpenShellPane(1, 2)).toBe(true);
    expect(canOpenShellPane(3, 1)).toBe(true);
    expect(canOpenShellPane(MAX_PANES, 2)).toBe(false); // no room
    expect(canOpenShellPane(1, 0)).toBe(false); // nothing to root a shell at
  });
});

describe('projectShellPaneCount / shellPaneEligibleProjects (unbound-panes edge case 4: SHELL_LIMIT_REACHED, per-owner cap)', () => {
  it('counts only shell-kind panes rooted at that project — session panes and other projects never count', () => {
    const extraPanes = [shellPane('p1'), sessionPane('s2'), shellPane('p2'), shellPane('p1')];
    expect(projectShellPaneCount(extraPanes, 'p1')).toBe(2);
    expect(projectShellPaneCount(extraPanes, 'p2')).toBe(1);
    expect(projectShellPaneCount(extraPanes, 'p3')).toBe(0);
  });

  it('drops a dead-root project (unchanged behavior) and one already at the shell cap', () => {
    const projects = [
      { id: 'p1', rootExists: true },
      { id: 'p2', rootExists: true },
      { id: 'p3', rootExists: false },
    ];
    const extraPanes = Array.from({ length: 6 }, () => shellPane('p1'));
    expect(shellPaneEligibleProjects(projects, extraPanes).map((p) => p.id)).toEqual(['p2']);
  });

  it('offers a project right up to the cap boundary, and drops it exactly at 6', () => {
    const projects = [{ id: 'p1', rootExists: true }];
    expect(shellPaneEligibleProjects(projects, Array.from({ length: 5 }, () => shellPane('p1')))).toHaveLength(1);
    expect(shellPaneEligibleProjects(projects, Array.from({ length: 6 }, () => shellPane('p1')))).toHaveLength(0);
  });
});

describe('railPinnedCount (unbound-panes FR-15 / design brief hairline)', () => {
  const list = [meta('a', 10), meta('b', 50), meta('c', 30)];

  it('counts the paned sessions actually present, which is where the hairline goes', () => {
    expect(railPinnedCount(list, ['a', 'c'])).toBe(2);
    expect(railPinnedCount(list, [])).toBe(0);
  });

  it('ignores a paned id with no session in the list (a stale pane, FR-16 no phantom row)', () => {
    expect(railPinnedCount(list, ['a', 'ghost'])).toBe(1);
  });

  it('never reports a hairline when EVERY tile is pinned — there is no `rest` to separate', () => {
    expect(railPinnedCount(list, ['a', 'b', 'c'])).toBe(0);
  });
});
