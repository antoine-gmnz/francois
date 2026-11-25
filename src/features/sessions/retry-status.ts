// audit C4 — what a session waiting out a provider retry reads as, in the
// session header's state chip and the roster's RUNNING row. Pure; the clock
// is passed in so the countdown is testable.

import type { SessionMeta, SessionRetry } from '../../../contract/common';
import { isBusyStatus } from '../../../contract/fleet-board';

/**
 * The retry to show, or null. A retry is only real while the turn is live:
 * the core clears it on the next progress event, but a turn stopped mid-wait
 * may never produce one, so a settled session never reads as retrying.
 */
export function activeRetry(session: Pick<SessionMeta, 'status' | 'retry'>): SessionRetry | null {
  return session.retry && isBusyStatus(session.status) ? session.retry : null;
}

/** Whole seconds until `retryAt`, floored at 0; null when no delay was given. */
export function retryCountdown(retry: SessionRetry, now: number): number | null {
  if (retry.retryAt === undefined) return null;
  return Math.max(0, Math.ceil((retry.retryAt - now) / 1000));
}

function seconds(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The failed request's reason: its HTTP status, else the CLI's category. */
function reason(retry: SessionRetry): string | null {
  if (retry.errorStatus !== undefined) return String(retry.errorStatus);
  if (retry.error) return retry.error.replace(/_/g, ' ');
  return null;
}

/** "Retrying · attempt 2/10 · 429 · in 4s" — each part only when reported. */
export function retryLabel(retry: SessionRetry, now: number): string {
  const parts = ['Retrying', `attempt ${retry.attempt}${retry.maxRetries ? `/${retry.maxRetries}` : ''}`];
  const why = reason(retry);
  if (why) parts.push(why);
  const left = retryCountdown(retry, now);
  if (left !== null) parts.push(left > 0 ? `in ${seconds(left)}` : 'now');
  return parts.join(' · ');
}

/** The roster's shorter second line — the row already says it is running. */
export function retrySubLine(retry: SessionRetry, now: number): string {
  return retryLabel(retry, now).replace(/^Retrying/, 'retrying');
}
