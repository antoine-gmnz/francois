// Shared "error string that auto-clears after a delay" (REFACTOR.md audit: the
// same ref-timer-plus-state shape in PermissionCard (errorTimer, 4s), CommandCard's
// ModelBody (timer, 4s) and referenced at QuestionCard.tsx:26-35 — as of this
// audit QuestionCard.tsx itself carries no inline error/timer (its submit path
// only `console.error`s on failure, see ./question-card.ts's `submitAnswers`),
// so that one citation could not be matched against the current file; the other
// two are covered exactly.
//
// `scheduleTimedClear`/`clearTimedHandle` are the pure, framework-free half — a
// plain mutable handle plus "clear any pending timer, then arm a new one" (the
// part that stops repeated failures from stacking overlapping timeouts, per
// PermissionCard's FR-21 comment) — exercised directly with fake timers below.
// `useTimedError` is the `useState`+`useRef` React wrapper, shaped so its
// `schedule` return matches `runGuardedAction`'s `schedule` option verbatim
// (`./guarded-action.ts`) — a card can wire the two straight together.

import { useEffect, useRef, useState } from 'react';

/** A single mutable timer slot — the non-hook half, for tests. */
export interface TimerHandle {
  current: ReturnType<typeof setTimeout> | undefined;
}

export function createTimerHandle(): TimerHandle {
  return { current: undefined };
}

/** Cancels any timer already armed on `handle`, then arms `fn` to run after `ms`. */
export function scheduleTimedClear(handle: TimerHandle, fn: () => void, ms: number): void {
  clearTimeout(handle.current);
  handle.current = setTimeout(fn, ms);
}

/** Cancels a pending timer (if any) and resets the handle. Safe to call repeatedly. */
export function clearTimedHandle(handle: TimerHandle): void {
  clearTimeout(handle.current);
  handle.current = undefined;
}

export interface UseTimedErrorResult {
  error: string | null;
  /** Sets the error immediately; does not itself schedule a clear. */
  setError: (message: string | null) => void;
  /** setTimeout injection point matching `runGuardedAction`'s `schedule` option — clears any previously scheduled clear first. */
  schedule: (fn: () => void, ms: number) => void;
}

/**
 * An error string plus a `schedule` helper to auto-clear it — the timer is
 * always cancelled on unmount, and scheduling a new clear cancels any pending
 * one first (so a second failure inside the window never has its message
 * clipped early by the first failure's timer).
 */
export function useTimedError(): UseTimedErrorResult {
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<TimerHandle>(createTimerHandle());

  useEffect(() => () => clearTimedHandle(handle.current), []);

  const schedule = (fn: () => void, ms: number) => scheduleTimedClear(handle.current, fn, ms);

  return { error, setError, schedule };
}
