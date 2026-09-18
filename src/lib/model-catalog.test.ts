import { describe, it, expect, vi } from 'vitest';
import { createModelCatalogController, reconcileCatalogModel } from './model-catalog';
import type { ModelCatalog, SessionModelsResponse } from '../../contract/session-engine';
const catalog = (accountId = 'A', ids = ['first', 'preferred']): ModelCatalog => ({ accountId, agentRuntime: 'codex', models: ids.map(id => ({ id, label: id, efforts: ['ultra', 'future'], defaultEffort: 'ultra' })), defaultModelId: ids[1] ?? null, source: 'codex-app-server', freshness: 'fresh', fetchedAt: 1, warning: null });
const deferred = () => { let resolve!: (r: SessionModelsResponse) => void; return { promise: new Promise<SessionModelsResponse>(r => { resolve = r; }), resolve: (r: SessionModelsResponse) => resolve(r) }; };
describe('account catalog controller', () => {
  it('clears on rekey and drops late account responses', async () => {
    const a = deferred(); const b = deferred(); const fetch = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const c = createModelCatalogController(fetch); const pa = c.load('A'); const pb = c.load('B');
    expect(c.getState().catalog).toBeNull(); b.resolve({ ok: true, data: catalog('B') }); await pb;
    a.resolve({ ok: true, data: catalog('A') }); await pa; expect(c.getState().catalog?.accountId).toBe('B');
  });
  it('retains same-account draft reconciliation using the latest choice and advertised default', () => {
    expect(reconcileCatalogModel('preferred', catalog())).toBe('preferred');
    expect(reconcileCatalogModel('missing', catalog())).toBe('preferred');
    expect(reconcileCatalogModel('missing', catalog('A', []))).toBe('');
  });
  it('keeps rows during refresh, joins duplicate refresh and clears unusable rows on failure', async () => {
    const d = deferred(); const fetch = vi.fn().mockResolvedValueOnce({ ok: true, data: catalog() }).mockReturnValueOnce(d.promise);
    const c = createModelCatalogController(fetch); await c.load('A'); const p = c.load('A', true); void c.load('A', true);
    expect(c.getState().catalog?.models).toHaveLength(2); expect(fetch).toHaveBeenCalledTimes(2);
    d.resolve({ ok: false, error: { code: 'ACCOUNT_NOT_AUTHENTICATED', message: 'Sign in' } }); await p;
    expect(c.getState().catalog).toBeNull(); expect(c.getState().error?.message).toBe('Sign in');
  });
  it('preserves stale metadata and arbitrary efforts and handles rejection', async () => {
    const stale = { ...catalog(), source: 'memory-cache' as const, freshness: 'stale' as const, warning: { code: 'INTERNAL' as const, message: 'Offline' } };
    const c = createModelCatalogController(vi.fn().mockResolvedValueOnce({ ok: true, data: stale }).mockRejectedValueOnce(new Error('secret')));
    await c.load('A'); expect(c.getState().catalog).toEqual(stale); await c.load('A', true);
    expect(c.getState().error?.message).toBe("Couldn't load models"); expect(c.getState().loading).toBe(false);
  });
  it('isolates two simultaneous consumers even when they share the same account', async () => {
    const a = deferred(); const b = deferred();
    const fetch = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = createModelCatalogController(fetch); const second = createModelCatalogController(fetch);
    const pa = first.load('A'); const pb = second.load('A'); first.cancel();
    b.resolve({ ok: true, data: catalog() }); await pb;
    a.resolve({ ok: true, data: catalog() }); await pa;
    expect(first.getState().catalog).toBeNull(); expect(second.getState().catalog?.accountId).toBe('A');
  });
  it('announces loading after 150ms and cancels late writes', async () => {
    vi.useFakeTimers(); const d = deferred(); const c = createModelCatalogController(() => d.promise); const p = c.load('A');
    expect(c.getState().showLoading).toBe(false); vi.advanceTimersByTime(150); expect(c.getState().showLoading).toBe(true);
    c.cancel(); d.resolve({ ok: true, data: catalog() }); await p; expect(c.getState().catalog).toBeNull(); vi.useRealTimers();
  });
});
