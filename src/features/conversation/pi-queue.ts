// pi-turn-controls §5/§6 — the per-session Pi admissions ledger, mirrored
// client-side from `queue.changed` (ControlRuntimePayload, contract/common.ts).
// Same shape as ./pending-queue (a plain module map + a subscriber set, kept
// outside React so it survives ConversationView's keyed remount, plus a
// subscription because the strip renders this state directly) — but a
// DIFFERENT ledger entirely: transcript-perf's PendingPrompt is a client-only
// park list for the legacy `session_send` queue and stays untouched. Pi
// sessions never touch it; every other runtime never touches this module.
//
// `queue.changed` always carries the session's FULL pending ledger (contract
// comment) — this module is a pure mirror of the latest snapshot, never a
// diff/patch. A recoverable terminal entry ('cancelled' / 'delivery-unknown' /
// 'rejected') stays LISTED until the user removes it; only 'consumed' drops
// out (the transcript block is authoritative for those). Forgetting a row is
// therefore never local-only bookkeeping — `session_unqueue` (blockId =
// clientMessageId) removes any entry Pi does not own, and the FOLLOWING
// `queue.changed` is what actually clears it here (see ComposerPane's
// onUnqueue/onResend). Global bookkeeping (session removal) is wired from
// sessionsStore.ts, the one place every session's lifecycle is final.

import { useSyncExternalStore } from 'react';
import type { RuntimeQueueEntry } from '../../../contract/common';
import { MAX_MESSAGE_BYTES, MAX_PENDING_INTENTS } from '../../../contract/pi-turn-controls';

const ledgers = new Map<string, readonly RuntimeQueueEntry[]>();
const listeners = new Map<string, Set<() => void>>();

const EMPTY: readonly RuntimeQueueEntry[] = Object.freeze([]);

function notify(sessionId: string): void {
  const ls = listeners.get(sessionId);
  if (!ls) return;
  for (const l of ls) l();
}

/** The session's latest full ledger snapshot, exactly as `queue.changed` last reported it. */
export function getQueueEntries(sessionId: string): readonly RuntimeQueueEntry[] {
  return ledgers.get(sessionId) ?? EMPTY;
}

export function subscribeQueueEntries(sessionId: string, listener: () => void): () => void {
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

/** `queue.changed`'s handler — replaces the session's ledger snapshot wholesale. */
export function setQueueEntries(sessionId: string, entries: readonly RuntimeQueueEntry[]): void {
  ledgers.set(sessionId, entries);
  notify(sessionId);
}

/** Drops this session's ledger snapshot (session removal). */
export function clearQueueState(sessionId: string): void {
  if (!ledgers.has(sessionId)) return;
  ledgers.delete(sessionId);
  notify(sessionId);
}

/** This session's queue strip rows, reactive. */
export function useQueueEntries(sessionId: string): readonly RuntimeQueueEntry[] {
  return useSyncExternalStore(
    (onStoreChange) => subscribeQueueEntries(sessionId, onStoreChange),
    () => visibleQueueEntries(getQueueEntries(sessionId)),
  );
}

// ---------- pure helpers ----------

/** FR-4/FR-5: a message not yet handed to Pi's own queue. */
export function isLocalOnly(entry: Pick<RuntimeQueueEntry, 'state'>): boolean {
  return entry.state === 'admitting';
}

/** FR-3/FR-5/edge cases: a terminal row only an explicit user action can
 *  resolve — Resend (a NEW clientMessageId) or Discard. */
export function needsResend(entry: Pick<RuntimeQueueEntry, 'state'>): boolean {
  return entry.state === 'cancelled' || entry.state === 'delivery-unknown' || entry.state === 'rejected';
}

/**
 * FR-5 (amended): every ledger state `session_unqueue` can remove
 * individually — Pi has not made the entry its own yet ('admitting'), or it
 * already reached a terminal state the user can discard/resend. Only
 * 'queued' is Pi-owned and answers RUNTIME_UNSUPPORTED — "Clear queued
 * messages" (session_clear_queue) is the only action offered on those rows.
 */
export function canUnqueueIndividually(entry: Pick<RuntimeQueueEntry, 'state'>): boolean {
  return isLocalOnly(entry) || needsResend(entry);
}

/**
 * FR-3 (amended): whether a completed Resend should also unqueue the stale
 * OLD entry (mint-new-id semantics otherwise leaves the recovery row behind
 * next to the fresh one). Never on a failed resend — the user must not lose
 * the only copy of the text, so the old row stays put.
 */
export function shouldUnqueueAfterResend(resendOk: boolean): boolean {
  return resendOk;
}

/** The strip's actual rows: the live ledger, minus what the transcript
 *  already owns (a consumed entry became its own block, so it is never a
 *  queue row). */
export function visibleQueueEntries(entries: readonly RuntimeQueueEntry[]): RuntimeQueueEntry[] {
  return entries.filter((e) => e.state !== 'consumed');
}

/** FR-4/FR-5: entries Pi has not yet made its own — what "Clear queued messages" covers. */
export function clearableCount(entries: readonly RuntimeQueueEntry[]): number {
  return entries.filter((e) => e.state === 'admitting' || e.state === 'queued').length;
}

/** FR-4: the client-side pre-check mirroring the core's 20-pending-intents cap. */
export function isQueueFull(entries: readonly RuntimeQueueEntry[]): boolean {
  return clearableCount(entries) >= MAX_PENDING_INTENTS;
}

/** FR-4: the client-side pre-check mirroring the core's 1 MiB UTF-8 text cap. */
export function exceedsMessageByteCap(text: string): boolean {
  return new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES;
}

/** design brief "Data shown": the row's one-line status. */
export function queueEntryStatusLabel(entry: Pick<RuntimeQueueEntry, 'state' | 'queuePosition'>): string {
  switch (entry.state) {
    case 'admitting':
      return 'sending…';
    case 'queued':
      return entry.queuePosition !== undefined ? `queued #${entry.queuePosition}` : 'queued';
    case 'consumed':
      return 'sent';
    case 'cancelled':
      return 'not sent — stopped';
    case 'delivery-unknown':
      return 'delivery unknown';
    case 'rejected':
      return 'rejected';
  }
}
