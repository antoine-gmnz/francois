import { describe, expect, it, vi } from 'vitest';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { Result } from '../../../contract/common';
import { hydrateBuffer, initHydrationBuffer, routeIncoming, startHydratedSubscription } from './useHydratedSubscription';

// The hook itself is a thin useEffect wrapper (no DOM renderer is wired in this
// project's vitest setup); this file proves the pure buffer/drain engine that
// is the actual duplicated logic across ConversationView/AgentsPanel/SkillsPanel.

describe('initHydrationBuffer', () => {
  it('starts unhydrated with an empty buffer', () => {
    expect(initHydrationBuffer()).toEqual({ hydrated: false, buffer: [] });
  });
});

describe('routeIncoming', () => {
  it('buffers by default while unhydrated (ConversationView\'s shape)', () => {
    const s0 = initHydrationBuffer<string>();
    const r1 = routeIncoming(s0, 'a');
    expect(r1.applyNow).toBe(false);
    expect(r1.next.buffer).toEqual(['a']);
    const r2 = routeIncoming(r1.next, 'b');
    expect(r2.applyNow).toBe(false);
    expect(r2.next.buffer).toEqual(['a', 'b']); // FIFO order preserved
  });

  it('applies immediately once hydrated', () => {
    const hydrated = { hydrated: true, buffer: [] };
    const r = routeIncoming(hydrated, 'a');
    expect(r.applyNow).toBe(true);
    expect(r.next).toBe(hydrated); // unchanged — nothing to buffer
  });

  it('does not mutate the input state', () => {
    const s0 = initHydrationBuffer<string>();
    routeIncoming(s0, 'a');
    expect(s0.buffer).toEqual([]);
  });

  it('a shouldBuffer predicate can let specific events bypass buffering (AgentsPanel\'s agent.step)', () => {
    type E = { kind: 'update' | 'step'; id: number };
    const shouldBuffer = (e: E) => e.kind === 'update';
    const s = initHydrationBuffer<E>();

    const stepEvent: E = { kind: 'step', id: 1 };
    const r1 = routeIncoming(s, stepEvent, shouldBuffer);
    expect(r1.applyNow).toBe(true); // steps always apply live, even pre-hydration
    expect(r1.next.buffer).toEqual([]); // never buffered

    const updateEvent: E = { kind: 'update', id: 2 };
    const r2 = routeIncoming(s, updateEvent, shouldBuffer);
    expect(r2.applyNow).toBe(false);
    expect(r2.next.buffer).toEqual([updateEvent]);
  });

  it('a shouldBuffer that always returns false never buffers (SkillsPanel\'s shape)', () => {
    const s0 = initHydrationBuffer<string>();
    const r = routeIncoming(s0, 'a', () => false);
    expect(r.applyNow).toBe(true);
    expect(r.next.buffer).toEqual([]);
  });
});

describe('hydrateBuffer', () => {
  it('flips hydrated and drains the buffer in arrival order', () => {
    const s = { hydrated: false, buffer: ['a', 'b', 'c'] };
    const { next, drained } = hydrateBuffer(s);
    expect(next.hydrated).toBe(true);
    expect(next.buffer).toEqual([]);
    expect(drained).toEqual(['a', 'b', 'c']);
  });

  it('drains an empty buffer to an empty array', () => {
    const { drained } = hydrateBuffer(initHydrationBuffer<string>());
    expect(drained).toEqual([]);
  });

  it('does not mutate the input state', () => {
    const s = { hydrated: false, buffer: ['a'] };
    hydrateBuffer(s);
    expect(s.buffer).toEqual(['a']);
    expect(s.hydrated).toBe(false);
  });

  it('a full mount → buffer → hydrate → drain cycle preserves order end to end', () => {
    let s = initHydrationBuffer<number>();
    const applied: number[] = [];
    const apply = (n: number) => applied.push(n);

    for (const e of [1, 2, 3]) {
      const r = routeIncoming(s, e);
      s = r.next;
      if (r.applyNow) apply(e);
    }
    expect(applied).toEqual([]); // all buffered — not yet hydrated

    const { next, drained } = hydrateBuffer(s);
    s = next;
    for (const e of drained) apply(e);
    expect(applied).toEqual([1, 2, 3]);

    // A live event after hydration applies immediately, not through the buffer.
    const r4 = routeIncoming(s, 4);
    if (r4.applyNow) apply(4);
    expect(applied).toEqual([1, 2, 3, 4]);
    expect(r4.next.buffer).toEqual([]);
  });
});

describe('startHydratedSubscription', () => {
  // A controllable subscribe/fetch pair: `emit` plays a backend event, and each
  // promise resolves only when the test says so, so the order the two IPC calls
  // complete in is the thing under test.
  function harness() {
    const applied: string[] = [];
    const seeded: string[][] = [];
    const errors: string[] = [];
    let emit: (e: string) => void = () => {};
    let resolveSubscribe: () => void = () => {};
    let resolveFetch: (res: Result<string[]>) => void = () => {};
    const unlisten = vi.fn();
    const fetchInitial = vi.fn(
      () =>
        new Promise<Result<string[]>>((r) => {
          resolveFetch = r;
        }),
    );
    const stop = startHydratedSubscription<string, string[]>({
      subscribe: (cb) =>
        new Promise<UnlistenFn>((r) => {
          emit = cb;
          resolveSubscribe = () => r(unlisten);
        }),
      fetchInitial,
      isRelevant: () => true,
      onHydrated: (blocks) => seeded.push(blocks),
      onEvent: (e) => applied.push(e),
      onError: (m) => errors.push(m),
    });
    return {
      applied,
      seeded,
      errors,
      fetchInitial,
      unlisten,
      stop,
      emit: (e: string) => emit(e),
      resolveSubscribe: () => resolveSubscribe(),
      resolveFetch: (data: string[]) => resolveFetch({ ok: true, data }),
      failFetch: (message: string) => resolveFetch({ ok: false, error: { code: 'INTERNAL', message } }),
    };
  }

  it('does not fetch the snapshot until the subscription is live', async () => {
    // The window this closes: a snapshot taken before the listener exists misses
    // every event emitted in between, and nothing ever replays them.
    const h = harness();
    await Promise.resolve();
    expect(h.fetchInitial).not.toHaveBeenCalled();

    h.resolveSubscribe();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.fetchInitial).toHaveBeenCalledTimes(1);
  });

  it('drains events that arrived while the snapshot was in flight, after the seed', async () => {
    const h = harness();
    h.resolveSubscribe();
    await Promise.resolve();
    await Promise.resolve();

    h.emit('a'); // buffered — the seed has not landed yet
    h.emit('b');
    expect(h.applied).toEqual([]);

    h.resolveFetch(['snapshot']);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.seeded).toEqual([['snapshot']]);
    expect(h.applied).toEqual(['a', 'b']); // arrival order, after the seed

    h.emit('c'); // hydrated — applies live
    expect(h.applied).toEqual(['a', 'b', 'c']);
  });

  it('unlistens a subscription that resolves after teardown, and never fetches', async () => {
    const h = harness();
    h.stop();
    h.resolveSubscribe();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
    expect(h.fetchInitial).not.toHaveBeenCalled();
  });

  it('reports a failed snapshot without hydrating', async () => {
    const h = harness();
    h.resolveSubscribe();
    await Promise.resolve();
    await Promise.resolve();
    h.failFetch('no such session');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.errors).toEqual(['no such session']);
    expect(h.seeded).toEqual([]);
  });
});
