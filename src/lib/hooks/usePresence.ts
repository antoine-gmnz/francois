// Keeps something mounted for `exitMs` after it closes, so it can play an exit
// animation instead of vanishing. Timer-driven rather than `animationend`-driven
// on purpose: the global reduced-motion override (styles.css) shrinks every
// animation to ~0ms, and a timer needs no DOM ref to know the exit is over.
//
// `presenceOf` is the pure half (unit-tested); the hook reuses
// useDelayedFlag's `startDelayedFlag` for the timer, so a reopen during the
// exit cancels the pending unmount through the same effect-cleanup path.

import { useEffect, useState } from 'react';
import { startDelayedFlag } from './useDelayedFlag';

/** Exit length for the composer's floating menus — matches `popoverOut` on --dur-base. */
export const POPOVER_EXIT_MS = 120;

export interface Presence {
  /** Render the thing at all. */
  present: boolean;
  /** Closed but still on screen — play the exit animation. */
  exiting: boolean;
}

/** `open` wins; a closed thing that has not yet finished leaving is exiting. */
export function presenceOf(open: boolean, lingering: boolean): Presence {
  return { present: open || lingering, exiting: !open && lingering };
}

export function usePresence(open: boolean, exitMs: number): Presence {
  const [lingering, setLingering] = useState(open);
  useEffect(() => {
    if (open) {
      setLingering(true);
      return undefined;
    }
    return startDelayedFlag(lingering, exitMs, () => setLingering(false));
  }, [open, lingering, exitMs]);
  return presenceOf(open, lingering);
}
