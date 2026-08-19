// resizable-sidebar: the roster's right edge is draggable. One persisted
// pixel width is the sole intent input to the first `.app-grid` track — the
// regime only constrains what fits (the cap), it never picks the width, and
// `ROSTER_SPLIT` (238, appShell.ts) is gone: user width always wins over the
// regime.
//
// Split out of layoutStore.ts (past the ~1000-line guideline) — the store
// slice that owns `set()` stays there and re-exports these, per the split-by-4
// precedent (appShell.ts re-exporting layoutStore's own pane helpers).

import type { LayoutRegime } from './layoutStore';

/** Seed default only — once a width is stored it is the sole intent (FR-4). */
export const DEFAULT_ROSTER_WIDTH = 282;
/** Both the snap threshold and the shown-roster floor (FR-6/FR-7). */
export const MIN_ROSTER_WIDTH = 180;
export const MAX_ROSTER_WIDTH = 560;
/** Fraction of the viewport the roster may take, by regime (FR-5). */
export const ROSTER_CAP_FRACTION: Record<'single' | 'split', number> = { single: 0.45, split: 0.3 };
export const ROSTER_WIDTH_STORAGE_KEY = 'francois.rosterWidth';
/** One arrow press (FR-10). */
export const ROSTER_KEY_STEP_PX = 16;

/**
 * The wide-end cap for a regime + viewport. `grid` uses `single`'s fraction —
 * FR-11 means the handle never renders there, so the cap only matters as the
 * fallback `clampRosterWidth` would apply if the roster were ever shown.
 */
export function rosterCap(viewportWidth: number, regime: LayoutRegime): number {
  const frac = regime === 'split' ? ROSTER_CAP_FRACTION.split : ROSTER_CAP_FRACTION.single;
  const width = Number.isFinite(viewportWidth) ? viewportWidth : 0;
  return Math.min(MAX_ROSTER_WIDTH, Math.max(0, width * frac));
}

/**
 * Render-time clamp: intent ∩ what fits. Never persisted (FR-7/FR-8) — a
 * window too small for the stored width renders clamped and springs back
 * once it fits again. The floor always wins over a cap that computes below
 * it (a very narrow window), per FR-7.
 */
export function clampRosterWidth(width: number, viewportWidth: number, regime: LayoutRegime): number {
  const intent = Number.isFinite(width) ? width : DEFAULT_ROSTER_WIDTH;
  const hi = Math.max(MIN_ROSTER_WIDTH, rosterCap(viewportWidth, regime));
  return Math.min(Math.max(intent, MIN_ROSTER_WIDTH), hi);
}

/** Storage normalizer: garbage/absent → DEFAULT, else the raw stored intent (FR-8). */
export function parseRosterWidth(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_ROSTER_WIDTH;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_ROSTER_WIDTH;
}

/**
 * Drag position → the next width and whether the roster should be folded
 * (FR-6). `gridContentLeft` is `.app-grid`'s content-box left (border box +
 * padding-left). `width` is always ≥ MIN_ROSTER_WIDTH and ≤ the cap;
 * `collapse` is true when the raw pointer distance fell below MIN_ROSTER_WIDTH.
 */
export function rosterWidthFromDrag(
  pointerX: number,
  gridContentLeft: number,
  viewportWidth: number,
  regime: LayoutRegime,
): { width: number; collapse: boolean } {
  const raw = pointerX - gridContentLeft;
  return { width: clampRosterWidth(raw, viewportWidth, regime), collapse: raw < MIN_ROSTER_WIDTH };
}
