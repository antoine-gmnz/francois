// sessions slice of the app store. unbound-panes FR-5 deletes split-by-4
// FR-19's swap-on-reassign AND FR-27's dedup-on-reassignment half: both
// `setActiveSessionId` and `reassignActiveSessionId` are now a PLAIN assign —
// a session already showing in another pane is simply duplicated onto pane 0,
// never swapped out of it or dropped from it.

import { beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeEventPayload, RuntimeQueueEntry, SessionMeta } from '../../contract/common';
import { clearQueueState, getQueueEntries, subscribeQueueEntries } from './pi-queue';
import { clearTurnProgress, getCompactionProgress, getRetryProgress } from './pi-turn-progress';
import { useStore } from './store';

function meta(id: string): SessionMeta {
  return {
    id,
    name: id,
    cwd: '/repo',
    model: { id: 'm', label: 'M' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt: 1,
    permissionMode: 'default',
    permissionModeSince: 0,
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    responseMode: 'default',
    allowGit: false,
  };
}

beforeEach(() => {
  useStore.setState({
    sessions: [],
    activeSessionId: null,
    agentTabs: new Map(),
    mainTab: 'session',
    extraPanes: [],
    focusedPaneIndex: 0,
  });
});

describe('setActiveSessionId (unbound-panes FR-5)', () => {
  it('is a PLAIN assign — a pick already showing in another pane is duplicated, never swapped', () => {
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'diff',
      extraPanes: [{ kind: 'session', sessionId: 's2', tab: 'shell' }],
    });
    useStore.getState().setActiveSessionId('s2');
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s2');
    // a built-in tab (diff/shell) is left alone on a switch — only a dynamic
    // agent/workflow tab folds (fix-agent-view FR-8, switchTo's own rule)
    expect(s.mainTab).toBe('diff');
    // the other pane keeps ITS session and tab untouched — no swap
    expect(s.extraPanes).toEqual([{ kind: 'session', sessionId: 's2', tab: 'shell' }]);
  });

  it('re-selecting the already-active session is a pure no-op', () => {
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().setActiveSessionId('s1');
    expect(useStore.getState().mainTab).toBe('diff');
  });
});

describe('reassignActiveSessionId (unbound-panes FR-5, supersedes split-by-4 FR-27 dedup)', () => {
  it('is now IDENTICAL to setActiveSessionId — no swap, no drop, duplicates allowed', () => {
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'diff',
      extraPanes: [{ kind: 'session', sessionId: 's2', tab: 'shell' }],
    });
    useStore.getState().reassignActiveSessionId('s2');
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s2');
    // FR-27's own other half (dropping a REMOVED session from every pane)
    // lives in `removeSession`, not here — this path never touches extraPanes.
    expect(s.extraPanes).toEqual([{ kind: 'session', sessionId: 's2', tab: 'shell' }]);
  });

  it('leaves a dynamic tab on a real switch but KEEPS the outgoing session’s tabs (fix-agent-view FR-8)', () => {
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'agent:a1',
      agentTabs: new Map([['s1', [{ kind: 'agent', id: 'a1', name: 'a', status: 'running' } as const]]]),
    });
    useStore.getState().reassignActiveSessionId('s2');
    // the PANE moves off a tab it no longer holds the session for…
    expect(useStore.getState().mainTab).toBe('session');
    // …but s1's tabs are still there, waiting for you to come back
    expect(useStore.getState().agentTabs.get('s1')).toHaveLength(1);
  });

  it('keeps the tabs when the id is unchanged', () => {
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'agent:a1',
      agentTabs: new Map([['s1', [{ kind: 'agent', id: 'a1', name: 'a', status: 'running' } as const]]]),
    });
    useStore.getState().reassignActiveSessionId('s1');
    expect(useStore.getState().agentTabs.get('s1')).toHaveLength(1);
    expect(useStore.getState().mainTab).toBe('agent:a1');
  });

  it('accepts null when the last session goes away, leaving a built-in tab alone', () => {
    useStore.setState({ sessions: [meta('s1')], activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().reassignActiveSessionId(null);
    expect(useStore.getState().activeSessionId).toBeNull();
    expect(useStore.getState().mainTab).toBe('diff');
  });
});

// multi-provider-seam FR-11a: the frontend gains NO state for `agentRuntime`/
// `protocol` — they are carried fields, set by the core at session_create and
// never re-derived here. Nothing in src reads them (the capability table has
// no frontend consumer), so the only way it can break is a store mutation that
// rebuilds a SessionMeta field-by-field instead of spreading it. That is what
// these lock.
describe('SessionMeta.agentRuntime/protocol are carried through the cache (multi-provider-seam FR-11a)', () => {
  function full(
    id: string,
    agentRuntime: SessionMeta['agentRuntime'],
    protocol: SessionMeta['protocol'],
  ): SessionMeta {
    return {
      id,
      name: id,
      cwd: '/repo',
      model: { id: 'm', label: 'M' },
      status: 'idle',
      contextUsedTokens: 0,
      contextLimitTokens: 0,
      startedAt: 0,
      lastActivityAt: 1,
      permissionMode: 'default',
      permissionModeSince: 0,
      runtime: 'native',
      accountId: 'default',
      agentRuntime,
      protocol,
      responseMode: 'default',
      allowGit: false,
    };
  }

  it('survives every in-place patch (status / error / usage)', () => {
    useStore.getState().setSessions([full('s1', 'claude-code', 'anthropic')]);
    useStore.getState().patchStatus('s1', 'running');
    useStore.getState().patchError('s1', 'boom');
    useStore.getState().patchUsage('s1', 10, 100);
    const s = useStore.getState().sessions[0];
    expect(s.agentRuntime).toBe('claude-code');
    expect(s.protocol).toBe('anthropic');
    expect(s.status).toBe('running');
  });

  it('upsertSession adopts the incoming meta’s agentRuntime/protocol rather than pinning one', () => {
    useStore.getState().setSessions([full('s1', 'claude-code', 'anthropic')]);
    // A meta the core sent for a session created against an endpoint account —
    // the frontend must carry it verbatim, not map it back to 'claude-code'.
    useStore.getState().upsertSession(full('s1', 'francois', 'openai'));
    expect(useStore.getState().sessions).toHaveLength(1);
    expect(useStore.getState().sessions[0].agentRuntime).toBe('francois');
    expect(useStore.getState().sessions[0].protocol).toBe('openai');
    useStore.getState().upsertSession(full('s2', 'francois', 'openai'));
    expect(useStore.getState().sessions.map((x) => x.agentRuntime)).toEqual(['francois', 'francois']);
    expect(useStore.getState().sessions.map((x) => x.protocol)).toEqual(['openai', 'openai']);
  });
});

describe('runtime events (pi-runtime-boundary FR-4/FR-5/FR-6)', () => {
  it('applies a matching-generation capability snapshot and sanitized failure', () => {
    const session = { ...meta('s1'), agentRuntime: 'pi' as const, protocol: null, runtimeGeneration: 'g1' };
    useStore.getState().setSessions([session]);
    useStore.getState().applyRuntimeEvent({
      type: 'runtime.event', sessionId: 's1', generation: 'g1', sequence: 1, at: 1,
      event: { kind: 'capabilities', capabilities: { mcp: { available: false, reason: 'not installed' } } as never },
    });
    expect(useStore.getState().sessions[0].effectiveCapabilities?.mcp).toEqual({ available: false, reason: 'not installed' });
    useStore.getState().applyRuntimeEvent({
      type: 'runtime.event', sessionId: 's1', generation: 'g1', sequence: 2, at: 2,
      event: { kind: 'failure', failure: { origin: 'runtime', code: 'RUNTIME_EXITED', message: 'Child exited.', retryable: true, requestId: 'safe-id' } },
    });
    expect(useStore.getState().sessions[0].errorMessage).toBe('Child exited.');
  });

  it('does not let an old child generation mutate a reconnected session', () => {
    useStore.getState().setSessions([{ ...meta('s1'), agentRuntime: 'pi', protocol: null, runtimeGeneration: 'g2' }]);
    useStore.getState().applyRuntimeEvent({
      type: 'runtime.event', sessionId: 's1', generation: 'g1', sequence: 9, at: 1,
      event: { kind: 'run.state', state: 'failed' },
    });
    expect(useStore.getState().sessions[0].status).toBe('idle');
  });

  it.each<RuntimeEventPayload>([
    { kind: 'message.user', blockId: 'b1', text: 'hi', attachments: [] },
    { kind: 'assistant.delta', blockId: 'b1', contentIndex: 0, text: 'hi', offset: 0 },
    { kind: 'assistant.complete', blockId: 'b1', text: 'hi', outcome: 'complete' },
    { kind: 'tool.update', blockId: 'b1', tool: { id: 't1', name: 'Read', status: 'pending', inputText: '', outputText: '', inputTruncated: false, outputTruncated: false } },
    { kind: 'notice', blockId: 'b1', tone: 'info', text: 'hi' },
  ])('preserves the sessions array reference for transcript kind $kind', (event) => {
    const session = { ...meta('s1'), agentRuntime: 'pi' as const, protocol: null, runtimeGeneration: 'g1' };
    useStore.getState().setSessions([session]);
    const before = useStore.getState().sessions;
    useStore.getState().applyRuntimeEvent({
      type: 'runtime.event', sessionId: 's1', generation: 'g1', sequence: 1, at: 1,
      event,
    });
    expect(useStore.getState().sessions).toBe(before);
  });
});

// frontend fix loop: the `default` arm's compile-time `never` exhaustiveness
// check used to `return unhandled` — the raw runtime payload OBJECT — straight
// into the zustand updater, which merges whatever it returns into ROOT state.
// A future core emitting a kind this build's union does not know about must
// never let its fields land on the store root.
describe('applyRuntimeEvent — an unrecognised future event kind (defect: bare `never` arm)', () => {
  it('drops the unknown payload instead of merging its fields into store state', () => {
    useStore.getState().setSessions([meta('s1')]);
    const beforeKeys = Object.keys(useStore.getState()).sort();
    const beforeSessions = useStore.getState().sessions;
    // Cast through `unknown` — the type system rightly refuses this at the
    // call site; a real occurrence would arrive from an older webview talking
    // to a newer core, not from TypeScript-checked code in this repo.
    const bogus = { kind: 'session.renamed', sessions: 'CLOBBERED' } as unknown as RuntimeEventPayload;
    useStore.getState().applyRuntimeEvent({
      type: 'runtime.event', sessionId: 's1', generation: 'g1', sequence: 1, at: 1,
      event: bogus,
    });
    const after = useStore.getState();
    expect(Object.keys(after).sort()).toEqual(beforeKeys);
    expect(after.sessions).toBe(beforeSessions);
    expect((after as unknown as Record<string, unknown>).kind).toBeUndefined();
  });
});

describe('runtime events — model.changed / metrics (pi-models-metrics)', () => {
  const descriptor = {
    ref: { providerId: 'anthropic', modelId: 'claude-sonnet-5' },
    displayName: 'Sonnet 5',
    input: ['text' as const],
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    reasoning: true,
    authState: 'verified' as const,
    availability: 'available' as const,
  };

  const metrics = {
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    contextTokens: 84_000,
    contextWindow: 200_000,
    contextBasis: 'reported' as const,
    costUsd: 0.02,
    costBasis: 'estimated' as const,
    measuredAt: 5,
    stale: false,
  };

  it('model.changed replaces model/runtimeModel/effort with the ACCEPTED values', () => {
    const session = { ...meta('s1'), agentRuntime: 'pi' as const, protocol: null, runtimeGeneration: 'g1' };
    useStore.getState().setSessions([session]);
    useStore.getState().applyRuntimeEvent({
      type: 'runtime.event', sessionId: 's1', generation: 'g1', sequence: 1, at: 1,
      event: { kind: 'model.changed', model: descriptor, effort: 'high' },
    });
    const s = useStore.getState().sessions[0];
    expect(s.model.label).toBe('Sonnet 5');
    expect(s.model.descriptor).toEqual(descriptor);
    expect(s.runtimeModel).toEqual(descriptor.ref);
    expect(s.effort).toBe('high');
  });

  it('model.changed with no effort CLEARS a previously set one', () => {
    const session = { ...meta('s1'), agentRuntime: 'pi' as const, protocol: null, runtimeGeneration: 'g1', effort: 'high' };
    useStore.getState().setSessions([session]);
    useStore.getState().applyRuntimeEvent({
      type: 'runtime.event', sessionId: 's1', generation: 'g1', sequence: 1, at: 1,
      event: { kind: 'model.changed', model: descriptor },
    });
    expect(useStore.getState().sessions[0].effort).toBeUndefined();
  });

  it('metrics lands the runtime snapshot verbatim, never synthesized from contextUsedTokens', () => {
    const session = { ...meta('s1'), agentRuntime: 'pi' as const, protocol: null, runtimeGeneration: 'g1' };
    useStore.getState().setSessions([session]);
    useStore.getState().applyRuntimeEvent({
      type: 'runtime.event', sessionId: 's1', generation: 'g1', sequence: 1, at: 1,
      event: { kind: 'metrics', metrics },
    });
    expect(useStore.getState().sessions[0].metrics).toEqual(metrics);
  });

  it('an old generation cannot repaint a reconnected session with either kind', () => {
    const session = { ...meta('s1'), agentRuntime: 'pi' as const, protocol: null, runtimeGeneration: 'g2' };
    useStore.getState().setSessions([session]);
    useStore.getState().applyRuntimeEvent({
      type: 'runtime.event', sessionId: 's1', generation: 'g1', sequence: 1, at: 1,
      event: { kind: 'metrics', metrics },
    });
    expect(useStore.getState().sessions[0].metrics).toBeUndefined();
  });
});

// pi-turn-controls: `queue.changed` / `compaction` / `retry` never touch the
// `sessions` array — they route to their own per-session stores. Those are
// EXTERNAL stores with their own subscribers, so the write may not happen
// inside the zustand updater (an updater must be pure: it is allowed to run
// more than once, and it runs BEFORE the new state is committed).
describe('applyRuntimeEvent — control events route to their own stores (pi-turn-controls)', () => {
  const piSession = (generation: string | undefined = 'g1'): SessionMeta => ({
    ...meta('s1'),
    agentRuntime: 'pi',
    protocol: null,
    runtimeGeneration: generation,
  });

  const entries: RuntimeQueueEntry[] = [
    { clientMessageId: 'c1', state: 'queued', delivery: 'normal', text: 'hi', attachmentIds: [], createdAt: 1 },
  ];

  const control = (event: RuntimeEventPayload, generation = 'g1') =>
    useStore.getState().applyRuntimeEvent({
      type: 'runtime.event', sessionId: 's1', generation, sequence: 1, at: 1, event,
    });

  beforeEach(() => {
    clearQueueState('s1');
    clearTurnProgress('s1');
  });

  it('mirrors the ledger and both progress records on a matching generation', () => {
    useStore.getState().setSessions([piSession()]);
    const before = useStore.getState().sessions;
    control({ kind: 'queue.changed', entries });
    control({ kind: 'compaction', state: 'started', automatic: false });
    control({ kind: 'retry', state: 'waiting', attempt: 2 });
    expect(getQueueEntries('s1')).toEqual(entries);
    expect(getCompactionProgress('s1')?.state).toBe('started');
    expect(getRetryProgress('s1')?.attempt).toBe(2);
    // …without invalidating the fleet cache for every other subscriber.
    expect(useStore.getState().sessions).toBe(before);
  });

  it('refuses a stale generation — an old child must never repaint a reconnected session', () => {
    useStore.getState().setSessions([piSession('g2')]);
    control({ kind: 'queue.changed', entries }, 'g1');
    control({ kind: 'compaction', state: 'started', automatic: false }, 'g1');
    control({ kind: 'retry', state: 'waiting', attempt: 2 }, 'g1');
    expect(getQueueEntries('s1')).toEqual([]);
    expect(getCompactionProgress('s1')).toBeNull();
    expect(getRetryProgress('s1')).toBeNull();
  });

  // The generation-unknown guard, previously untested: a session the fleet
  // cache does not hold (removed, or never hydrated) has no generation to
  // check the event against, and there is nothing that would ever clear a
  // ledger written under an id the cache never knew.
  it('writes nothing for a session the cache does not hold', () => {
    useStore.getState().setSessions([]);
    control({ kind: 'queue.changed', entries });
    control({ kind: 'compaction', state: 'started', automatic: false });
    control({ kind: 'retry', state: 'waiting', attempt: 2 });
    expect(getQueueEntries('s1')).toEqual([]);
    expect(getCompactionProgress('s1')).toBeNull();
    expect(getRetryProgress('s1')).toBeNull();
  });

  // removeSession cleared the ledger from INSIDE the updater, so a queue
  // subscriber ran while zustand still held the pre-removal state and saw the
  // session it was being told to forget.
  it('removeSession clears the ledger only after the session is gone from the cache', () => {
    useStore.getState().setSessions([piSession()]);
    control({ kind: 'queue.changed', entries });
    let sessionsSeenByLedgerSubscriber: string[] | null = null;
    const unsubscribe = subscribeQueueEntries('s1', () => {
      sessionsSeenByLedgerSubscriber = useStore.getState().sessions.map((s) => s.id);
    });
    useStore.getState().removeSession('s1');
    unsubscribe();
    expect(getQueueEntries('s1')).toEqual([]);
    expect(sessionsSeenByLedgerSubscriber).toEqual([]);
  });
});

// pi-session-durability: `recovery` rides on the ordinary full-snapshot
// session.meta event, so upsertSession is where it has to land — and where a
// refused Retry's otherwise-identical republish has to bail, same convention
// as patchStatus/patchError/patchUsage below.
describe('upsertSession and RuntimeRecovery (pi-session-durability)', () => {
  function withRecovery(id: string, recovery: SessionMeta['recovery']): SessionMeta {
    return { ...meta(id), agentRuntime: 'pi', protocol: null, recovery };
  }

  it('lands a fresh recovery state onto the cached session', () => {
    useStore.getState().setSessions([meta('s1')]);
    useStore.getState().upsertSession(withRecovery('s1', { state: 'missing', message: 'native session file is missing' }));
    expect(useStore.getState().sessions[0].recovery).toEqual({ state: 'missing', message: 'native session file is missing' });
  });

  it('keeps the sessions array reference when a retry republishes the SAME recovery', () => {
    const session = withRecovery('s1', { state: 'missing', message: 'native session file is missing' });
    useStore.getState().setSessions([session]);
    const before = useStore.getState().sessions;
    useStore.getState().upsertSession({ ...session });
    expect(useStore.getState().sessions).toBe(before);
  });

  it('replaces the entry when recovery actually changes (e.g. a successful reconnect)', () => {
    const session = withRecovery('s1', { state: 'missing', message: 'native session file is missing' });
    useStore.getState().setSessions([session]);
    const before = useStore.getState().sessions;
    useStore.getState().upsertSession({ ...session, recovery: { state: 'ready' } });
    expect(useStore.getState().sessions).not.toBe(before);
    expect(useStore.getState().sessions[0].recovery).toEqual({ state: 'ready' });
  });

  it('a successful newFrom appends a DISTINCT session, leaving the source session untouched', () => {
    const source = withRecovery('s1', { state: 'missing', message: 'native session file is missing' });
    useStore.getState().setSessions([source]);
    const created = withRecovery('s2', { state: 'ready' });
    useStore.getState().upsertSession(created);
    const sessions = useStore.getState().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toEqual(source);
    expect(sessions[1]).toEqual(created);
  });
});

// The `upsertSession` no-op guard used to compare `JSON.stringify` of both
// sides, which answers "changed" for the same payload written in a different
// field order — and serialises two whole SessionMetas on the hottest event in
// the app before it can find the first difference. `deepEqual` replaces it.
describe('upsertSession no-op guard is structural, not textual', () => {
  it('keeps the sessions array reference when the SAME meta arrives with its keys in another order', () => {
    const cached = meta('s1');
    useStore.getState().setSessions([cached]);
    const before = useStore.getState().sessions;
    // Same 20 fields, written back-to-front — exactly what a serde-built
    // snapshot and a store-built spread can differ by.
    const reordered = Object.fromEntries(Object.entries(cached).reverse()) as SessionMeta;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(cached));
    useStore.getState().upsertSession(reordered);
    expect(useStore.getState().sessions).toBe(before);
  });

  it('still replaces the entry on a NESTED change the top-level fields hide', () => {
    const cached: SessionMeta = { ...meta('s1'), model: { id: 'm', label: 'M', brief: '200K context' } };
    useStore.getState().setSessions([cached]);
    const before = useStore.getState().sessions;
    useStore.getState().upsertSession({ ...cached, model: { id: 'm', label: 'M', brief: '1M context' } });
    expect(useStore.getState().sessions).not.toBe(before);
    expect(useStore.getState().sessions[0].model.brief).toBe('1M context');
  });

  it('reads an explicitly-undefined field as absent, as the JSON comparison did', () => {
    useStore.getState().setSessions([meta('s1')]);
    const before = useStore.getState().sessions;
    // What `applyRuntimeEvent`'s model.changed arm writes when the accepted
    // model reports no effort level — the wire snapshot simply omits the key.
    useStore.getState().upsertSession({ ...meta('s1'), effort: undefined });
    expect(useStore.getState().sessions).toBe(before);
  });
});

// Perf guard (fix-bug-on-too-many-sessions): a patch that changes nothing must
// not mint a new `sessions` array — the array reference is what every
// whole-array subscriber (App, Sidebar, UsageMeters) keys its re-render on, and
// duplicate status/usage events arrive at event-stream cadence once several
// sessions run at once. A REAL patch must replace only the touched entry, so
// per-session `find` selectors stay reference-stable for the others.
describe('patchStatus/patchError/patchUsage no-op bails', () => {
  it('keeps the sessions array reference on a duplicate patch (status / error / usage)', () => {
    useStore.getState().setSessions([meta('s1')]);
    useStore.getState().patchStatus('s1', 'running');
    useStore.getState().patchError('s1', 'boom');
    useStore.getState().patchUsage('s1', 10, 100);
    const before = useStore.getState().sessions;
    useStore.getState().patchStatus('s1', 'running');
    useStore.getState().patchError('s1', 'boom');
    useStore.getState().patchUsage('s1', 10, 100);
    expect(useStore.getState().sessions).toBe(before);
  });

  it('keeps the sessions array reference when the id matches no session', () => {
    useStore.getState().setSessions([meta('s1')]);
    const before = useStore.getState().sessions;
    useStore.getState().patchStatus('ghost', 'running');
    useStore.getState().patchError('ghost', 'boom');
    useStore.getState().patchUsage('ghost', 10, 100);
    expect(useStore.getState().sessions).toBe(before);
  });

  it('a real patch replaces only the touched entry — the sibling keeps its reference', () => {
    useStore.getState().setSessions([meta('s1'), meta('s2')]);
    const s2Before = useStore.getState().sessions[1];
    useStore.getState().patchStatus('s1', 'running');
    useStore.getState().patchUsage('s1', 10, 100);
    expect(useStore.getState().sessions[0].status).toBe('running');
    expect(useStore.getState().sessions[0].contextUsedTokens).toBe(10);
    expect(useStore.getState().sessions[1]).toBe(s2Before);
  });

  it('a duplicate usage patch does not restamp lastActivityAt', () => {
    useStore.getState().setSessions([meta('s1')]);
    useStore.getState().patchUsage('s1', 10, 100);
    const stamped = useStore.getState().sessions[0].lastActivityAt;
    useStore.getState().patchUsage('s1', 10, 100);
    expect(useStore.getState().sessions[0].lastActivityAt).toBe(stamped);
  });
});
