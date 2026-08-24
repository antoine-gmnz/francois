// transcript-scale FR-17..22 — the single-listener router.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../../contract/common';

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

const tick = () => new Promise((r) => setTimeout(r, 0));

const statusEvent = (sessionId: string): SessionEvent => ({ type: 'session.status', sessionId, status: 'running' });
const noSessionEvent = (): SessionEvent => ({ type: 'session.removed', sessionId: 'ignored-by-this-fixture' });

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
});
