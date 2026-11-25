import { describe, expect, it } from 'vitest';
import type { ModelUsageMetrics, RuntimeMetrics } from '../../../contract/common';
import { modelUsageView } from './model-usage';

function metrics(byModel?: ModelUsageMetrics[], costUsd: number | null = 0.1369): RuntimeMetrics {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    contextTokens: null,
    contextWindow: null,
    contextBasis: 'unknown',
    costUsd,
    costBasis: costUsd === null ? 'unknown' : 'estimated',
    measuredAt: 1,
    stale: false,
    ...(byModel ? { byModel } : {}),
  };
}

const sonnet: ModelUsageMetrics = {
  model: 'claude-sonnet-5',
  inputTokens: 14,
  outputTokens: 1005,
  cacheReadTokens: 246_808,
  cacheWriteTokens: 6298,
  costUsd: 0.1269474,
  contextWindow: 1_000_000,
};
const haiku: ModelUsageMetrics = { ...sonnet, model: 'claude-haiku-5', inputTokens: 500, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.01 };

describe('modelUsageView (audit C2)', () => {
  it('renders nothing when the runtime reported no split', () => {
    expect(modelUsageView(undefined)).toBeNull();
    expect(modelUsageView(metrics())).toBeNull();
    expect(modelUsageView(metrics([]))).toBeNull();
  });

  it('one row per model, biggest spender first, under the session total', () => {
    const view = modelUsageView(metrics([haiku, sonnet]));
    expect(view?.total).toBe('$0.14 est.');
    expect(view?.rows).toEqual([
      { model: 'claude-sonnet-5', tokens: '254.1K', cost: '$0.13', detail: 'in 14 · out 1K · cache 246.8K read · 6.3K write' },
      { model: 'claude-haiku-5', tokens: '520', cost: '$0.01', detail: 'in 500 · out 20 · cache — read · — write' },
    ]);
  });

  it('an unknown cost or count is an em dash, never zero, and sorts last', () => {
    const unknown: ModelUsageMetrics = { model: 'a-model', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, contextWindow: null };
    const view = modelUsageView(metrics([unknown, haiku], null));
    expect(view?.total).toBe('—');
    expect(view?.rows.map((r) => [r.model, r.tokens, r.cost])).toEqual([
      ['claude-haiku-5', '520', '$0.01'],
      ['a-model', '—', '—'],
    ]);
  });
});
