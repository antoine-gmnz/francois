// useModelCatalog's own useEffect is a thin wrapper (no DOM renderer is wired
// in this project's vitest setup); this file proves the framework-free half —
// startModelCatalogFetch — that closes the review round 2 HIGH finding: an
// account switch must drop an out-of-order resolution from the PREVIOUS
// account's request rather than let it overwrite the new account's catalog.

import { describe, expect, it, vi } from 'vitest';
import type { AccountId, ModelInfo, Result } from '../../../contract/common';
import { startModelCatalogFetch } from './useModelCatalog';

const model = (id: string, label: string): ModelInfo => ({ id, label });

function harness() {
  const loading: boolean[] = [];
  const modelsSeen: ModelInfo[][] = [];
  let modelId = '';
  const resolvers = new Map<AccountId, (res: Result<ModelInfo[]>) => void>();

  const fetchModels = vi.fn(
    (accountId: AccountId) =>
      new Promise<Result<ModelInfo[]>>((resolve) => {
        resolvers.set(accountId, resolve);
      }),
  );

  const start = (accountId: AccountId) =>
    startModelCatalogFetch(accountId, fetchModels, {
      setModelsLoading: (v) => loading.push(v),
      setModels: (m) => modelsSeen.push(m),
      setModelId: (updater) => {
        modelId = updater(modelId);
      },
    });

  return {
    loading,
    modelsSeen,
    getModelId: () => modelId,
    start,
    resolve: (accountId: AccountId, models: ModelInfo[]) => {
      const r = resolvers.get(accountId);
      if (!r) throw new Error(`no in-flight request for ${accountId}`);
      r({ ok: true, data: models });
    },
  };
}

describe('startModelCatalogFetch', () => {
  it('applies a single account\'s resolution normally', async () => {
    const h = harness();
    h.start('A');
    h.resolve('A', [model('a1', 'A One')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.modelsSeen).toEqual([[model('a1', 'A One')]]);
    expect(h.getModelId()).toBe('a1');
    expect(h.loading).toEqual([true, false]);
  });

  it('drops a stale resolution that arrives after the account switched, even out of order (HIGH finding)', async () => {
    const h = harness();
    const stopA = h.start('A'); // slow endpoint account round-trip
    stopA(); // account switched away from A before its request settled — mirrors useEffect's cleanup on the next dep change
    h.start('B'); // fast default-account catalog

    // out-of-order: B's request resolves first...
    h.resolve('B', [model('claude-sonnet-5', 'Sonnet 5')]);
    await Promise.resolve();
    await Promise.resolve();

    // ...then A's slow resolution finally lands, after B is already current.
    h.resolve('A', [model('gpt-4o', 'GPT-4o')]);
    await Promise.resolve();
    await Promise.resolve();

    // Only B's catalog and selection ever reached state — A's late resolve was dropped.
    expect(h.modelsSeen).toEqual([[model('claude-sonnet-5', 'Sonnet 5')]]);
    expect(h.getModelId()).toBe('claude-sonnet-5');
  });

  it('the stop function returned for a resolved request is a harmless no-op', async () => {
    const h = harness();
    const stopA = h.start('A');
    h.resolve('A', [model('a1', 'A One')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(() => stopA()).not.toThrow();
    expect(h.modelsSeen).toEqual([[model('a1', 'A One')]]);
  });
});
