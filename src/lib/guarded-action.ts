// Shared "submit → in-flight → race-guarded failure → timed error" shape
// (REFACTOR.md audit: duplicated verbatim at permission-card.ts's
// `submitDecision`, question-card.ts's `submitAnswers`, and
// conversation-blocks.ts's `switchModelFromCard`). All three: mark busy, clear
// any stale error, `await` the call, catch a transport-level rejection the same
// as a domain `ok: false`, and on failure — UNLESS the block was already
// resolved by a live event (the race `isResolved()` guards against) — re-enable
// and show the failure, auto-clearing it after a delay. On success every one of
// them deliberately does NOT reset `busy`: the card stays in-flight until the
// matching event (`permission.resolved` / `question.resolved` / the model
// actually moving via `session.meta`) flips it — never the action itself.
//
// This generalizes over all three by making every option optional:
//  - permission-card.ts's `submitDecision`: setBusy + setError + schedule + isResolved, no log.
//  - question-card.ts's `submitAnswers`: setBusy + isResolved + log, no setError/schedule
//    (no inline error UI — a failure only reaches the console).
//  - conversation-blocks.ts's `switchModelFromCard`: setError + schedule only —
//    no setBusy/isResolved at all (there is no in-flight concept for a model
//    switch, and nothing else can resolve the same click out from under it).
// Options this hook is not given are simply no-ops (`?.()`), so each existing
// call site's exact behaviour falls out of the same function.

import type { Result } from '../../contract/common';

export interface RunGuardedActionOptions {
  /** In-flight flag (opacity/clicks-ignored while true). Omit if the action has no such concept. */
  setBusy?: (busy: boolean) => void;
  /** Card-local inline error line; called with `null` to clear a stale one before running, and with the failure message on failure. Omit if there is no inline error UI. */
  setError?: (message: string | null) => void;
  /** setTimeout injection point (fake in tests) that auto-clears the error after `errorMs`. Only used when `setError` is also given. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Delay before the error auto-clears. Default 4000 (both existing timed call sites use it). */
  errorMs?: number;
  /** True when the target was already resolved elsewhere (a live event won the race) — a failure must then leave it alone: no `setBusy(false)`, no `setError`. Omit for actions nothing else can resolve (always treated as "not resolved"). */
  isResolved?: () => boolean;
  /** Failure log sink, given the raw failure message (the caller formats it, e.g. `` `answerQuestion failed: ${m}` ``). Omit to skip logging. */
  log?: (message: string) => void;
}

/**
 * Runs `fn`, applying the shared in-flight → clear-stale-error → race-guarded
 * failure → timed-error shape. `fn` must never reject on a *domain* failure —
 * per the contract every fallible call resolves `Result` — but a transport-level
 * rejection (the invoke bridge itself failing) is caught and treated exactly
 * like `{ ok: false }`, matching all three existing call sites.
 */
export async function runGuardedAction<T>(fn: () => Promise<Result<T>>, options: RunGuardedActionOptions = {}): Promise<void> {
  const { setBusy, setError, schedule, errorMs = 4000, isResolved, log } = options;

  setBusy?.(true);
  setError?.(null);

  let failure: string | null = null;
  try {
    const res = await fn();
    if (!res.ok) failure = res.error.message;
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  if (failure === null) return; // success — stays busy; a live event settles the UI, not this call

  log?.(failure);
  if (isResolved?.() ?? false) return; // an event already resolved it — leave the (now-settled) card alone

  setBusy?.(false);
  setError?.(failure);
  if (schedule) schedule(() => setError?.(null), errorMs);
}
