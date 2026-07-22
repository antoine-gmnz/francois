// contract/usage-bar.ts — usage bar (app-scoped plan limits).
// Authored from specs/usage-bar.md §5. Imports shared vocabulary from common.ts;
// never redefines it. UsageMeter is the SAME type interactive-commands uses for
// the /usage card — the parse grammar is shared, so the shape must be too.
//
// Channels (PIPELINE §Conventions binding):
//   francois:app:getUsage     → invoke('app_get_usage')     → Promise<Result<UsageSnapshot>>
//   francois:app:refreshUsage → invoke('app_refresh_usage') → Promise<Result<UsageRefreshAck>>
//   francois:app:event        → listen('francois://app/event')  // payload: AppEvent
//
// `francois://app/event` is NEW — the app domain had only invoke commands before.
// It is a tagged union with one member today so later app-scoped events join it
// rather than adding channels.

import type { AppError, UsageMeter } from './common';

/**
 * Lifecycle of the app-scoped usage cache (spec FR-4, FR-16..FR-20).
 * - 'empty'   — no probe has ever succeeded and none is running.
 * - 'loading' — a probe is in flight. `meters` may still hold the previous result (FR-18).
 * - 'ready'   — the last probe succeeded; `meters` is non-empty.
 * - 'error'   — the last probe failed; `error` is set; `meters` may hold a stale result.
 */
export type UsageStatus = 'empty' | 'loading' | 'ready' | 'error';

/**
 * The app-scoped usage cache. In-memory in the core, never persisted (FR-4).
 * Invariants (FR-18/19/20):
 *   status === 'ready' → meters.length > 0 && fetchedAt !== null && error === null
 *   status === 'error' → error !== null
 *   status === 'empty' → meters.length === 0 && fetchedAt === null && error === null
 *   meters/fetchedAt are NEVER cleared by a failed probe.
 * `fetchedAt` and `error` serialize as JSON null when absent — never omitted.
 */
export interface UsageSnapshot {
  status: UsageStatus;
  /** Meters from the last successful probe, in the order the CLI emitted them. */
  meters: UsageMeter[];
  /** Epoch ms of the last SUCCESSFUL probe; null before the first one. */
  fetchedAt: number | null;
  /** Non-null iff status === 'error'. */
  error: AppError | null;
}

/** Ack for francois:app:refreshUsage — the result itself arrives as a usage.state event. */
export interface UsageRefreshAck {
  /** false when a probe was already in flight (FR-7). */
  started: boolean;
}

/** Payload of francois://app/event. Tagged union — one member today, extensible. */
export type AppEvent = { type: 'usage.state'; snapshot: UsageSnapshot };

/** FR-24 threshold — shared by the bar and any future meter renderer. */
export const USAGE_HIGH_THRESHOLD = 80;

/**
 * FR-24 fill width: clamp to 0–100 for rendering only. The PRINTED number stays
 * verbatim (a CLI over-report of 130% prints "130%" behind a full bar).
 */
export function meterFillPercent(percentUsed: number): number {
  if (!Number.isFinite(percentUsed)) return 0;
  return Math.min(100, Math.max(0, percentUsed));
}

/** FR-24 threshold test — true once a meter should render in the error color. */
export function isMeterHigh(percentUsed: number): boolean {
  return percentUsed >= USAGE_HIGH_THRESHOLD;
}

/** FR-29 tooltip text for one meter chip. `resetsAt` is verbatim CLI text. */
export function meterTooltip(meter: UsageMeter): string {
  return `${meter.label} — resets ${meter.resetsAt}`;
}

/**
 * §8 freshness label. `now` is passed in (never read from the clock here) so the
 * function stays pure and testable.
 *   null → 'never' · < 60s → 'just now' · else 'updated <n>m ago' (floor, min 1).
 */
export function freshnessLabel(fetchedAt: number | null, now: number): string {
  if (fetchedAt === null) return 'never';
  const elapsed = now - fetchedAt;
  if (elapsed < 60_000) return 'just now';
  return `updated ${Math.floor(elapsed / 60_000)}m ago`;
}
