// transcript-scale FR-17..22 — the single-listener router.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionMeta } from '../../contract/common';

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

const tick = () => new Promise((r) => setTimeout(r, 0));

const statusEvent = (sessionId: string): SessionEvent => ({ type: 'session.status', sessionId, status: 'running' });
const noSessionEvent = (): SessionEvent => ({ type: 'session.removed', sessionId: 'ignored-by-this-fixture' });
const runtimeMeta = (runtimeGeneration?: string): SessionMeta => ({
  id: 's1', name: 'x', cwd: '/repo', model: { id: 'm', label: 'M' }, status: 'idle',
  contextUsedTokens: 0, contextLimitTokens: 0, startedAt: 0, lastActivityAt: 0,
  permissionMode: 'default', permissionModeSince: 0, runtime: 'native', accountId: 'default',
  agentRuntime: 'claude-code', protocol: 'anthropic', allowGit: false, responseMode: 'default', runtimeGeneration,
});
const runtimeEvent = (generation: string, sequence: number): SessionEvent => ({
  type: 'runtime.event', sessionId: 's1', generation, sequence, at: 1,
  event: { kind: 'run.state', state: 'idle' },
});

describe('subscribeSessionEvents (transcript-scale FR-17..20)', () => {
  let sessionHandler: ((e: { payload: SessionEvent }) => void) | undefined;

  beforeEach(() => {
    vi.resetModules();
    sessionHandler = undefined;
    listenMock.mockReset().mockImplementation((channel: string, cb: (e: { payload: unknown }) => void) => {
      if (channel === 'francois://session/event') sessionHandler = cb as (e: { payload: SessionEvent }) => void;
      return Promise.resolve(vi.fn());
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops stale execution events for retired history before any consumer sees them', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    const received = vi.fn();
    await subscribeSessionEvents('s1', received);
    sessionHandler?.({ payload: { type: 'session.meta', meta: { ...runtimeMeta('saved'), agentRuntime: 'pi' } } });
    received.mockClear();
    sessionHandler?.({ payload: statusEvent('s1') });
    sessionHandler?.({ payload: runtimeEvent('saved', 1) });
    expect(received).not.toHaveBeenCalled();
  });

  it('invalidates native request authority on store reset and generation replacement', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    const { useStore } = await import('./store');
    const { requestReplyAvailable } = await import('./request-replies');
    const meta: SessionMeta = { ...runtimeMeta('native'), agentRuntime: 'codex', status: 'running', effectiveCapabilities: { ...(await import('../../contract/multi-provider-seam')).runtimeCapabilities('codex'), permissions: { available: true } } };
    useStore.getState().setSessions([meta]);
    await subscribeSessionEvents('s1', vi.fn());
    sessionHandler?.({ payload: { type: 'question.asked', sessionId: 's1', blockId: 'q', questions: [] } });
    expect(requestReplyAvailable(meta, 'q')).toBe(true);
    useStore.getState().setSessions([]);
    useStore.getState().setSessions([meta]);
    expect(requestReplyAvailable(meta, 'q')).toBe(false);
    sessionHandler?.({ payload: { type: 'question.asked', sessionId: 's1', blockId: 'next', questions: [] } });
    expect(requestReplyAvailable(meta, 'next')).toBe(true);
    useStore.getState().setSessions([{ ...meta, runtimeGeneration: 'replacement' }]);
    useStore.getState().setSessions([meta]);
    expect(requestReplyAvailable(meta, 'next')).toBe(false);
  });

  it('establishes exactly one Tauri listener on the first registration, regardless of how many consumers register (FR-17)', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    void subscribeSessionEvents('s1', vi.fn());
    void subscribeSessionEvents('s2', vi.fn());
    void subscribeSessionEvents('*', vi.fn());
    await tick();
    expect(listenMock.mock.calls.filter((c) => c[0] === 'francois://session/event')).toHaveLength(1);
  });

  it('resolves once the underlying listener is live (FR-18)', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    let resolved = false;
    void subscribeSessionEvents('s1', vi.fn()).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    await tick();
    expect(resolved).toBe(true);
  });

  it('a registration made while the listener is already live resolves immediately (FR-18)', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    await subscribeSessionEvents('s1', vi.fn());
    let resolved = false;
    void subscribeSessionEvents('s2', vi.fn()).then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(true);
  });

  it('a session-scoped handler receives only its own session\'s events (FR-19)', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    const s1Events: SessionEvent[] = [];
    const s2Events: SessionEvent[] = [];
    void subscribeSessionEvents('s1', (e) => s1Events.push(e));
    void subscribeSessionEvents('s2', (e) => s2Events.push(e));
    await tick();
    sessionHandler?.({ payload: statusEvent('s1') });
    expect(s1Events).toHaveLength(1);
    expect(s2Events).toHaveLength(0);
  });

  it('a \'*\' handler receives every session\'s events (FR-19)', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    const all: SessionEvent[] = [];
    void subscribeSessionEvents('*', (e) => all.push(e));
    await tick();
    sessionHandler?.({ payload: statusEvent('s1') });
    sessionHandler?.({ payload: statusEvent('s2') });
    expect(all).toHaveLength(2);
  });

  it('an event with no session id reaches every handler, including session-scoped ones (FR-19)', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    // 'session.commands' etc carry sessionId; use a type this fixture treats as
    // having none by asserting through eventSessionId's own contract: a
    // hand-built event lacking BOTH `sessionId` and `meta` reaches everyone.
    const noId = { type: 'context.usage' } as unknown as SessionEvent;
    const s1Events: SessionEvent[] = [];
    const starEvents: SessionEvent[] = [];
    void subscribeSessionEvents('s1', (e) => s1Events.push(e));
    void subscribeSessionEvents('*', (e) => starEvents.push(e));
    await tick();
    sessionHandler?.({ payload: noId });
    expect(s1Events).toHaveLength(1);
    expect(starEvents).toHaveLength(1);
  });

  it('session.meta routes by meta.id, matching the shared eventSessionId rule (FR-19)', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    const meta = {
      id: 's1',
      name: 'x',
      cwd: '/repo',
      model: { id: 'm', label: 'M' },
      status: 'idle' as const,
      contextUsedTokens: 0,
      contextLimitTokens: 0,
      startedAt: 0,
      lastActivityAt: 0,
      permissionMode: 'default' as const,
      permissionModeSince: 0,
      runtime: 'native' as const,
      accountId: 'default',
      agentRuntime: 'claude-code' as const,
      protocol: 'anthropic' as const,
      responseMode: 'default' as const,
      allowGit: false,
    };
    const s1Events: SessionEvent[] = [];
    const s2Events: SessionEvent[] = [];
    void subscribeSessionEvents('s1', (e) => s1Events.push(e));
    void subscribeSessionEvents('s2', (e) => s2Events.push(e));
    await tick();
    sessionHandler?.({ payload: { type: 'session.meta', meta } });
    expect(s1Events).toHaveLength(1);
    expect(s2Events).toHaveLength(0);
  });

  it('agent.update routes by agent.sessionId — it must NOT fan out to every open pane (FR-19)', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    const agentUpdate = {
      type: 'agent.update',
      agent: { id: 'a1', sessionId: 's1', name: 'x', task: 't', status: 'running', startedAt: 0, background: false, stepCount: 0 },
    } as unknown as SessionEvent;
    const s1Events: SessionEvent[] = [];
    const s2Events: SessionEvent[] = [];
    void subscribeSessionEvents('s1', (e) => s1Events.push(e));
    void subscribeSessionEvents('s2', (e) => s2Events.push(e));
    await tick();
    sessionHandler?.({ payload: agentUpdate });
    expect(s1Events).toHaveLength(1);
    expect(s2Events).toHaveLength(0);
  });

  it('workflow.update routes by run.sessionId — it must NOT fan out to every open pane (FR-19)', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    const workflowUpdate = {
      type: 'workflow.update',
      run: { id: 'w1', sessionId: 's2', name: 'wf', description: '', status: 'running', startedAt: 0, phases: [] },
    } as unknown as SessionEvent;
    const s1Events: SessionEvent[] = [];
    const s2Events: SessionEvent[] = [];
    void subscribeSessionEvents('s1', (e) => s1Events.push(e));
    void subscribeSessionEvents('s2', (e) => s2Events.push(e));
    await tick();
    sessionHandler?.({ payload: workflowUpdate });
    expect(s1Events).toHaveLength(0);
    expect(s2Events).toHaveLength(1);
  });

  it('a handler that throws is caught and never blocks a later handler (FR-20)', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    const calls: string[] = [];
    void subscribeSessionEvents('s1', () => {
      throw new Error('boom');
    });
    void subscribeSessionEvents('s1', () => calls.push('b'));
    await tick();
    expect(() => sessionHandler?.({ payload: statusEvent('s1') })).not.toThrow();
    expect(calls).toEqual(['b']);
  });

  it('unregistering one handler leaves a sibling scope/handler intact and never tears down the Tauri listener', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    const calls: string[] = [];
    const unsub1 = await subscribeSessionEvents('s1', () => calls.push('a'));
    void subscribeSessionEvents('s1', () => calls.push('b'));
    unsub1();
    sessionHandler?.({ payload: statusEvent('s1') });
    expect(calls).toEqual(['b']);
    // A fresh registration after the unsubscribe still resolves immediately —
    // the underlying listener was never removed (FR-17).
    let resolved = false;
    void subscribeSessionEvents('s2', vi.fn()).then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(true);
    expect(listenMock.mock.calls.filter((c) => c[0] === 'francois://session/event')).toHaveLength(1);
  });

  it('ignores an event scoped to no registered session without throwing', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    void subscribeSessionEvents('s1', vi.fn());
    await tick();
    expect(() => sessionHandler?.({ payload: noSessionEvent() })).not.toThrow();
  });

  it('rejects duplicate, out-of-order, and stale-generation runtime events', async () => {
    const { useStore } = await import('./store');
    useStore.getState().setSessions([runtimeMeta('g1')]);
    const { subscribeSessionEvents } = await import('./session-events');
    const received: SessionEvent[] = [];
    void subscribeSessionEvents('s1', (e) => received.push(e));
    await tick();
    const event = (generation: string, sequence: number): SessionEvent => ({
      type: 'runtime.event', sessionId: 's1', generation, sequence, at: 1,
      event: { kind: 'run.state', state: 'idle' },
    });
    sessionHandler?.({ payload: event('g1', 1) });
    sessionHandler?.({ payload: event('g1', 1) });
    sessionHandler?.({ payload: event('g1', 0) });
    sessionHandler?.({ payload: event('g1', 2) });
    sessionHandler?.({ payload: event('g2', 1) });
    expect(received).toEqual([event('g1', 1), event('g1', 2)]);
  });

  it('rejects stale-first delivery against hydrated metadata without advancing the live cursor', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    const { useStore } = await import('./store');
    const received: SessionEvent[] = [];
    await subscribeSessionEvents('s1', (e) => received.push(e));
    useStore.getState().setSessions([runtimeMeta('live')]);
    sessionHandler?.({ payload: runtimeEvent('stale', 99) });
    sessionHandler?.({ payload: runtimeEvent('live', 1) });
    expect(received).toEqual([runtimeEvent('live', 1)]);
  });

  it('preserves newer metadata and capabilities when a captured g1 list hydrates after g2 metadata', async () => {
    const { subscribeSessionEvents, captureSessionHydration } = await import('./session-events');
    const { useStore } = await import('./store');
    const { runtimeCapabilities } = await import('../../contract/multi-provider-seam');
    const received: SessionEvent[] = [];
    await subscribeSessionEvents('s1', (event) => {
      if (event.type === 'session.meta') useStore.getState().upsertSession(event.meta);
      if (event.type === 'runtime.event') received.push(event);
    });
    const g1 = { ...runtimeMeta('g1'), effectiveCapabilities: runtimeCapabilities('pi') };
    useStore.getState().setSessions([g1]);
    const reconcile = captureSessionHydration();
    const capturedList = [g1];
    const g2 = {
      ...runtimeMeta('g2'),
      effectiveCapabilities: { ...g1.effectiveCapabilities, images: { available: false, reason: 'New model' } },
    };
    sessionHandler?.({ payload: { type: 'session.meta', meta: g2 } });
    useStore.getState().setSessions(reconcile(capturedList));
    expect(useStore.getState().sessions).toEqual([g2]);
    sessionHandler?.({ payload: runtimeEvent('g1', 99) });
    sessionHandler?.({ payload: runtimeEvent('g2', 1) });
    expect(received).toEqual([runtimeEvent('g2', 1)]);
  });

  it('preserves capability narrowing during pending hydration without a metadata event', async () => {
    const { subscribeSessionEvents, captureSessionHydration } = await import('./session-events');
    const { useStore } = await import('./store');
    const { runtimeCapabilities } = await import('../../contract/multi-provider-seam');
    const g1 = { ...runtimeMeta('g1'), effectiveCapabilities: runtimeCapabilities('pi') };
    useStore.getState().setSessions([g1]);
    await subscribeSessionEvents('s1', (event) => {
      if (event.type === 'runtime.event') useStore.getState().applyRuntimeEvent(event);
    });
    const reconcile = captureSessionHydration();
    const capabilities = { ...g1.effectiveCapabilities, images: { available: false, reason: 'Narrowed' } };
    sessionHandler?.({ payload: {
      ...runtimeEvent('g1', 1), type: 'runtime.event', sessionId: 's1', generation: 'g1', sequence: 1, at: 1,
      event: { kind: 'capabilities', capabilities },
    } });
    useStore.getState().setSessions(reconcile([g1]));
    expect(useStore.getState().sessions[0].effectiveCapabilities).toEqual(capabilities);
  });

  it.each(['failure', 'run.state'] as const)('preserves %s arriving before an older list response', async (kind) => {
    const { subscribeSessionEvents, captureSessionHydration } = await import('./session-events');
    const { useStore } = await import('./store');
    const g1 = runtimeMeta('g1');
    useStore.getState().setSessions([g1]);
    await subscribeSessionEvents('s1', (event) => {
      if (event.type === 'runtime.event') useStore.getState().applyRuntimeEvent(event);
    });
    const reconcile = captureSessionHydration();
    sessionHandler?.({ payload: {
      type: 'runtime.event', sessionId: 's1', generation: 'g1', sequence: 1, at: 1,
      event: kind === 'failure'
        ? { kind, failure: { origin: 'runtime', code: 'RUNTIME_EXITED', message: 'Child exited.', retryable: true } }
        : { kind, state: 'failed' },
    } });
    useStore.getState().setSessions(reconcile([g1]));
    if (kind === 'failure') expect(useStore.getState().sessions[0].errorMessage).toBe('Child exited.');
    else expect(useStore.getState().sessions[0].status).toBe('error');
  });

  it('does not restore a session removed during pending hydration', async () => {
    const { subscribeSessionEvents, captureSessionHydration } = await import('./session-events');
    const { useStore } = await import('./store');
    const g1 = runtimeMeta('g1');
    useStore.getState().setSessions([g1]);
    await subscribeSessionEvents('s1', (event) => {
      if (event.type === 'session.removed') useStore.getState().removeSession(event.sessionId);
    });
    const reconcile = captureSessionHydration();
    sessionHandler?.({ payload: { type: 'session.removed', sessionId: 's1' } });
    useStore.getState().setSessions(reconcile([g1]));
    expect(useStore.getState().sessions).toEqual([]);
  });

  it('accepts a reconnected generation from session.meta and retains sequence on repeated metadata', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    const received: SessionEvent[] = [];
    await subscribeSessionEvents('s1', (e) => {
      if (e.type === 'runtime.event') received.push(e);
    });
    sessionHandler?.({ payload: { type: 'session.meta', meta: runtimeMeta('g1') } });
    sessionHandler?.({ payload: runtimeEvent('g1', 7) });
    sessionHandler?.({ payload: { type: 'session.meta', meta: runtimeMeta('g2') } });
    sessionHandler?.({ payload: runtimeEvent('g1', 99) });
    sessionHandler?.({ payload: runtimeEvent('g2', 1) });
    sessionHandler?.({ payload: { type: 'session.meta', meta: runtimeMeta('g2') } });
    sessionHandler?.({ payload: runtimeEvent('g2', 1) });
    sessionHandler?.({ payload: runtimeEvent('g2', 2) });
    expect(received).toEqual([runtimeEvent('g1', 7), runtimeEvent('g2', 1), runtimeEvent('g2', 2)]);
  });

  it('resets sequence for a changed hydrated generation and preserves it for the same generation', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    const { useStore } = await import('./store');
    const received: SessionEvent[] = [];
    await subscribeSessionEvents('s1', (e) => received.push(e));
    useStore.getState().setSessions([runtimeMeta('g1')]);
    sessionHandler?.({ payload: runtimeEvent('g1', 7) });
    useStore.getState().setSessions([runtimeMeta('g2')]);
    sessionHandler?.({ payload: runtimeEvent('g1', 99) });
    sessionHandler?.({ payload: runtimeEvent('g2', 1) });
    useStore.getState().setSessions([runtimeMeta('g2')]);
    sessionHandler?.({ payload: runtimeEvent('g2', 1) });
    sessionHandler?.({ payload: runtimeEvent('g2', 2) });
    useStore.getState().setSessions([]);
    sessionHandler?.({ payload: runtimeEvent('g2', 3) });
    expect(received).toEqual([runtimeEvent('g1', 7), runtimeEvent('g2', 1), runtimeEvent('g2', 2)]);
  });

  it('rejects runtime events before authoritative metadata and after the live generation is cleared', async () => {
    const { subscribeSessionEvents } = await import('./session-events');
    const received: SessionEvent[] = [];
    await subscribeSessionEvents('s1', (e) => {
      if (e.type === 'runtime.event') received.push(e);
    });
    sessionHandler?.({ payload: runtimeEvent('stale', 1) });
    sessionHandler?.({ payload: { type: 'session.meta', meta: runtimeMeta('live') } });
    sessionHandler?.({ payload: runtimeEvent('live', 1) });
    sessionHandler?.({ payload: { type: 'session.meta', meta: runtimeMeta() } });
    sessionHandler?.({ payload: runtimeEvent('live', 2) });
    expect(received).toEqual([runtimeEvent('live', 1)]);
  });
});
