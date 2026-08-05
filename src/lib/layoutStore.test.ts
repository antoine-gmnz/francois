// collapse-right-column: covers the collapsedPanes slice — parseCollapsedPanes
// (FR-4 malformed-input normalization), toggle/set + localStorage round-trip
// (FR-1/2/3), and the focus invariants (FR-5 collapsing the focused pane hands
// focus to main; FR-6 focusing a collapsed right pane expands it).

// The pane list (split-by-4) has its own file: src/lib/split-by-4.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLLAPSED_PANES_STORAGE_KEY, parseCollapsedPanes, SESSION_META_KEY } from './layoutStore';

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
