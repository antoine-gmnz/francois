// The right-hand session panel (redesign "Graphite & Signal", Figma "Session
// panel" 130:378): whether it is open and which tab it shows, both persisted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSessionPanelOpen, parseSessionPanelTab, SESSION_PANEL_TABS } from './sessionPanelStore';

function mockStorage(): { store: Record<string, string> } {
  const state = { store: {} as Record<string, string> };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in state.store ? state.store[k] : null),
    setItem: (k: string, v: string) => {
      state.store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete state.store[k];
    },
  });
  return state;
}

async function freshStore() {
  vi.resetModules();
  const mod = await import('./store');
  return mod.useStore;
}

describe('session panel parsers', () => {
  it('open defaults to true; only an exact "0" closes it', () => {
    expect(parseSessionPanelOpen(null)).toBe(true);
    expect(parseSessionPanelOpen('1')).toBe(true);
    expect(parseSessionPanelOpen('0')).toBe(false);
    expect(parseSessionPanelOpen('garbage')).toBe(true);
  });

  it('tab defaults to changes; unknown values degrade to it', () => {
    expect(parseSessionPanelTab(null)).toBe('changes');
    expect(parseSessionPanelTab('activity')).toBe('activity');
    expect(parseSessionPanelTab('nope')).toBe('changes');
  });

  it('lists the four design tabs in order', () => {
    expect(SESSION_PANEL_TABS).toEqual(['changes', 'plan', 'activity', 'context']);
  });
});

describe('session panel slice', () => {
  let storage: { store: Record<string, string> };
  beforeEach(() => {
    storage = mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts open on the changes tab', async () => {
    const useStore = await freshStore();
    expect(useStore.getState().showSessionPanel).toBe(true);
    expect(useStore.getState().sessionPanelTab).toBe('changes');
  });

  it('hydrates from storage', async () => {
    storage.store['francois.sessionPanel'] = '0';
    storage.store['francois.sessionPanelTab'] = 'context';
    const useStore = await freshStore();
    expect(useStore.getState().showSessionPanel).toBe(false);
    expect(useStore.getState().sessionPanelTab).toBe('context');
  });

  it('toggleSessionPanel flips and persists', async () => {
    const useStore = await freshStore();
    useStore.getState().toggleSessionPanel();
    expect(useStore.getState().showSessionPanel).toBe(false);
    expect(storage.store['francois.sessionPanel']).toBe('0');
    useStore.getState().toggleSessionPanel();
    expect(storage.store['francois.sessionPanel']).toBe('1');
  });

  it('setSessionPanelTab switches, persists, and opens a closed panel', async () => {
    const useStore = await freshStore();
    useStore.getState().setShowSessionPanel(false);
    useStore.getState().setSessionPanelTab('activity');
    expect(useStore.getState().sessionPanelTab).toBe('activity');
    expect(useStore.getState().showSessionPanel).toBe(true);
    expect(storage.store['francois.sessionPanelTab']).toBe('activity');
  });
});
