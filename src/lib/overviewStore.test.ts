// overview slice of the app store. Covers the wiring the pure helpers in
// contract/overview.ts cannot: the derived-map guards (FR-8/FR-9), the activity
// ring buffer (FR-27), the session.error capture that feeds FR-28's detail and
// FR-17's NEEDS ATTENTION line, and the FR-3 initial-tab choice.
//
// The spec marks FR-3 as "only a run of the app exercises this" — that is wrong:
// projectsStore.test.ts already establishes that a module re-import with a mocked
// localStorage tests exactly this, no DOM required.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../contract/common';
import { ACTIVE_PROJECT_STORAGE_KEY } from '../../contract/projects';

function mockStorage(seed: Record<string, string> = {}): void {
  const store = { ...seed };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  });
}

async function freshStore() {
  vi.resetModules();
  const mod = await import('./store');
  return mod.useStore;
}

function sess(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    name: id,
    cwd: 'D:/x',
    model: { id: 'm', label: 'M' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 1000,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    ...over,
  };
}

describe('overview store slice', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  // ---------- FR-3: which tab the app opens on ----------

  it('opens on OVERVIEW when no project is scoped, and on SESSION when one is', async () => {
    mockStorage();
    expect((await freshStore()).getState().mainTab).toBe('overview');

    mockStorage({ [ACTIVE_PROJECT_STORAGE_KEY]: 'p1' });
    expect((await freshStore()).getState().mainTab).toBe('session');
  });

  // ---------- FR-8/FR-9: the derived map ----------

  it('mergeDerived ignores a session that is not in the cache', async () => {
    mockStorage();
    const useStore = await freshStore();
    // fleet-board FR-7: a late diff/agent resolution for a removed session must
    // not leak its entry back in.
    useStore.getState().mergeDerived('ghost', { fileCount: 3 });
    expect(useStore.getState().derived.has('ghost')).toBe(false);
  });

  it('mergeDerived seeds defaults and merges partials for a cached session', async () => {
    mockStorage();
    const useStore = await freshStore();
    useStore.getState().setSessions([sess('s1')]);

    useStore.getState().mergeDerived('s1', { fileCount: 2 });
    expect(useStore.getState().derived.get('s1')).toEqual({ fileCount: 2, runningAgentCount: 0, addedLines: null, deletedLines: null });

    useStore.getState().mergeDerived('s1', { runningAgentCount: 5 });
    expect(useStore.getState().derived.get('s1')).toEqual({ fileCount: 2, runningAgentCount: 5, addedLines: null, deletedLines: null });
  });

  it('mergeDerived keeps the SAME map reference for a no-op merge', async () => {
    mockStorage();
    const useStore = await freshStore();
    useStore.getState().setSessions([sess('s1')]);
    useStore.getState().mergeDerived('s1', { fileCount: 1, runningAgentCount: 1 });

    const before = useStore.getState().derived;
    // agent.update fires per subagent STEP and the count usually has not moved.
    // A new Map here would re-run every OVERVIEW memo on each step.
    useStore.getState().mergeDerived('s1', { runningAgentCount: 1 });
    expect(useStore.getState().derived).toBe(before);

    // ...but a real change still produces a new reference
    useStore.getState().mergeDerived('s1', { runningAgentCount: 2 });
    expect(useStore.getState().derived).not.toBe(before);
  });

  it('dropDerived removes an entry and no-ops for an unknown id', async () => {
    mockStorage();
    const useStore = await freshStore();
    useStore.getState().setSessions([sess('s1')]);
    useStore.getState().mergeDerived('s1', { fileCount: 1 });

    useStore.getState().dropDerived('s1');
    expect(useStore.getState().derived.has('s1')).toBe(false);

    const before = useStore.getState().derived;
    useStore.getState().dropDerived('nobody');
    expect(useStore.getState().derived).toBe(before);
  });

  // ---------- FR-28: the error message the feed and NEEDS ATTENTION need ----------

  it('patchError records the failure message onto the cached session', async () => {
    mockStorage();
    const useStore = await freshStore();
    useStore.getState().setSessions([sess('s1'), sess('s2')]);

    // The engine emits session.error BEFORE session.status and never a fresh
    // session.meta, so this is the only path by which the message reaches the
    // cache — without it every live error renders as "session failed".
    useStore.getState().patchError('s1', 'spawn failed: claude not found');
    expect(useStore.getState().sessions.find((s) => s.id === 's1')?.errorMessage).toBe(
      'spawn failed: claude not found',
    );
    expect(useStore.getState().sessions.find((s) => s.id === 's2')?.errorMessage).toBeUndefined();
  });

  it('the message is in place before the status transition reads it', async () => {
    mockStorage();
    const useStore = await freshStore();
    useStore.getState().setSessions([sess('s1', { status: 'running' })]);

    // real event order: session.error, then session.status
    useStore.getState().patchError('s1', 'boom');
    const prev = useStore.getState().sessions.find((s) => s.id === 's1');
    useStore.getState().patchStatus('s1', 'error');

    expect(prev?.errorMessage).toBe('boom');
    expect(useStore.getState().sessions[0].status).toBe('error');
  });

  // ---------- FR-27: the activity ring buffer ----------

  it('recordActivity prepends newest-first and caps the buffer', async () => {
    mockStorage();
    const useStore = await freshStore();

    for (let i = 0; i < 205; i++) {
      useStore.getState().recordActivity({
        at: i,
        kind: 'session.started',
        sessionId: `s${i}`,
        sessionName: `s${i}`,
        detail: '',
      });
    }
    const feed = useStore.getState().activity;
    expect(feed).toHaveLength(200);
    expect(feed[0].sessionId).toBe('s204'); // newest first
    expect(feed[feed.length - 1].sessionId).toBe('s5'); // oldest 5 evicted
  });
});
