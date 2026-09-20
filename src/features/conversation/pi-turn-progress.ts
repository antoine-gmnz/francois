// pi-turn-controls §5/FR-8 — compaction/retry PROGRESS inside a running Pi
// turn (ControlRuntimePayload 'compaction'/'retry', contract/common.ts). Same
// external-module shape as ./pi-queue: per-session, outlives ComposerPane's
// keyed remount, notifies its own subscribers.
//
// Deliberately NOT wired into the notification trigger
// (src/features/notifications/trigger.ts): that module only derives a
// trigger from `session.status` / `session.meta` / `session.error`
// SessionEvents (its `deriveTrigger` switch has no `runtime.event` case), and
// 'compaction'/'retry' only ever arrive as `runtime.event` envelopes that
// THIS store and sessionsStore.applyRuntimeEvent see — so automatic
// compaction/retry can never fire a premature turn-finished notification or
// audio cue (FR-8), without this module having to know trigger.ts exists.

import { useSyncExternalStore } from 'react';
import type { ControlRuntimePayload } from '../../../contract/common';

export type CompactionProgress = Extract<ControlRuntimePayload, { kind: 'compaction' }>;
export type RetryProgress = Extract<ControlRuntimePayload, { kind: 'retry' }>;

const compactions = new Map<string, CompactionProgress>();
const retries = new Map<string, RetryProgress>();
const listeners = new Map<string, Set<() => void>>();

function notify(sessionId: string): void {
  const ls = listeners.get(sessionId);
  if (!ls) return;
  for (const l of ls) l();
}

function subscribe(sessionId: string, listener: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(sessionId);
  };
}

export function getCompactionProgress(sessionId: string): CompactionProgress | null {
  return compactions.get(sessionId) ?? null;
}

/**
 * FR-8: 'completed' clears the banner outright — a successful compaction
 * (manual or automatic) has nothing left to show. 'failed' persists until
 * `dismissCompactionProgress` or a fresh attempt starts — a failed compaction
 * never clears the displayed history, and the banner is how it "shows error".
 */
export function setCompactionProgress(sessionId: string, event: CompactionProgress): void {
  if (event.state === 'completed') compactions.delete(sessionId);
  else compactions.set(sessionId, event);
  notify(sessionId);
}

export function dismissCompactionProgress(sessionId: string): void {
  if (!compactions.has(sessionId)) return;
  compactions.delete(sessionId);
  notify(sessionId);
}

export function getRetryProgress(sessionId: string): RetryProgress | null {
  return retries.get(sessionId) ?? null;
}

/** 'finished' clears the banner — the retry loop is done, win or lose. */
export function setRetryProgress(sessionId: string, event: RetryProgress): void {
  if (event.state === 'finished') retries.delete(sessionId);
  else retries.set(sessionId, event);
  notify(sessionId);
}

/** Drops both progress records for a session (session removal). */
export function clearTurnProgress(sessionId: string): void {
  const had = compactions.has(sessionId) || retries.has(sessionId);
  compactions.delete(sessionId);
  retries.delete(sessionId);
  if (had) notify(sessionId);
}

export function useCompactionProgress(sessionId: string): CompactionProgress | null {
  return useSyncExternalStore(
    (onStoreChange) => subscribe(sessionId, onStoreChange),
    () => getCompactionProgress(sessionId),
  );
}

export function useRetryProgress(sessionId: string): RetryProgress | null {
  return useSyncExternalStore(
    (onStoreChange) => subscribe(sessionId, onStoreChange),
    () => getRetryProgress(sessionId),
  );
}

// ---------- pure display text ----------

/** design brief: "Compaction shows progress and retains errors/history." Null ⇒ no banner. */
export function compactionBannerText(p: CompactionProgress | null): string | null {
  if (!p) return null;
  if (p.state === 'started') return 'Compacting conversation…';
  if (p.state === 'failed') return p.message ? `Compaction failed: ${p.message}` : 'Compaction failed.';
  return null;
}

/** FR-8: a retry is progress inside the run, never its own notification. */
export function retryBannerText(p: RetryProgress | null): string | null {
  if (!p) return null;
  return `Retrying (attempt ${p.attempt})…`;
}
