// session-switch-loader FR-13: one reusable "suppress a below-threshold
// loading state" primitive, extracted rather than inlined into
// useConversationTranscript so the next surface that needs the same 140ms-style
// gate (a below-threshold suppression on some other `active` condition) reuses
// this instead of hand-rolling its own timer.
//
// `startDelayedFlag` is the pure, framework-free half — the same shape as
// useElapsedClock's `startElapsedClock`: it owns the "only arm a timer while
// active" decision and is what's actually under test (a real
// `setTimeout`/`clearTimeout` pair, exercised with fake timers). The hook is a
// thin `useState`/`useEffect` wrapper that also resets its flag to false the
// instant `active` goes false — which is what makes "never flips when active
// goes false first" true: the pending timer's cleanup fires (via the effect's
// dependency-array re-run) before it would ever have called `onFlip`.

import { useEffect, useState } from 'react';

/**
 * Arms a `delayMs` timer that calls `onFlip` iff `active`; returns its cleanup
 * (which cancels the timer), or `undefined` when `active` is false — nothing
 * to arm, nothing to clean up.
 */
export function startDelayedFlag(active: boolean, delayMs: number, onFlip: () => void): (() => void) | undefined {
  if (!active) return undefined;
  const id = setTimeout(onFlip, delayMs);
  return () => clearTimeout(id);
}

/**
 * Flips from `false` to `true` once `active` has been continuously true for
 * `delayMs`. Flips back to `false` (and cancels any pending flip) the instant
 * `active` goes false — an `active` toggle that reverts before the delay
 * elapses never flips the flag at all. Cleans up its timer on unmount and on
 * every identity change of `active`/`delayMs`, so no timer ever outlives the
 * render that armed it.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    if (!active) {
      setFlag(false);
      return undefined;
    }
    return startDelayedFlag(active, delayMs, () => setFlag(true));
  }, [active, delayMs]);
  return flag;
}
