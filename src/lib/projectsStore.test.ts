// projects slice of the app store (FR-26). Covers the persistence WIRING that the
// pure reconcileActiveProjectId/loadActiveProjectId helpers cannot: that the store
// initialises activeProjectId from storage, persists on every explicit set, and
// reconciles + persists the fallback when setProjects drops the active project.
//
// These are exactly §9's "activeProjectId survives a restart" and "falls back to All
// when it names a removed project" criteria. localStorage is mocked (the node test
// env has none) and the store reads it at module-init, so each test re-imports fresh.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectMeta } from '../../contract/projects';
import { ACTIVE_PROJECT_STORAGE_KEY } from '../../contract/projects';

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

function proj(id: string, name = id): ProjectMeta {
  return { id, name, root: `D:/${name}`, defaults: {}, createdAt: 0, lastUsedAt: 0, rootExists: true };
}

describe('projects store slice (FR-26)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to All projects when storage is empty', async () => {
    mockStorage();
    const useStore = await freshStore();
    expect(useStore.getState().activeProjectId).toBeNull();
    expect(useStore.getState().projects).toEqual([]);
    expect(useStore.getState().projectsOpen).toBe(false);
  });

  it('restores activeProjectId from storage on init — the "survives a restart" case', async () => {
    mockStorage({ [ACTIVE_PROJECT_STORAGE_KEY]: 'p1' });
    const useStore = await freshStore();
    expect(useStore.getState().activeProjectId).toBe('p1');
  });

  it('setActiveProjectId persists, and null clears back to All', async () => {
    const storage = mockStorage();
    const useStore = await freshStore();

    useStore.getState().setActiveProjectId('p2');
    expect(useStore.getState().activeProjectId).toBe('p2');
    expect(storage.store[ACTIVE_PROJECT_STORAGE_KEY]).toBe('p2');

    useStore.getState().setActiveProjectId(null);
    expect(useStore.getState().activeProjectId).toBeNull();
    // null must not be persisted as the literal string "null"
    expect(storage.store[ACTIVE_PROJECT_STORAGE_KEY]).toBeUndefined();
  });

  it('setProjects keeps an active project that is still in the list', async () => {
    mockStorage({ [ACTIVE_PROJECT_STORAGE_KEY]: 'p1' });
    const useStore = await freshStore();

    useStore.getState().setProjects([proj('p1'), proj('p2')]);
    expect(useStore.getState().activeProjectId).toBe('p1');
    expect(useStore.getState().projects).toHaveLength(2);
  });

  it('setProjects falls back to All — and PERSISTS it — when the active project is gone', async () => {
    const storage = mockStorage({ [ACTIVE_PROJECT_STORAGE_KEY]: 'p1' });
    const useStore = await freshStore();
    expect(useStore.getState().activeProjectId).toBe('p1');

    // p1 was removed elsewhere; the next project_list no longer carries it (§7 case 16)
    useStore.getState().setProjects([proj('p2')]);
    expect(useStore.getState().activeProjectId).toBeNull();
    // the stale id must be cleared from storage, or it returns on the next launch
    expect(storage.store[ACTIVE_PROJECT_STORAGE_KEY]).toBeUndefined();
  });

  it('an empty registry also falls back to All', async () => {
    mockStorage({ [ACTIVE_PROJECT_STORAGE_KEY]: 'p1' });
    const useStore = await freshStore();

    useStore.getState().setProjects([]);
    expect(useStore.getState().activeProjectId).toBeNull();
  });

  it('does not rewrite storage when the active project is unchanged', async () => {
    const storage = mockStorage({ [ACTIVE_PROJECT_STORAGE_KEY]: 'p1' });
    const useStore = await freshStore();

    useStore.getState().setProjects([proj('p1')]);
    expect(storage.store[ACTIVE_PROJECT_STORAGE_KEY]).toBe('p1');
    expect(useStore.getState().activeProjectId).toBe('p1');
  });

  it('setProjectsOpen toggles the modal flag without touching the registry', async () => {
    mockStorage();
    const useStore = await freshStore();

    useStore.getState().setProjects([proj('p1')]);
    useStore.getState().setProjectsOpen(true);
    expect(useStore.getState().projectsOpen).toBe(true);
    expect(useStore.getState().projects).toHaveLength(1);

    useStore.getState().setProjectsOpen(false);
    expect(useStore.getState().projectsOpen).toBe(false);
  });
});
