// collapse-right-column: covers the collapsedPanes slice — parseCollapsedPanes
// (FR-4 malformed-input normalization), toggle/set + localStorage round-trip
// (FR-1/2/3), and the focus invariants (FR-5 collapsing the focused pane hands
// focus to main; FR-6 focusing a collapsed right pane expands it).

// The pane list (split-by-4) has its own file: src/lib/split-by-4.test.ts.
// The split DIVIDER's ratio slice is covered at the bottom of this file — it is
// a layout preference of its own, not part of the pane list.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampSplitRatio,
  COLLAPSED_PANES_STORAGE_KEY,
  DEFAULT_ROSTER_WIDTH,
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_PANE_PX,
  MIN_SPLIT_PANE_ROW_PX,
  MIN_SPLIT_RATIO,
  parseCollapsedPanes,
  parseSplitRatio,
  ROSTER_WIDTH_STORAGE_KEY,
  SESSION_META_KEY,
  SPLIT_RATIO_STORAGE_KEY,
  SPLIT_ROW_RATIO_STORAGE_KEY,
  splitRatioFromDrag,
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

// ── split divider ───────────────────────────────────────────────────────────

describe('clampSplitRatio', () => {
  it('keeps a ratio inside the bounds, rounded to 0.1%', () => {
    expect(clampSplitRatio(0.5)).toBe(0.5);
    expect(clampSplitRatio(0.33333)).toBe(0.333);
  });

  it('clamps past either bound', () => {
    expect(clampSplitRatio(0)).toBe(MIN_SPLIT_RATIO);
    expect(clampSplitRatio(1)).toBe(MAX_SPLIT_RATIO);
    expect(clampSplitRatio(-4)).toBe(MIN_SPLIT_RATIO);
  });

  it('falls back to the default for anything that is not a finite number', () => {
    expect(clampSplitRatio(NaN)).toBe(DEFAULT_SPLIT_RATIO);
    expect(clampSplitRatio(Infinity)).toBe(DEFAULT_SPLIT_RATIO);
    expect(clampSplitRatio('0.7')).toBe(DEFAULT_SPLIT_RATIO);
    expect(clampSplitRatio(null)).toBe(DEFAULT_SPLIT_RATIO);
    expect(clampSplitRatio(undefined)).toBe(DEFAULT_SPLIT_RATIO);
  });
});

describe('parseSplitRatio', () => {
  it('defaults for an absent or malformed persisted value', () => {
    expect(parseSplitRatio(null)).toBe(DEFAULT_SPLIT_RATIO);
    expect(parseSplitRatio('wide')).toBe(DEFAULT_SPLIT_RATIO);
    expect(parseSplitRatio('')).toBe(DEFAULT_SPLIT_RATIO);
  });

  it('reads back a persisted ratio, clamped', () => {
    expect(parseSplitRatio('0.62')).toBe(0.62);
    expect(parseSplitRatio('0.95')).toBe(MAX_SPLIT_RATIO);
  });
});

describe('splitRatioFromDrag', () => {
  it('maps the pointer to the left pane’s share of the grid', () => {
    expect(splitRatioFromDrag(1000, 300, 1000)).toBe(0.7);
    expect(splitRatioFromDrag(700, 300, 1000)).toBe(0.4);
  });

  it('clamps to the ratio bounds on a grid wide enough for them to bite', () => {
    // 2000px wide → the px floor is 13%, so the 20%/80% ratio bounds win.
    expect(splitRatioFromDrag(0, 0, 2000)).toBe(MIN_SPLIT_RATIO);
    expect(splitRatioFromDrag(2000, 0, 2000)).toBe(MAX_SPLIT_RATIO);
  });

  it('never leaves either pane narrower than MIN_SPLIT_PANE_PX', () => {
    // 1000px wide → the px floor (26%) is tighter than the 20% ratio bound.
    const width = 1000;
    const floor = MIN_SPLIT_PANE_PX / width;
    expect(splitRatioFromDrag(0, 0, width)).toBeCloseTo(floor, 3);
    expect(splitRatioFromDrag(width, 0, width)).toBeCloseTo(1 - floor, 3);
  });

  it('degrades to an even split when the grid is too narrow for two minimums', () => {
    expect(splitRatioFromDrag(0, 0, 400)).toBe(DEFAULT_SPLIT_RATIO);
    expect(splitRatioFromDrag(400, 0, 400)).toBe(DEFAULT_SPLIT_RATIO);
  });

  it('defaults on an unmeasurable grid rather than dividing by zero', () => {
    expect(splitRatioFromDrag(500, 0, 0)).toBe(DEFAULT_SPLIT_RATIO);
    expect(splitRatioFromDrag(500, 0, NaN)).toBe(DEFAULT_SPLIT_RATIO);
  });

  it('takes the row minimum on the y axis — the same math, a shorter floor', () => {
    // 600px tall: the row floor is 30%, where the column floor would be 43%.
    const rowFloor = MIN_SPLIT_PANE_ROW_PX / 600;
    expect(splitRatioFromDrag(0, 0, 600, MIN_SPLIT_PANE_ROW_PX)).toBeCloseTo(rowFloor, 3);
    expect(splitRatioFromDrag(0, 0, 600)).toBeCloseTo(MIN_SPLIT_PANE_PX / 600, 3);
  });
});

describe('splitRatio store slice', () => {
  let storage: { store: Record<string, string> };

  beforeEach(() => {
    storage = mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to an even split with an empty storage', async () => {
    const useStore = await freshStore();
    expect(useStore.getState().splitRatio).toBe(DEFAULT_SPLIT_RATIO);
  });

  it('hydrates from its own key and persists on change', async () => {
    storage.store[SPLIT_RATIO_STORAGE_KEY] = '0.64';
    const useStore = await freshStore();
    expect(useStore.getState().splitRatio).toBe(0.64);
    useStore.getState().setSplitRatio(0.38);
    expect(useStore.getState().splitRatio).toBe(0.38);
    expect(storage.store[SPLIT_RATIO_STORAGE_KEY]).toBe('0.38');
  });

  it('clamps whatever it is handed', async () => {
    const useStore = await freshStore();
    useStore.getState().setSplitRatio(0.99);
    expect(useStore.getState().splitRatio).toBe(MAX_SPLIT_RATIO);
  });

  it('survives leaving and re-entering split', async () => {
    const useStore = await freshStore();
    useStore.setState({ activeSessionId: 's1' });
    useStore.getState().setSplitRatio(0.62);
    useStore.getState().openInNewPane('s2');
    useStore.getState().unsplit();
    expect(useStore.getState().splitRatio).toBe(0.62);
  });

  it('keeps the row ratio on its own key, independent of the column ratio', async () => {
    storage.store[SPLIT_RATIO_STORAGE_KEY] = '0.7';
    storage.store[SPLIT_ROW_RATIO_STORAGE_KEY] = '0.35';
    const useStore = await freshStore();
    expect(useStore.getState().splitRatio).toBe(0.7);
    expect(useStore.getState().splitRowRatio).toBe(0.35);
    useStore.getState().setSplitRowRatio(0.55);
    expect(useStore.getState().splitRowRatio).toBe(0.55);
    expect(useStore.getState().splitRatio).toBe(0.7); // untouched
    expect(storage.store[SPLIT_ROW_RATIO_STORAGE_KEY]).toBe('0.55');
    expect(storage.store[SPLIT_RATIO_STORAGE_KEY]).toBe('0.7');
  });

  it('clamps the row ratio too', async () => {
    const useStore = await freshStore();
    useStore.getState().setSplitRowRatio(-1);
    expect(useStore.getState().splitRowRatio).toBe(MIN_SPLIT_RATIO);
  });

  it('degrades to the default when localStorage throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const useStore = await freshStore();
    expect(useStore.getState().splitRatio).toBe(DEFAULT_SPLIT_RATIO);
    expect(() => useStore.getState().setSplitRatio(0.7)).not.toThrow();
    expect(useStore.getState().splitRatio).toBe(0.7);
  });
});

// resizable-sidebar: the roster-width slice — stores the raw INTENT (never
// clamped here; clampRosterWidth is a render-time concern) and never rewrites
// storage on a no-op set (FR-8).
describe('rosterWidth store slice', () => {
  let storage: { store: Record<string, string> };

  beforeEach(() => {
    storage = mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to 282 with empty storage', async () => {
    const useStore = await freshStore();
    expect(useStore.getState().rosterWidth).toBe(DEFAULT_ROSTER_WIDTH);
  });

  it('hydrates from its own key and persists on change', async () => {
    storage.store[ROSTER_WIDTH_STORAGE_KEY] = '400';
    const useStore = await freshStore();
    expect(useStore.getState().rosterWidth).toBe(400);
    useStore.getState().setRosterWidth(360);
    expect(useStore.getState().rosterWidth).toBe(360);
    expect(storage.store[ROSTER_WIDTH_STORAGE_KEY]).toBe('360');
  });

  it('stores the raw intent, unclamped — a 520px width survives being set outright', async () => {
    const useStore = await freshStore();
    useStore.getState().setRosterWidth(520);
    expect(useStore.getState().rosterWidth).toBe(520);
    expect(storage.store[ROSTER_WIDTH_STORAGE_KEY]).toBe('520');
  });

  it('a no-op set does not rewrite storage', async () => {
    const useStore = await freshStore();
    useStore.getState().setRosterWidth(DEFAULT_ROSTER_WIDTH);
    delete storage.store[ROSTER_WIDTH_STORAGE_KEY];
    useStore.getState().setRosterWidth(DEFAULT_ROSTER_WIDTH);
    expect(storage.store[ROSTER_WIDTH_STORAGE_KEY]).toBeUndefined();
  });

  it('never touches showLeftPane', async () => {
    const useStore = await freshStore();
    useStore.getState().setRosterWidth(220);
    expect(useStore.getState().showLeftPane).toBe(true);
  });

  it('resetRosterWidth returns to the default and persists', async () => {
    storage.store[ROSTER_WIDTH_STORAGE_KEY] = '520';
    const useStore = await freshStore();
    useStore.getState().resetRosterWidth();
    expect(useStore.getState().rosterWidth).toBe(DEFAULT_ROSTER_WIDTH);
    expect(storage.store[ROSTER_WIDTH_STORAGE_KEY]).toBe(String(DEFAULT_ROSTER_WIDTH));
  });

  it('degrades to the default when localStorage throws, and set never throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const useStore = await freshStore();
    expect(useStore.getState().rosterWidth).toBe(DEFAULT_ROSTER_WIDTH);
    expect(() => useStore.getState().setRosterWidth(400)).not.toThrow();
    expect(useStore.getState().rosterWidth).toBe(400);
  });

  it('a hand-edited garbage value normalizes without throwing', async () => {
    storage.store[ROSTER_WIDTH_STORAGE_KEY] = 'abc';
    const useStore = await freshStore();
    expect(useStore.getState().rosterWidth).toBe(DEFAULT_ROSTER_WIDTH);
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
