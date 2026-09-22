// Figma "33 · Loaders" (177:17271) — the four waiting states, one module so no
// feature hand-rolls a spinner again. Pick by what is waiting, not by taste:
//
//   · Slabs  (176:17286) — the view has nothing to show yet (boot, a session
//     opening, a pane loading). Owns the area: centred, a line of text under it.
//   · Caret  (176:17303) — inside a line that already exists (a row, a tool call,
//     a button mid-action, streaming output). Sized by the surrounding font.
//   · Stitch (176:17306) — background work on a view that stays usable. A 2px
//     hairline on an edge; never in the middle of a view.
//   · Orbit  (176:17299) — work François only watches (a subagent, a workflow
//     step, CI). Violet on purpose: "someone else is busy".
//
// The frame's rule — "under 300 ms, show nothing" — is built in: Slabs, Caret
// and Stitch mount only after `delay` ms (default 300) so a fast load never flashes.
// Pass `delay={0}` where the wait is already known to be long (or where the
// caller has gated it itself). Reduced motion turns all four into a 2.2s
// opacity breathe (loader.css).

import type { ReactNode } from 'react';
import { useDelayedFlag } from '../lib/hooks/useDelayedFlag';
import './loader.css';

/** "Under 300 ms, show nothing" (Figma 177:17504). */
export const LOADER_DELAY_MS = 300;

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

interface Delayed {
  /** ms before the loader mounts; defaults to {@link LOADER_DELAY_MS}. */
  delay?: number;
  className?: string;
}

// ── Slabs ─────────────────────────────────────────────────────────────────────

export type SlabsSize = 16 | 24 | 40;

export interface LoaderSlabsProps extends Delayed {
  size?: SlabsSize;
  /** Accessible name; pass '' when a surrounding element already announces the wait. */
  label?: string;
}

/** The mark's three bars redrawing themselves. Draws with currentColor. */
export function LoaderSlabs({ size = 24, label = 'Loading', delay = LOADER_DELAY_MS, className }: LoaderSlabsProps): JSX.Element | null {
  const shown = useDelayedFlag(true, delay);
  if (delay > 0 && !shown) return null;
  return (
    <span
      className={cx('loader-slabs', `loader-slabs--${size}`, className)}
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    >
      <span className="loader-slabs__bar" />
      <span className="loader-slabs__bar" />
      <span className="loader-slabs__bar loader-slabs__bar--muted" />
    </span>
  );
}

export interface LoaderPaneProps extends Delayed {
  /** The line of text under the mark ("Opening session…"). */
  label: ReactNode;
  /** A second, quieter line (a path, a hint). */
  detail?: ReactNode;
  size?: SlabsSize;
}

/**
 * Slabs in its intended setting: owning the whole area, centred, with a line
 * of text under it. The one loader per screen.
 */
export function LoaderPane({ label, detail, size = 24, delay = LOADER_DELAY_MS, className }: LoaderPaneProps): JSX.Element | null {
  const shown = useDelayedFlag(true, delay);
  if (delay > 0 && !shown) return null;
  return (
    <div className={cx('loader-pane', className)} role="status" aria-live="polite">
      <LoaderSlabs size={size} delay={0} label="" />
      <div className="loader-pane__label">{label}</div>
      {detail ? <div className="loader-pane__detail">{detail}</div> : null}
    </div>
  );
}

// ── Caret ─────────────────────────────────────────────────────────────────────

export interface LoaderCaretProps extends Delayed {
  /** Text after the caret ("running tests"). Omit for a bare caret. */
  label?: ReactNode;
  /** Accessible name for a bare caret. */
  title?: string;
}

/** A block cursor waiting for the next token. Takes the surrounding font-size. */
export function LoaderCaret({ label, title, delay = LOADER_DELAY_MS, className }: LoaderCaretProps): JSX.Element | null {
  const shown = useDelayedFlag(true, delay);
  if (delay > 0 && !shown) return null;
  return (
    <span
      className={cx('loader-caret', label != null && 'loader-caret--labelled', className)}
      role="status"
      aria-label={label == null ? (title ?? 'Working') : undefined}
    >
      <span className="loader-caret__block" aria-hidden="true" />
      {label != null ? <span className="loader-caret__label">{label}</span> : null}
    </span>
  );
}

// ── Stitch ────────────────────────────────────────────────────────────────────

export interface LoaderStitchProps extends Delayed {
  /** Accessible name — what is happening in the background. */
  label?: string;
  /** Pin to the top edge of the nearest positioned ancestor (the usual place). */
  edge?: 'top' | 'bottom' | 'none';
}

/** A 2px hairline on an edge for work that does not block the view. */
export function LoaderStitch({ label = 'Refreshing', edge = 'top', delay = LOADER_DELAY_MS, className }: LoaderStitchProps): JSX.Element | null {
  const shown = useDelayedFlag(true, delay);
  if (delay > 0 && !shown) return null;
  return (
    <span
      className={cx('loader-stitch', edge !== 'none' && `loader-stitch--${edge}`, className)}
      role="progressbar"
      aria-label={label}
      aria-busy="true"
    >
      <span className="loader-stitch__segment" />
    </span>
  );
}

// ── Orbit ─────────────────────────────────────────────────────────────────────

export type OrbitSize = 14 | 20 | 28;

export interface LoaderOrbitProps extends Delayed {
  size?: OrbitSize;
  /** Who is working ("agent · reviewer") — the orbit is always paired with a name. */
  title?: string;
}

/**
 * A 100° arc circling a faint ring: work François watches, not does. Unlike the
 * other three it defaults to no mount delay — it stands in for a status glyph
 * (a subagent that is running), so a 300 ms hole would read as a layout jump.
 */
export function LoaderOrbit({ size = 14, title = 'Working elsewhere', delay = 0, className }: LoaderOrbitProps): JSX.Element | null {
  const shown = useDelayedFlag(true, delay);
  if (delay > 0 && !shown) return null;
  // Stroke is 10.7% of the diameter at every size (1.5/14, 2/20, 2.8/28), so a
  // single 28-unit viewBox scales to all three specimens.
  return (
    <svg
      className={cx('loader-orbit', className)}
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      role="img"
      aria-label={title}
    >
      <circle className="loader-orbit__track" cx="14" cy="14" r="12.6" strokeWidth="2.8" />
      {/* 100° from twelve o'clock, clockwise. */}
      <path className="loader-orbit__arc" d="M14 1.4 A12.6 12.6 0 0 1 26.41 16.19" strokeWidth="2.8" />
    </svg>
  );
}
