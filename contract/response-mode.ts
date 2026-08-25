// contract/response-mode.ts — response-mode.
// Physical Tauri binding: `francois:session:switchResponseMode` → command
// `session_switch_response_mode`, invoked as
// invoke('session_switch_response_mode', { sessionId, mode }).
// The event stream is francois://session/event (owned by session-engine).

import type { Result, ResponseMode, SessionEvent, SessionId, SessionMeta } from './common';

/** francois:session:switchResponseMode — frontend -> core. */
export interface SessionSwitchResponseModeInput {
  sessionId: SessionId;
  /** The core re-validates this against ResponseMode; a value outside the union
   *  is INVALID_INPUT, never a silent fallback to 'default' (FR-3). */
  mode: ResponseMode;
}

/**
 * Result<SessionMeta> — the full updated snapshot, identical to the one carried by
 * the accompanying `session.meta` emission (FR-2).
 *
 * ok:false error codes:
 *  - 'SESSION_NOT_FOUND'   — no session with that id (FR-3)
 *  - 'SESSION_NOT_RUNNING' — status is terminal ('done' | 'error') (FR-3)
 *  - 'INVALID_INPUT'       — `mode` is not a ResponseMode member (FR-3)
 *  - 'INTERNAL'            — unexpected core failure
 */
export type SessionSwitchResponseModeResponse = Result<SessionMeta>;

/** The only event this feature emits; the frontend's single update path (FR-18). */
export type ResponseModeHandledSessionEvent = Extract<SessionEvent, { type: 'session.meta' }>;

/**
 * FR-13: the single source for every ResponseMode presentation — the run chip's
 * Response rows, the chip face, and the New Session chips. Display order is this
 * array's order. `label` is the full name, `short` the compact form the chip face
 * renders when the mode is non-default, `hint` the plain-language consequence.
 *
 * The DIRECTIVE TEXT is deliberately absent: it is core-owned (FR-6) and never
 * crosses the IPC boundary.
 */
export interface ResponseModeOption {
  mode: ResponseMode;
  label: string;
  short: string;
  hint: string;
}

export const RESPONSE_MODE_OPTIONS: ResponseModeOption[] = [
  { mode: 'default', label: 'default', short: 'default', hint: "the runtime's own style — no instruction added" },
  { mode: 'concise', label: 'concise', short: 'concise', hint: 'shortest useful answer; result first, no preamble' },
  { mode: 'explanatory', label: 'explanatory', short: 'explain', hint: 'says why it chose each non-obvious approach, inline' },
  { mode: 'learning', label: 'learning', short: 'learn', hint: 'leaves small pieces as TODO(human) and explains as it goes' },
];
