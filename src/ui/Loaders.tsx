// "Graphite & Signal · motion" — four loaders built from the mark itself
// (design mirror: François Loaders.html). Same easing, same rhythm, four
// scales, one rule each:
//
//   Slabs  — the view has nothing else to show yet. One per screen.
//   Caret  — inline, inside a line of text / a row that already exists.
//   Stitch — a 2px hairline on an edge, for background work on a still-usable
//            view. Never blocks anything.
//   Orbit  — work François only watches (a subagent, a workflow run, a
//            remote check) — violet, so it reads as "someone else is busy".
//
// Every loader draws with currentColor/theme tokens (loaders.css) and is
// transform-and-opacity only. `prefers-reduced-motion` swaps all four for a
// slow 2.2s opacity breathe — no spin, no travel (see the note in
// loaders.css next to that override). Nothing mounts under 300ms — use the
// gated variants at the bottom of this file (LoaderPane / LoaderCaret /
// LoaderStitch), or gate the call site with `useDelayedFlag`; never both.

import type { CSSProperties, ReactNode } from 'react';
import { useDelayedFlag } from '../lib/hooks/useDelayedFlag';
import './loaders.css';

/** Runtime size, threaded through as the `--s` custom property every fr-* rule reads. */
function sizeStyle(size: number): CSSProperties {
  // eslint-disable-next-line no-restricted-syntax -- runtime geometry: the box is `size`, a prop
  return { '--s': `${size}px` } as CSSProperties;
}

export interface SlabsProps {
  /** Square box size in px (16/24/40 are the design's specimens). Defaults to 24. */
  size?: number;
  /** Accessible label. Pass `null` when nested in text that already states what's loading. Defaults to "Loading". */
  label?: string | null;
  className?: string;
}

/** The three bars of the mark, re-drawing themselves — the view has nothing else to show yet. One per screen. */
export function Slabs({ size = 24, label = 'Loading', className }: SlabsProps): JSX.Element {
  return (
    <span
      className={className ? `fr-slabs ${className}` : 'fr-slabs'}
      style={sizeStyle(size)}
      role={label === null ? undefined : 'img'}
      aria-hidden={label === null ? true : undefined}
      aria-label={label ?? undefined}
    >
      <i />
      <i />
      <i />
    </span>
  );
}

export interface CaretProps {
  /** The busy label the caret sits after, e.g. "running tests". Omit for a bare trailing cursor. */
  children?: ReactNode;
  className?: string;
}

/** A block cursor waiting for the next token. Sits inside a line of text and inherits its font-size and color. */
export function Caret({ children, className }: CaretProps): JSX.Element {
  return (
    <span className={className ? `fr-caret ${className}` : 'fr-caret'} aria-hidden={children === undefined ? true : undefined}>
      {children}
    </span>
  );
}

export interface StitchProps {
  className?: string;
}

/** A 2px hairline that runs along an edge. Never blocks anything — the content underneath stays usable. */
export function Stitch({ className }: StitchProps): JSX.Element {
  return <div className={className ? `fr-stitch ${className}` : 'fr-stitch'} aria-hidden="true" />;
}

export interface OrbitProps {
  /** Square box size in px (14/20/28 are the design's specimens). Defaults to 14. */
  size?: number;
  /** Accessible label. Pass `null` when nested in text that already states what's loading. Defaults to "Loading". */
  label?: string | null;
  className?: string;
}

/** Work François is only watching — a subagent, a workflow run, a remote check. Violet, so it reads as someone else's turn. */
export function Orbit({ size = 14, label = 'Loading', className }: OrbitProps): JSX.Element {
  return (
    <span
      className={className ? `fr-orbit ${className}` : 'fr-orbit'}
      style={sizeStyle(size)}
      role={label === null ? undefined : 'img'}
      aria-hidden={label === null ? true : undefined}
      aria-label={label ?? undefined}
    >
      <i />
      <i />
    </span>
  );
}

// ── Placed + delayed variants ────────────────────────────────────────────────
// The four primitives above are the drawing; these wrap them with the two
// things most call sites would otherwise repeat: the "under 300 ms, show
// nothing" gate (Figma 33 · Loaders, 177:17504) and where the loader sits.
// A call site that already gates itself (useDelayedFlag) passes `delay={0}`.

/** "Under 300 ms, show nothing" (Figma 177:17504). */
export const LOADER_DELAY_MS = 300;

/** True once `delay` ms have passed since mount; `delay <= 0` shows at once. */
function useShown(delay: number): boolean {
  const flipped = useDelayedFlag(delay > 0, delay);
  return delay <= 0 || flipped;
}

export interface LoaderPaneProps {
  /** The line of text under the mark ("Opening session…"). */
  label: ReactNode;
  /** A second, quieter line (a path, a hint). */
  detail?: ReactNode;
  /** Slabs box size — 16/24/40 are the design's specimens. Defaults to 24. */
  size?: number;
  delay?: number;
  className?: string;
}

/**
 * Slabs in its intended setting: the view has nothing to show yet, so the
 * loader owns the area — centred, with a line of text under it. One per screen.
 */
export function LoaderPane({ label, detail, size = 24, delay = LOADER_DELAY_MS, className }: LoaderPaneProps): JSX.Element | null {
  if (!useShown(delay)) return null;
  return (
    <div className={className ? `fr-pane ${className}` : 'fr-pane'} role="status" aria-live="polite">
      <Slabs size={size} label={null} />
      <div className="fr-pane__label">{label}</div>
      {detail ? <div className="fr-pane__detail">{detail}</div> : null}
    </div>
  );
}

export interface LoaderCaretProps {
  /** Text after the caret ("running tests"). Omit for a bare caret. */
  label?: ReactNode;
  delay?: number;
  className?: string;
}

/** `Caret` behind the 300 ms gate, for a line or row that already exists. */
export function LoaderCaret({ label, delay = LOADER_DELAY_MS, className }: LoaderCaretProps): JSX.Element | null {
  if (!useShown(delay)) return null;
  return <Caret className={className}>{label}</Caret>;
}

export interface LoaderStitchProps {
  /** Accessible name — what is happening in the background. */
  label?: string;
  /** Pin to that edge of the nearest positioned ancestor (the usual place). */
  edge?: 'top' | 'bottom' | 'none';
  delay?: number;
  className?: string;
}

/** `Stitch` behind the 300 ms gate, pinned to an edge of a view that stays usable. */
export function LoaderStitch({ label = 'Refreshing', edge = 'top', delay = LOADER_DELAY_MS, className }: LoaderStitchProps): JSX.Element | null {
  if (!useShown(delay)) return null;
  const base = edge === 'none' ? 'fr-edge' : `fr-edge fr-edge--${edge}`;
  return (
    <div className={className ? `${base} ${className}` : base} role="progressbar" aria-label={label} aria-busy="true">
      <Stitch />
    </div>
  );
}
