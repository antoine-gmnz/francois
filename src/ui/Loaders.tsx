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
// loaders.css next to that override). Nothing mounts under 300ms — gate the
// call site with `useDelayedFlag` (src/lib/hooks/useDelayedFlag.ts) rather
// than adding a second delay here.

import type { CSSProperties, ReactNode } from 'react';
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
