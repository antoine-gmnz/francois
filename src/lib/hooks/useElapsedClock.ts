// Shared "tick once a second while running" clock (REFACTOR.md audit: the same
// setInterval-gated-by-a-condition effect appeared 4 times — App.tsx (active
// session running + SESSION tab focused), AgentsPanel (any agent running),
// AgentView (this agent running), and OverviewView (relative-time aging, but
// unconditional and on a 30s cadence rather than gated-1s).
//
// `startElapsedClock` is the pure, framework-free half — it owns the "only
// schedule while `active`" decision and is what's actually under test here (a
// real `setInterval`/`clearInterval` pair, exercised with fake timers); the hook
// is a thin `useEffect`/`useState` wrapper.
//
// OverviewView's cadence differs (30_000ms, and it never gates on a condition —
// it always ticks while mounted) but both are just parameters of the same shape:
// `useElapsedClock(true, 30_000)`, ignoring the returned value exactly as its
// current `const [, setTick] = useState(0)` ignores its own counter — the return
// value only exists to force a re-render on each tick.

import { useEffect, useState } from 'react';

/**
 * Starts a `setInterval(onTick, intervalMs)` iff `active`, returning its
 * cleanup — or `undefined` (nothing to clean up) when `active` is false.
 */
export function startElapsedClock(active: boolean, intervalMs: number, onTick: () => void): (() => void) | undefined {
  if (!active) return undefined;
  const id = setInterval(onTick, intervalMs);
  return () => clearInterval(id);
}

/**
 * Returns `Date.now()`, refreshed every `intervalMs` (default 1000) while
 * `active` is true; frozen (no re-renders) while `active` is false. Consumers
 * that only need a render trigger — not the value itself, e.g. OverviewView's
 * relative-time aging — can call this and ignore the return.
 */
export function useElapsedClock(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startElapsedClock(active, intervalMs, () => setNow(Date.now())), [active, intervalMs]);
  return now;
}
