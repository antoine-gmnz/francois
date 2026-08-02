// contract/notifications.ts — desktop notifications for blocked and finished
// turns. Authored from specs/notifications.md §5. Frontend-only: NO core
// boundary to mirror, NO IPC channel of our own. Imports the shared vocabulary
// from common.ts and never redefines it.

import type { SessionId, SessionStatus } from './common';

/** The two independently-toggleable notification classes (FR-7/FR-8/FR-17). */
export type NotifyClass = 'attention' | 'turnDone';

/** A settle status — the turn ended. */
export type SettleStatus = Extract<SessionStatus, 'idle' | 'error' | 'done'>;

/** What a consumed event resolved to, before gating (FR-6). */
export type NotifyTrigger =
  | { class: 'attention'; kind: 'approval'; sessionId: SessionId; toolName: string }
  | { class: 'attention'; kind: 'question'; sessionId: SessionId }
  | { class: 'turnDone'; kind: 'settle'; sessionId: SessionId; status: SettleStatus };

/** Notification title — a stable identity so pings group under the app name. */
export const NOTIFICATION_TITLE = 'Francois';

/** Reason phrase for a settled turn, keyed by status. */
export const SETTLE_REASON: Record<SettleStatus, string> = {
  idle: 'turn finished',
  error: 'error',
  done: 'done',
};

/**
 * The OS notification body: "<session name> · <reason>" (FR-11).
 *  approval → "api-refactor · needs approval: Bash"
 *  question → "api-refactor · needs an answer"
 *  settle   → "api-refactor · turn finished" | "· error" | "· done"
 * The separator is U+00B7, matching the app's separators. The ask summary and
 * tool input are deliberately NOT included — they would leak command text and
 * paths into the OS notification history.
 */
export function notificationBody(sessionName: string, t: NotifyTrigger): string {
  const reason =
    t.kind === 'approval' ? `needs approval: ${t.toolName}`
    : t.kind === 'question' ? 'needs an answer'
    : SETTLE_REASON[t.status];
  return `${sessionName} · ${reason}`;
}

/** Type guard: does this status end a turn? */
export function isSettleStatus(s: SessionStatus): s is SettleStatus {
  return s === 'idle' || s === 'error' || s === 'done';
}

/** localStorage keys for the per-class toggles (FR-17). Absent ⇒ on. */
export const NOTIFY_ENABLED_KEYS: Record<NotifyClass, string> = {
  attention: 'francois.notify.attention',
  turnDone: 'francois.notify.turnDone',
};

/** Palette + chip label for each class (FR-18/FR-19). */
export const NOTIFY_CLASS_LABEL: Record<NotifyClass, string> = {
  attention: 'approvals & questions',
  turnDone: 'turn finished',
};
