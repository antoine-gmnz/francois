// projects slice of the app store (FR-26). Covers the persistence WIRING that the
// pure reconcileActiveProjectId/loadActiveProjectId helpers cannot: that the store
// initialises activeProjectId from storage, persists on every explicit set, and
// reconciles + persists the fallback when setProjects drops the active project.
//
// These are exactly §9's "activeProjectId survives a restart" and "falls back to All
// when it names a removed project" criteria. localStorage is mocked (the node test
// env has none) and the store reads it at module-init, so each test re-imports fresh.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../contract/common';
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

// EVERY test here re-imports the store (see freshStore below), and the first one
// to do so pays the cold transform of the whole store graph — which on a loaded
// machine overruns the 5s default and fails a test that does nothing but import.
// The timeout is a machine-speed guard, not a behavioural bound.
vi.setConfig({ testTimeout: 30_000 });

async function freshStore() {
  vi.resetModules();
  const mod = await import('./store');
  return mod.useStore;
}

function proj(id: string, name = id): ProjectMeta {
  return { id, name, root: `D:/${name}`, defaults: {}, createdAt: 0, lastUsedAt: 0, rootExists: true };
}

function sess(id: string, projectId?: string): SessionMeta {
  return {
    id,
    name: id,
    cwd: 'D:/x',
    model: { id: 'm', label: 'M' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    permissionModeSince: 0,
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    responseMode: 'default',
    allowGit: false,
    ...(projectId ? { projectId } : {}),
  };
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

  it('setGroups replaces the group list — project-groups §6, fed by the same project_list read', async () => {
    mockStorage();
    const useStore = await freshStore();

    expect(useStore.getState().groups).toEqual([]);
    useStore.getState().setGroups([{ id: 'g1', name: 'ODO', createdAt: 0 }]);
    expect(useStore.getState().groups).toEqual([{ id: 'g1', name: 'ODO', createdAt: 0 }]);
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

// switchProject is the scope change AS THE USER MAKES IT (FR-39): it lands
// inside the project it selects, rather than only re-filtering the board. These
// cover the three landings — a session, the new-session modal, the dashboard —
// plus the rollback that cancelling that modal performs.
describe('switchProject (FR-39)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  async function seeded() {
    mockStorage();
    const useStore = await freshStore();
    useStore.getState().setProjects([proj('p1'), proj('p2'), proj('empty'), proj('empty2')]);
    useStore.getState().setSessions([sess('loose'), sess('a1', 'p1'), sess('a2', 'p1'), sess('b1', 'p2')]);
    return useStore;
  }

  it('selects the project\'s FIRST session', async () => {
    const useStore = await seeded();

    useStore.getState().switchProject('p1');
    expect(useStore.getState().activeProjectId).toBe('p1');
    expect(useStore.getState().activeSessionId).toBe('a1');
    expect(useStore.getState().newSessionOpen).toBe(false);
    expect(useStore.getState().projectSwitchRollback).toBeNull();

    // ...and re-picks the first one of the NEXT project, not the last-used one
    useStore.getState().switchProject('p2');
    expect(useStore.getState().activeSessionId).toBe('b1');
  });

  it('leaves the OVERVIEW dashboard for the session it selected', async () => {
    const useStore = await seeded();
    useStore.getState().setMainTab('overview');

    useStore.getState().switchProject('p1');
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('does not disturb a non-overview tab', async () => {
    const useStore = await seeded();
    useStore.getState().setMainTab('diff');

    useStore.getState().switchProject('p1');
    expect(useStore.getState().mainTab).toBe('diff');
  });

  it('opens the new-session modal for a project with no sessions, and arms the rollback', async () => {
    const useStore = await seeded();
    useStore.getState().switchProject('p1'); // start somewhere real

    useStore.getState().switchProject('empty');
    expect(useStore.getState().activeProjectId).toBe('empty');
    expect(useStore.getState().newSessionOpen).toBe(true);
    expect(useStore.getState().projectSwitchRollback).toEqual({ to: 'p1' });
    // the previous session stays active — nothing in the empty project to replace it
    expect(useStore.getState().activeSessionId).toBe('a1');
  });

  it('rollbackProjectSwitch restores the previous scope — and persists it', async () => {
    const storage = mockStorage();
    const useStore = await freshStore();
    useStore.getState().setProjects([proj('p1'), proj('empty')]);
    useStore.getState().setSessions([sess('a1', 'p1')]);

    useStore.getState().switchProject('p1');
    useStore.getState().switchProject('empty');
    useStore.getState().rollbackProjectSwitch();

    expect(useStore.getState().activeProjectId).toBe('p1');
    expect(storage.store[ACTIVE_PROJECT_STORAGE_KEY]).toBe('p1');
    expect(useStore.getState().projectSwitchRollback).toBeNull();
    // the rollback must NOT re-run the landing logic and re-open the modal
    expect(useStore.getState().activeSessionId).toBe('a1');
  });

  it('rolls back to All projects too — a pending rollback is not the same as none', async () => {
    const storage = mockStorage();
    const useStore = await freshStore();
    useStore.getState().setProjects([proj('empty')]);

    expect(useStore.getState().activeProjectId).toBeNull(); // All
    useStore.getState().switchProject('empty');
    expect(useStore.getState().projectSwitchRollback).toEqual({ to: null });

    useStore.getState().rollbackProjectSwitch();
    expect(useStore.getState().activeProjectId).toBeNull();
    expect(storage.store[ACTIVE_PROJECT_STORAGE_KEY]).toBeUndefined();
  });

  it('keeps the OLDEST target when one empty project leads to another', async () => {
    const useStore = await seeded();
    useStore.getState().switchProject('p1');

    useStore.getState().switchProject('empty');
    useStore.getState().switchProject('empty2');
    expect(useStore.getState().projectSwitchRollback).toEqual({ to: 'p1' });

    useStore.getState().rollbackProjectSwitch();
    expect(useStore.getState().activeProjectId).toBe('p1');
  });

  it('rollbackProjectSwitch is a no-op with nothing pending — the modal\'s other entry points', async () => {
    const useStore = await seeded();
    useStore.getState().switchProject('p1');

    useStore.getState().rollbackProjectSwitch(); // e.g. cancelling an `n`-opened modal
    expect(useStore.getState().activeProjectId).toBe('p1');
  });

  it('clearProjectSwitchRollback stands the rollback down — a session was created', async () => {
    const useStore = await seeded();
    useStore.getState().switchProject('empty');
    expect(useStore.getState().projectSwitchRollback).not.toBeNull();

    useStore.getState().clearProjectSwitchRollback();
    useStore.getState().rollbackProjectSwitch();
    expect(useStore.getState().activeProjectId).toBe('empty'); // the switch stands
  });

  it('switching to All projects picks no session and clears any pending rollback', async () => {
    const useStore = await seeded();
    useStore.getState().switchProject('p1');

    useStore.getState().switchProject(null);
    expect(useStore.getState().activeProjectId).toBeNull();
    expect(useStore.getState().activeSessionId).toBe('a1'); // untouched
    expect(useStore.getState().newSessionOpen).toBe(false);
    expect(useStore.getState().projectSwitchRollback).toBeNull();
  });

  it('re-picking the project already active does nothing at all', async () => {
    const useStore = await seeded();
    useStore.getState().switchProject('p1');
    useStore.getState().setActiveSessionId('a2'); // the user moved to a later session

    useStore.getState().switchProject('p1');
    expect(useStore.getState().activeSessionId).toBe('a2'); // not yanked back to a1
  });
});
