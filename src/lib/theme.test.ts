// Theme slice of the app store (light/dark). Covers the persistence contract:
// default is 'dark' when storage is empty, toggleTheme flips + persists, setTheme
// persists. localStorage is mocked (the node test env has none); the store's DOM
// write is guarded (typeof document !== 'undefined') so it no-ops here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    clear: () => {
      state.store = {};
    },
  });
  return state;
}

// The store reads localStorage at module-init (loadTheme), so re-import fresh per test.
async function freshStore() {
  vi.resetModules();
  const mod = await import('./store');
  return mod.useStore;
}

describe('theme store slice', () => {
  let storage: { store: Record<string, string> };

  beforeEach(() => {
    storage = mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to 'dark' when storage is empty", async () => {
    const useStore = await freshStore();
    expect(useStore.getState().theme).toBe('dark');
  });

  it("initializes from a persisted 'light' value", async () => {
    storage.store['francois.theme'] = 'light';
    const useStore = await freshStore();
    expect(useStore.getState().theme).toBe('light');
  });

  it('toggleTheme flips dark→light and persists', async () => {
    const useStore = await freshStore();
    useStore.getState().toggleTheme();
    expect(useStore.getState().theme).toBe('light');
    expect(storage.store['francois.theme']).toBe('light');
    useStore.getState().toggleTheme();
    expect(useStore.getState().theme).toBe('dark');
    expect(storage.store['francois.theme']).toBe('dark');
  });

  it('setTheme persists the given value', async () => {
    const useStore = await freshStore();
    useStore.getState().setTheme('light');
    expect(useStore.getState().theme).toBe('light');
    expect(storage.store['francois.theme']).toBe('light');
    useStore.getState().setTheme('dark');
    expect(storage.store['francois.theme']).toBe('dark');
  });
});

// The pure half main.tsx uses before first paint (no store yet at that point).
describe('theme helpers', () => {
  it('parseTheme reads only an exact "light" as light', async () => {
    const { parseTheme } = await import('./theme');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme(null)).toBe('dark');
    expect(parseTheme('LIGHT')).toBe('dark');
    expect(parseTheme('')).toBe('dark');
  });

  it('nextTheme flips', async () => {
    const { nextTheme } = await import('./theme');
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
  });

  it('readStoredTheme degrades to dark when storage throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
    });
    const { readStoredTheme } = await import('./theme');
    expect(readStoredTheme()).toBe('dark');
    vi.unstubAllGlobals();
  });

  it('readStoredTheme reads the persisted key', async () => {
    const state = mockStorage();
    state.store['francois.theme'] = 'light';
    const { readStoredTheme, THEME_KEY } = await import('./theme');
    expect(THEME_KEY).toBe('francois.theme');
    expect(readStoredTheme()).toBe('light');
    vi.unstubAllGlobals();
  });
});
