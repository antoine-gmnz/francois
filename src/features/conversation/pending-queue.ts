// transcript-perf §6 — the per-session PENDING QUEUE: prompts sent while a
// turn was busy, parked here instead of entering the transcript (FR-10). A
// plain module map + a subscriber set, the same shape as ./composer-draft and
// for the same reason (ConversationView is keyed by sessionId and remounts —
// this must outlive that, FR-15), plus a subscription because — unlike the
// draft — the strip actually RENDERS this state and must re-render when it
// changes (design brief: "a subscription so the strip re-renders").
//
// Global bookkeeping (message.user drains an entry, session.cleared/session.error
// clear the whole queue) is wired from useSessionFleetSync — the one place a
// SessionEvent for ANY session, mounted or not, is always heard. See its
// onMessageUser/onCleared/onError callbacks.

import { useSyncExternalStore } from 'react';

export interface PendingPrompt {
  blockId: string;
  text: string;
}

const queues = new Map<string, PendingPrompt[]>();
const listeners = new Map<string, Set<() => void>>();

const EMPTY: readonly PendingPrompt[] = Object.freeze([]);

function notify(sessionId: string): void {
  const ls = listeners.get(sessionId);
  if (!ls) return;
  for (const l of ls) l();
}

/** This session's pending queue, FIFO order. Empty (frozen) for an unknown session. */
export function getPending(sessionId: string): readonly PendingPrompt[] {
  return queues.get(sessionId) ?? EMPTY;
}

export function subscribePending(sessionId: string, listener: () => void): () => void {
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

/** FR-10: park a prompt. Idempotent on a replayed blockId. */
export function parkPrompt(sessionId: string, blockId: string, text: string): void {
  const list = queues.get(sessionId) ?? [];
  if (list.some((p) => p.blockId === blockId)) return;
  queues.set(sessionId, [...list, { blockId, text }]);
  notify(sessionId);
}

/**
 * FR-12/FR-13/FR-17: remove one entry by blockId — the drain (message.user),
 * a failed send, or a successful `session_unqueue`. A no-op (no notify) when
 * the id was never parked, so every caller can call this unconditionally.
 */
export function resolvePrompt(sessionId: string, blockId: string): void {
  const list = queues.get(sessionId);
  if (!list) return;
  const next = list.filter((p) => p.blockId !== blockId);
  if (next.length === list.length) return;
  if (next.length === 0) queues.delete(sessionId);
  else queues.set(sessionId, next);
  notify(sessionId);
}

/**
 * FR-14: drop the WHOLE queue — session.cleared, a session.error (transient or
 * terminal; the core's own s.queue.clear() runs on every errored turn end
 * regardless of code), and session.removed (via dropDerived) all land here.
 */
export function clearPending(sessionId: string): void {
  if (!queues.has(sessionId)) return;
  queues.delete(sessionId);
  notify(sessionId);
}

/** This session's pending queue, reactive. */
export function usePendingQueue(sessionId: string): readonly PendingPrompt[] {
  return useSyncExternalStore(
    (onStoreChange) => subscribePending(sessionId, onStoreChange),
    () => getPending(sessionId),
  );
}

// ---------- pure helpers ----------

/** design brief "Pending row": the row shows the prompt's FIRST line only. */
export function firstLine(text: string): string {
  const i = text.indexOf('\n');
  return i === -1 ? text : text.slice(0, i);
}

/**
 * FR-17: appended to the composer draft, separated by a newline when the
 * draft is non-empty.
 */
export function appendToDraft(draft: string, text: string): string {
  return draft === '' ? text : `${draft}\n${text}`;
}

/**
 * FR-11: the composer guesses busy/idle from `status` before the round trip;
 * the response's `queued` is authoritative. The only wrong guess that needs
 * correcting client-side is "guessed idle, actually queued" — an optimistic
 * transcript block was dispatched that must come back out and be parked
 * instead. The opposite miss ("guessed busy, actually ran now") is already
 * correctly parked and self-resolves at the next `message.user` (FR-12), so
 * there is nothing to undo.
 */
export function wasWronglyOptimistic(guessedBusy: boolean, queued: boolean): boolean {
  return !guessedBusy && queued;
}
