// runtime-metrics (pi-models-metrics §5) — pure formatting for RuntimeMetrics.
// Every unknown renders an em dash, with the reason kept alongside rather than a
// fabricated 0 or a false empty/full bar (FR-7/FR-8). Context OCCUPANCY is never
// the sum of the four cumulative counters — contextTokens/contextWindow is the
// only pair that feeds the bar, and it stays null (⇒ no bar at all) after a
// compaction until the runtime reports a trustworthy value.

import type { Result, RuntimeMetrics, SessionMeta } from '../../../contract/common';
import { formatContextTokens } from '../../../contract/conversation-view';
import { isBusyStatus } from '../../../contract/fleet-board';
import { sessionCapability } from '../../lib/runtimeCapability';

/** Renders in place of any unknown counter — never `0`, never blank. */
export const UNKNOWN_METRIC = '—';

/** One counter, em dash when the runtime hasn't reported it. */
export function formatMetricTokens(n: number | null): string {
  return n === null ? UNKNOWN_METRIC : formatContextTokens(n);
}

export interface ContextReadout {
  /** 0..1, clamped. */
  fraction: number;
  /** `84K/200K`. */
  label: string;
  basis: RuntimeMetrics['contextBasis'];
}

/**
 * The context bar's fill + label. `null` ⇒ render NO bar at all — an unknown
 * occupancy is neither a full one nor an empty one (FR-7). A zero-or-negative
 * advertised window is treated the same as unknown: there is nothing to divide by.
 */
export function contextReadout(metrics: RuntimeMetrics | undefined): ContextReadout | null {
  if (!metrics || metrics.contextTokens === null || metrics.contextWindow === null || metrics.contextWindow <= 0) {
    return null;
  }
  return {
    fraction: Math.max(0, Math.min(1, metrics.contextTokens / metrics.contextWindow)),
    label: `${formatContextTokens(metrics.contextTokens)}/${formatContextTokens(metrics.contextWindow)}`,
    basis: metrics.contextBasis,
  };
}

/** `$0.0123`-style — enough precision that a small per-turn cost doesn't round to $0.00. */
export function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

/**
 * Cost as the run chip / details panel render it — an ESTIMATE, or an honest
 * unknown. Zero pricing is never "free": `costBasis === 'estimated'` with
 * `costUsd === 0` still reads as an estimate, not a claim of free execution (FR-8).
 */
export function costReadout(metrics: RuntimeMetrics | undefined): string {
  if (!metrics || metrics.costBasis !== 'estimated' || metrics.costUsd === null) return UNKNOWN_METRIC;
  return `${formatUsd(metrics.costUsd)} est.`;
}

/**
 * FR-5: the picker's explanation while a model/effort switch cannot be
 * accepted. The core's own `modelSwitching` capability reason is authoritative
 * when it has one (e.g. mid-compaction); the spec's own copy covers the plain
 * "a turn is in flight" case, which the core may not always spell out itself.
 */
export function modelSwitchUnavailableReason(session: SessionMeta): string | null {
  const capability = sessionCapability(session, 'modelSwitching');
  if (capability.available) return null;
  return capability.reason ?? 'Available when this run finishes.';
}

/** FR-1: the picker's empty state — never conflated with a load failure. */
export const NO_MODELS_MESSAGE = 'No models available for this Pi account';

/**
 * FR-5, for the run chip's LIVE Pi model/effort switch (RunChip → session
 * settings sheet edit mode) — as opposed to the New Session form, which never
 * has an existing turn to be busy with. `modelSwitchUnavailableReason` alone
 * goes quiet here: the Pi adapter's capability snapshot is computed once at
 * connect and never flips `modelSwitching` false for an ordinary turn in
 * flight (only a future capability-level narrowing, e.g. mid-compaction,
 * would show up there) — see this feature's handoff. The plain busy check
 * covers the case the capability table does not.
 */
export function piModelSwitchBlockedReason(session: SessionMeta): string | null {
  if (isBusyStatus(session.status)) return 'Available when this run finishes.';
  return modelSwitchUnavailableReason(session);
}

export interface ModelSwitchSubmitArgs<T> {
  /** Bound sessionSwitchRuntimeModel/sessionSwitchEffort call. */
  call: () => Promise<Result<T>>;
  /** In-flight flag — both the model field and the effort chips disable while true. */
  setSwitching: (switching: boolean) => void;
  /** Inline, transient error line; `null` clears it. */
  setError: (message: string | null) => void;
  /** setTimeout injection point (fake in tests). */
  schedule: (fn: () => void, ms: number) => void;
}

/**
 * One model/effort switch round trip, extracted from PiRunModelSwitch so the
 * setter calls can be wrapped in the caller's `useMounted` guard — same split
 * as `submitRecoveryAction` (./pi-recovery.ts) for the same reason: a switch
 * outliving the component (pane closed, session torn down mid-round-trip)
 * must not call `setState` on an unmounted component.
 */
export async function submitModelSwitch<T>(a: ModelSwitchSubmitArgs<T>): Promise<Result<T>> {
  a.setSwitching(true);
  a.setError(null);
  const res = await a.call();
  a.setSwitching(false);
  if (!res.ok) {
    a.setError(res.error.message);
    a.schedule(() => a.setError(null), 4000);
  }
  return res;
}
