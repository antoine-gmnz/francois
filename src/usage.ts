// usage-bar (specs/usage-bar.md) — everything the bar does that is not markup:
// the mount-time cache seed + francois://app/event subscription (FR-21/22), the
// fire-and-forget manual refresh (FR-27/28), and the render derivations
// (FR-23/24/25/26/29). UsageBar.tsx is a thin renderer over these so the logic
// stays coverable by vitest's node environment.
//
// Threshold, clamp, tooltip and freshness rules come from contract/usage-bar.ts —
// they are contract, not local policy, and are never reimplemented here.
//
// The trailing slot shows the SESSION limit's reset countdown (FR-30) and falls
// back to the freshness label only when no reset can be derived.

import type { UnlistenFn } from '@tauri-apps/api/event';
import type { UsageMeter } from '../contract/common';
import type { UsageSnapshot } from '../contract/usage-bar';
import { freshnessLabel, isMeterHigh, meterFillPercent, meterTooltip } from '../contract/usage-bar';
import { appGetUsage, appRefreshUsage, onAppEvent } from './api';

/** §8 tokens shared by the bar's chrome and its derivations. */
export const USAGE_ACCENT = '#c8a15a';
export const USAGE_ERROR = '#c46b62';

/** Everything one meter chip needs to render. Order/labels are never touched (FR-23). */
export interface MeterChipView {
  /** Verbatim UsageMeter.label. */
  label: string;
  /** 0–100, clamped for the fill width only (§7 #11). */
  fillPercent: number;
  /** The number the core sent, verbatim — '130%' behind a full bar. */
  percentText: string;
  /** Fill + number color (FR-24). */
  color: string;
  /** Native tooltip: `${label} — resets ${resetsAt}` (FR-29). */
  title: string;
}

/** What the bar shows for one snapshot. Pure — `now` is passed in, never read here. */
export interface UsageBarView {
  chips: MeterChipView[];
  /** Loading WITH data → the meter region dims to 0.45 (FR-25). No spinner, no motion. */
  dimmed: boolean;
  /** No meters and no error → the `usage —` placeholder (§8). */
  empty: boolean;
  /** status === 'error'; `compact` when stale meters survive and must stay readable (FR-26). */
  error: { compact: boolean; message: string } | null;
  /** `never` / `just now` / `updated <n>m ago` (§8). */
  freshness: string;
  /**
   * FR-30: the session limit's reset, e.g. `resets in 4h 12m`. Null when there is
   * no meter to derive it from.
   */
  reset: string | null;
  /**
   * What the trailing slot actually renders: freshness and reset joined by ' · ',
   * degrading to whichever half exists (FR-30). Never empty — the slot is also the
   * refresh affordance, so it must always have a hit target.
   */
  trailing: string;
  /** Tooltip for the trailing slot; always ends with the refresh hint. */
  resetTitle: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * FR-30: best-effort epoch-ms for a verbatim `resetsAt`, or null when it isn't a
 * timestamp at all. The CLI emits forms like `Jul 22, 5:29pm (Europe/Paris)`,
 * `Jul 25, 11:00am`, bare `Jul 22`, and free text such as `soon` — so this must
 * DEGRADE, never guess. The trailing parenthetical is informational: the clock
 * reading is already in the machine's local zone, so it parses as local time.
 *
 * The CLI omits the year. Limits reset hours-to-days out, so the candidate year
 * closest to `now` is the right one — which also makes a Dec→Jan boundary work
 * in both directions.
 */
export function parseResetAt(resetsAt: string, now: number): number | null {
  const m = /^([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{1,2}):(\d{2})\s*([ap]m)?)?/i.exec(resetsAt.trim());
  if (!m) return null;
  const monthIdx = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (monthIdx < 0) return null;
  const day = Number(m[2]);
  let hour = m[3] ? Number(m[3]) : 0;
  const min = m[4] ? Number(m[4]) : 0;
  const meridiem = m[5]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || min > 59) return null;

  let best: number | null = null;
  const thisYear = new Date(now).getFullYear();
  for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
    const d = new Date(year, monthIdx, day, hour, min, 0, 0);
    // Rejects impossible dates (Feb 30 rolls over to Mar 2 rather than throwing).
    if (d.getMonth() !== monthIdx || d.getDate() !== day) continue;
    const t = d.getTime();
    if (best === null || Math.abs(t - now) < Math.abs(best - now)) best = t;
  }
  return best;
}

/** FR-30 duration: `3d 2h` / `4h 12m` / `47m` / `now` (under a minute or already past). */
export function formatCountdown(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return 'now';
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * FR-30: the SESSION meter's reset, since that is the limit that actually gates
 * the next turn. Matches the first label containing 'session' and falls back to
 * the first meter, so a renamed or single-meter plan still reads sensibly.
 * An unparseable `resetsAt` is shown verbatim (`resets soon`) rather than dropped.
 */
export function sessionResetLabel(meters: UsageMeter[], now: number): string | null {
  const meter = meters.find((m) => /session/i.test(m.label)) ?? meters[0];
  if (!meter) return null;
  const at = parseResetAt(meter.resetsAt, now);
  if (at === null) return `resets ${meter.resetsAt}`;
  const countdown = formatCountdown(at - now);
  return countdown === 'now' ? 'resets now' : `resets in ${countdown}`;
}

export function meterChipView(meter: UsageMeter): MeterChipView {
  const color = isMeterHigh(meter.percentUsed) ? USAGE_ERROR : USAGE_ACCENT;
  return {
    label: meter.label,
    fillPercent: meterFillPercent(meter.percentUsed),
    percentText: `${meter.percentUsed}%`,
    color,
    title: meterTooltip(meter),
  };
}

/** FR-23: every meter, in core order, unfiltered and unrelabelled. */
export function meterChipViews(meters: UsageMeter[]): MeterChipView[] {
  return meters.map(meterChipView);
}

export function usageBarView(snapshot: UsageSnapshot, now: number): UsageBarView {
  const chips = meterChipViews(snapshot.meters);
  const isError = snapshot.status === 'error';
  const sessionMeter = snapshot.meters.find((m) => /session/i.test(m.label)) ?? snapshot.meters[0];
  const reset = sessionResetLabel(snapshot.meters, now);
  const freshness = freshnessLabel(snapshot.fetchedAt, now);
  // 'never' means no probe has ever landed; pairing it with a reset would be
  // self-contradictory, so the reset stands alone in that (defensive) case.
  const parts = [snapshot.fetchedAt === null ? null : freshness, reset].filter(Boolean);
  return {
    chips,
    dimmed: snapshot.status === 'loading' && chips.length > 0,
    empty: !isError && chips.length === 0,
    error: isError ? { compact: chips.length > 0, message: snapshot.error?.message ?? 'usage unavailable' } : null,
    freshness,
    reset,
    trailing: parts.length > 0 ? parts.join(' · ') : freshness,
    // The countdown is derived and rounded, so the tooltip keeps the CLI's exact
    // wording available alongside the refresh hint.
    resetTitle: sessionMeter ? `${meterTooltip(sessionMeter)} · click to refresh` : 'click to refresh',
  };
}

/**
 * FR-21: seed once from the core's cache (no probe — FR-22), then follow
 * francois://app/event. Returns the teardown; it is safe to call before the
 * listen() promise settles and guarantees no apply() after it (§7 #12).
 * A seed that lands after a live event is dropped rather than rewinding the bar.
 */
export function startUsageFeed(apply: (snapshot: UsageSnapshot) => void): () => void {
  let live = true;
  let sawEvent = false;
  let unlisten: UnlistenFn | undefined;

  void appGetUsage()
    .then((res) => {
      if (!live || sawEvent || !res.ok) return;
      apply(res.data);
    })
    .catch(() => {
      /* the bar is chrome — a dead seed degrades to 'never', never throws (§2) */
    });

  void onAppEvent((e) => {
    if (!live || e.type !== 'usage.state') return;
    sawEvent = true;
    apply(e.snapshot);
  })
    .then((u) => {
      if (!live) u();
      else unlisten = u;
    })
    .catch(() => {
      /* ignore — no usage updates, rest of the app unaffected */
    });

  return () => {
    live = false;
    unlisten?.();
    unlisten = undefined;
  };
}

/**
 * FR-27/28: ask the core for a probe. Fire-and-forget by contract — the ack
 * ({ started: false } when one is already in flight, FR-7) changes nothing on
 * screen; the UI only ever reacts to the resulting usage.state events.
 */
export function requestUsageRefresh(): void {
  void appRefreshUsage()
    .then((res) => {
      if (!res.ok) console.warn('[usage] refresh rejected:', res.error.message);
    })
    .catch(() => {
      /* ipc unavailable — nothing to show, nothing to do */
    });
}
