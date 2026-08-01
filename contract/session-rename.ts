// contract/session-rename.ts — session-rename.
// Physical Tauri binding: `francois:session:rename` → command `session_rename`,
// invoked as invoke('session_rename', { sessionId, name }).
// The event stream is francois://session/event (owned by session-engine).

import type { SessionId, SessionMeta, Result, SessionEvent } from './common';

/** francois:session:rename — frontend -> core. */
export interface SessionRenameRequest {
  sessionId: SessionId;
  /** The raw user input. The core trims it, strips control characters and caps it at 80 chars (FR-1). */
  name: string;
}

/**
 * Result<SessionMeta> — the full updated snapshot, identical to the one carried by
 * the `session.meta` emission that accompanies it (FR-4).
 *
 * ok:false error codes:
 *  - 'SESSION_NOT_FOUND' — no session with that id (FR-3)
 *  - 'INVALID_INPUT'     — name empty after cleaning, or over 80 chars (FR-1)
 *  - 'INTERNAL'          — unexpected core failure
 */
export type SessionRenameResponse = Result<SessionMeta>;

// ---------- consumed (owned by session-engine; pinned here for build-ability) ----------

/** The only event this feature emits; the frontend's single update path (FR-13). */
export type RenameHandledSessionEvent = Extract<SessionEvent, { type: 'session.meta' }>;
