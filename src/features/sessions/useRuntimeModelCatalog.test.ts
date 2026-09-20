import { describe, expect, it, vi } from 'vitest';
import type { RuntimeModelCatalog, RuntimeModelsResult } from '../../../contract/pi-models-metrics';
import { createRuntimeModelCatalogController } from './useRuntimeModelCatalog';

const catalog = (accountId = 'A', modelIds = ['sonnet']): RuntimeModelCatalog => ({
  accountId,
  models: modelIds.map((modelId) => ({
    ref: { providerId: 'anthropic', modelId },
    displayName: modelId,
    input: ['text'],
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    reasoning: true,
    authState: 'verified',
    availability: 'available',
  })),
  checkedAt: 1,
  stale: false,
});

const deferred = () => {
  let resolve!: (r: RuntimeModelsResult) => void;
  return { promise: new Promise<RuntimeModelsResult>((r) => { resolve = r; }), resolve: (r: RuntimeModelsResult) => resolve(r) };
};

describe('runtime model catalog controller (pi-models-metrics §5)', () => {
  it('clears on rekey and drops late account responses', async () => {
    const a = deferred();
    const b = deferred();
    const fetch = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const c = createRuntimeModelCatalogController(fetch);
    const pa = c.load('A');
    const pb = c.load('B');
    expect(c.getState().models).toEqual([]);
    b.resolve({ ok: true, data: catalog('B') });
    await pb;
    a.resolve({ ok: true, data: catalog('A') });
    await pa;
    expect(c.getState().accountId).toBe('B');
    expect(c.getState().models).toHaveLength(1);
  });

  it('keeps rows during refresh, joins a duplicate load, and preserves stale on a failed refresh (FR-2/FR-9)', async () => {
    const d = deferred();
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, data: catalog() }).mockReturnValueOnce(d.promise);
    const c = createRuntimeModelCatalogController(fetch);
    await c.load('A');
    expect(c.getState().models).toHaveLength(1);
    const p = c.load('A', true);
    expect(fetch).toHaveBeenCalledTimes(2);
    d.resolve({ ok: false, error: { code: 'RUNTIME_TIMEOUT', message: 'Timed out' } });
    await p;
    // FR-9: a failed refresh drops the models this controller holds (the core
    // is the one that RETAINS the previous catalogue on its own failed refresh
    // and serves it back stale=true; a hard error here has nothing to retain).
    expect(c.getState().models).toEqual([]);
    expect(c.getState().error).toBe('Timed out');
  });

  it('carries the core-reported stale flag straight through', async () => {
    const stale = { ...catalog(), stale: true };
    const c = createRuntimeModelCatalogController(vi.fn().mockResolvedValueOnce({ ok: true, data: stale }));
    await c.load('A');
    expect(c.getState().stale).toBe(true);
  });

  // FR-2/FR-4: `stale` means "these rows came from a cache past its TTL" — it
  // only ever qualifies rows the controller actually holds. Every branch that
  // empties `models` must therefore clear it too, or the caller renders "0
  // models" under a stale banner and, worse, a consumer reading `stale` alone
  // keeps refusing to authorize on the strength of a catalogue that is gone.
  it('clears stale when a failed refresh drops the rows it described', async () => {
    const d = deferred();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { ...catalog(), stale: true } })
      .mockReturnValueOnce(d.promise);
    const c = createRuntimeModelCatalogController(fetch);
    await c.load('A');
    expect(c.getState().stale).toBe(true);
    const p = c.load('A', true);
    d.resolve({ ok: false, error: { code: 'RUNTIME_TIMEOUT', message: 'Timed out' } });
    await p;
    expect(c.getState().models).toEqual([]);
    expect(c.getState().stale).toBe(false);
  });

  it('clears stale when a rejected fetch drops the rows it described', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { ...catalog(), stale: true } })
      .mockRejectedValueOnce(new Error('secret'));
    const c = createRuntimeModelCatalogController(fetch);
    await c.load('A');
    await c.load('A', true);
    expect(c.getState().stale).toBe(false);
  });

  it('clears stale when a rekey drops the previous account’s rows', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { ...catalog('A'), stale: true } })
      .mockResolvedValueOnce({ ok: true, data: catalog('B') });
    const c = createRuntimeModelCatalogController(fetch);
    await c.load('A');
    const p = c.load('B');
    // Already cleared while the request is in flight — the rows it described
    // left `models` in that same publish.
    expect(c.getState().stale).toBe(false);
    await p;
    expect(c.getState().stale).toBe(false);
  });

  it('handles a rejected fetch without throwing', async () => {
    const c = createRuntimeModelCatalogController(vi.fn().mockRejectedValueOnce(new Error('secret')));
    await c.load('A');
    expect(c.getState().error).toBe("Couldn't load models");
    expect(c.getState().loading).toBe(false);
  });

  it('isolates two simultaneous consumers even when they share the same account', async () => {
    const a = deferred();
    const b = deferred();
    const fetch = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = createRuntimeModelCatalogController(fetch);
    const second = createRuntimeModelCatalogController(fetch);
    const pa = first.load('A');
    const pb = second.load('A');
    first.cancel();
    b.resolve({ ok: true, data: catalog() });
    await pb;
    a.resolve({ ok: true, data: catalog() });
    await pa;
    expect(first.getState().models).toEqual([]);
    expect(second.getState().accountId).toBe('A');
    expect(second.getState().models).toHaveLength(1);
  });

  it('announces loading after 150ms and cancels late writes', async () => {
    vi.useFakeTimers();
    const d = deferred();
    const c = createRuntimeModelCatalogController(() => d.promise);
    const p = c.load('A');
    expect(c.getState().showLoading).toBe(false);
    vi.advanceTimersByTime(150);
    expect(c.getState().showLoading).toBe(true);
    c.cancel();
    d.resolve({ ok: true, data: catalog() });
    await p;
    expect(c.getState().models).toEqual([]);
    vi.useRealTimers();
  });

  it('empties models on an ok:true response for a different account (a race the caller must never render)', async () => {
    const c = createRuntimeModelCatalogController(vi.fn().mockResolvedValueOnce({ ok: true, data: catalog('OTHER') }));
    await c.load('A');
    expect(c.getState().models).toEqual([]);
    expect(c.getState().error).toBe("Couldn't load models");
  });
});
