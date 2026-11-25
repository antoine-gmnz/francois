// audit C2 — the Context tab's per-model split of the thread's usage
// (`RuntimeMetrics.byModel`, Claude's `result.modelUsage`). Pure, so the rows
// and their copy are unit-tested; ModelUsage.tsx only lays them out.
//
//   MODELS                                  $0.13 est.
//   claude-sonnet-5                 254K       $0.13
//     in 14 · out 1K · cache 246.8K read · 6.3K write
//
// Every figure is the THREAD's running total (it replaces, never adds), so the
// costs sum to the session's own `costUsd`. Unknowns are em dashes, never 0.

import type { ModelUsageMetrics, RuntimeMetrics } from '../../../contract/common';
import { UNKNOWN_METRIC, costReadout, formatMetricTokens, formatUsd } from '../sessions/runtime-metrics';

export interface ModelUsageRow {
  model: string;
  /** Every token the model processed: input + output + both cache counters. */
  tokens: string;
  cost: string;
  /** "in 14 · out 1K · cache 246.8K read · 6.3K write" */
  detail: string;
}

export interface ModelUsageView {
  /** The session's own cost estimate, for the heading. */
  total: string;
  rows: ModelUsageRow[];
}

function totalTokens(m: ModelUsageMetrics): number | null {
  const counters = [m.inputTokens, m.outputTokens, m.cacheReadTokens, m.cacheWriteTokens];
  if (counters.every((n) => n === null)) return null;
  return counters.reduce<number>((sum, n) => sum + (n ?? 0), 0);
}

function detail(m: ModelUsageMetrics): string {
  return [
    `in ${formatMetricTokens(m.inputTokens)}`,
    `out ${formatMetricTokens(m.outputTokens)}`,
    `cache ${formatMetricTokens(m.cacheReadTokens)} read · ${formatMetricTokens(m.cacheWriteTokens)} write`,
  ].join(' · ');
}

/** Biggest spender first; a model with no reported cost sorts last, then by name. */
function byCost(a: ModelUsageMetrics, b: ModelUsageMetrics): number {
  if (a.costUsd !== b.costUsd) {
    if (a.costUsd === null) return 1;
    if (b.costUsd === null) return -1;
    return b.costUsd - a.costUsd;
  }
  return a.model.localeCompare(b.model);
}

/** null ⇒ render nothing: the runtime reported no per-model split. */
export function modelUsageView(metrics: RuntimeMetrics | undefined): ModelUsageView | null {
  const models = metrics?.byModel ?? [];
  if (models.length === 0) return null;
  return {
    total: costReadout(metrics),
    rows: [...models].sort(byCost).map((m) => ({
      model: m.model,
      tokens: formatMetricTokens(totalTokens(m)),
      cost: m.costUsd === null ? UNKNOWN_METRIC : formatUsd(m.costUsd),
      detail: detail(m),
    })),
  };
}
