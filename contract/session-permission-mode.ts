// contract/session-permission-mode.ts — session-permission-mode.
// Physical Tauri binding: `francois:session:switchPermissionMode` → command
// `session_switch_permission_mode`, invoked as
// invoke('session_switch_permission_mode', { sessionId, mode }).
// The event stream is francois://session/event (owned by session-engine).

import type { PermissionMode, Result, SessionEvent, SessionId, SessionMeta } from './common';

/** francois:session:switchPermissionMode — frontend -> core. */
export interface SessionSwitchPermissionModeInput {
  sessionId: SessionId;
  /**
   * The new mode. The core re-validates it against PermissionMode and does NOT
   * trust the frontend's narrowing (FR-2); a value outside the union is
   * INVALID_INPUT, never a silent fallback to 'default'.
   */
  mode: PermissionMode;
}

/**
 * Result<SessionMeta> — the full updated snapshot, identical to the one carried by
 * the `session.meta` emission that accompanies it (FR-1).
 *
 * ok:false error codes:
 *  - 'SESSION_NOT_FOUND'   — no session with that id (FR-2)
 *  - 'SESSION_NOT_RUNNING' — status is terminal ('done' | 'error'); it cannot take
 *                            a turn, so a next-turn setting has nothing to act on (FR-2)
 *  - 'INVALID_INPUT'       — `mode` is not a PermissionMode member (FR-2)
 *  - 'INTERNAL'            — unexpected core failure
 */
export type SessionSwitchPermissionModeResponse = Result<SessionMeta>;

/** The only event this feature emits; the frontend's single update path (FR-12). */
export type PermissionModeHandledSessionEvent = Extract<SessionEvent, { type: 'session.meta' }>;

/**
 * FR-8: the single source for every PermissionMode presentation — the New Session
 * chips, the session-row badge label and the popover. Display order is this array's
 * order. Moved here from src/features/sessions/NewSessionModal.tsx; no component
 * maps a mode to a label, a short label or a hint on its own.
 *
 * `label` is the full name (popover, New Session chips); `short` is the badge's
 * compact form; `hint` is the plain-language consequence; `danger` drives the
 * danger tone on the chip, the option and the badge.
 */
export interface PermissionModeOption {
  mode: PermissionMode;
  label: string;
  short: string;
  hint: string;
  danger?: boolean;
}

export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    mode: 'default',
    label: 'default',
    short: 'default',
    hint: 'inherit your Claude settings (~/.claude)',
  },
  {
    mode: 'plan',
    label: 'plan',
    short: 'plan',
    hint: 'read & plan only — never edits or runs commands',
  },
  {
    mode: 'acceptEdits',
    label: 'accept edits',
    short: 'edits-ok',
    hint: 'auto-approve file edits; other tools follow your settings',
  },
  {
    mode: 'bypassPermissions',
    label: 'bypass',
    short: 'bypass',
    hint: 'skip every permission check — full access',
    danger: true,
  },
];
