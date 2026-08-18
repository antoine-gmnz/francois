// notifications FR-17 / audio-cues FR-11: covers the `useNotificationsStore`
// persistence contract — default on when storage is empty/malformed,
// setNotifyEnabled/setSoundEnabled set state AND persist, and a restricted
// storage environment degrades silently (same shape as theme.test.ts /
// layoutStore.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// The store reads localStorage at module-init, so re-import fresh per test.
async function freshStore() {
  vi.resetModules();
  const mod = await import('./notificationsStore');
  return mod.useNotificationsStore;
}

describe('useNotificationsStore (FR-17)', () => {
  let storage: { store: Record<string, string> };

  beforeEach(() => {
    storage = mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults both classes to on when storage is empty', async () => {
    const useNotificationsStore = await freshStore();
    expect(useNotificationsStore.getState().enabled).toEqual({ attention: true, turnDone: true });
  });

  it('defaults to on when a key is malformed (not exactly "0")', async () => {
    storage.store['francois.notify.attention'] = 'bogus';
    const useNotificationsStore = await freshStore();
    expect(useNotificationsStore.getState().enabled.attention).toBe(true);
  });

  it('initializes each class independently from its own persisted "0"/"1"', async () => {
    storage.store['francois.notify.attention'] = '0';
    storage.store['francois.notify.turnDone'] = '1';
    const useNotificationsStore = await freshStore();
    expect(useNotificationsStore.getState().enabled).toEqual({ attention: false, turnDone: true });
  });

  it('setNotifyEnabled sets state and persists', async () => {
    const useNotificationsStore = await freshStore();
    useNotificationsStore.getState().setNotifyEnabled('turnDone', false);
    expect(useNotificationsStore.getState().enabled).toEqual({ attention: true, turnDone: false });
    expect(storage.store['francois.notify.turnDone']).toBe('0');

    useNotificationsStore.getState().setNotifyEnabled('turnDone', true);
    expect(useNotificationsStore.getState().enabled.turnDone).toBe(true);
    expect(storage.store['francois.notify.turnDone']).toBe('1');
  });

  it('setNotifyEnabled toggles one class without touching the other', async () => {
    const useNotificationsStore = await freshStore();
    useNotificationsStore.getState().setNotifyEnabled('attention', false);
    expect(useNotificationsStore.getState().enabled).toEqual({ attention: false, turnDone: true });
  });

  it('degrades silently to on when localStorage throws on read', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const useNotificationsStore = await freshStore();
    expect(useNotificationsStore.getState().enabled).toEqual({ attention: true, turnDone: true });
    // in-memory toggle still works for the session even though persistence is impossible
    expect(() => useNotificationsStore.getState().setNotifyEnabled('attention', false)).not.toThrow();
    expect(useNotificationsStore.getState().enabled.attention).toBe(false);
  });
});

describe('useNotificationsStore.soundEnabled (audio-cues FR-11)', () => {
  let storage: { store: Record<string, string> };

  beforeEach(() => {
    storage = mockStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to on when storage is empty', async () => {
    const useNotificationsStore = await freshStore();
    expect(useNotificationsStore.getState().soundEnabled).toBe(true);
  });

  it('defaults to on when the key is malformed (not exactly "0")', async () => {
    storage.store['francois.sound.enabled'] = 'bogus';
    const useNotificationsStore = await freshStore();
    expect(useNotificationsStore.getState().soundEnabled).toBe(true);
  });

  it('initializes off from a persisted "0"', async () => {
    storage.store['francois.sound.enabled'] = '0';
    const useNotificationsStore = await freshStore();
    expect(useNotificationsStore.getState().soundEnabled).toBe(false);
  });

  it('setSoundEnabled sets state and persists', async () => {
    const useNotificationsStore = await freshStore();
    useNotificationsStore.getState().setSoundEnabled(false);
    expect(useNotificationsStore.getState().soundEnabled).toBe(false);
    expect(storage.store['francois.sound.enabled']).toBe('0');

    useNotificationsStore.getState().setSoundEnabled(true);
    expect(useNotificationsStore.getState().soundEnabled).toBe(true);
    expect(storage.store['francois.sound.enabled']).toBe('1');
  });

  it('degrades silently to on when localStorage throws on read, and the in-memory toggle still works', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const useNotificationsStore = await freshStore();
    expect(useNotificationsStore.getState().soundEnabled).toBe(true);
    expect(() => useNotificationsStore.getState().setSoundEnabled(false)).not.toThrow();
    expect(useNotificationsStore.getState().soundEnabled).toBe(false);
  });
});
