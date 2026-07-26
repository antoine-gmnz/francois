// contract/remote-control.ts — specs/remote-control.md
//
// Francois HOSTS Claude Code's native Remote Control for a session: it spawns an
// interactive `claude … --remote-control <name>` in a PTY it owns, then learns the
// claude.ai session URL by tailing the CLI's own transcript for the
// `{"type":"system","subtype":"bridge_status", "url":…}` record. The URL lets the
// user pick that same Claude thread up from claude.ai/code or the Claude mobile app.
//
// Direction note: only Anthropic's web/mobile clients can DRIVE a Remote Control
// session — the relay is outbound HTTPS to api.anthropic.com with no local
// protocol. Francois is therefore the host, never the remote client.

import type { AppError, SessionId } from './common';

/**
 * Lifecycle of a session's Remote Control host process.
 *
 * `starting` → the PTY child is up but the CLI has not yet published a URL
 * (registration is a network round-trip; `bridge_status` lands a moment later).
 */
export type RemoteControlState =
  | { phase: 'off' }
  | { phase: 'starting'; name: string; startedAt: number }
  | { phase: 'active'; name: string; startedAt: number; url: string }
  | { phase: 'failed'; name: string; error: AppError };

export interface RemoteControlStatus {
  sessionId: SessionId;
  state: RemoteControlState;
}

// ---------- requests ----------

/**
 * francois:remote:start → `remote_start` → Result<RemoteControlStatus>
 *
 * Resolves `starting` as soon as the child is spawned — the caller waits for the
 * `remote.status` event to reach `active`. When the session already carries a
 * `claudeSessionId`, the host resumes that exact thread (`--resume <id>`), so the
 * conversation is continuous from Francois to the phone. Otherwise the core mints
 * a session id (`--session-id <uuid>`) so the transcript path is known up front.
 */
export interface StartRemoteControlRequest {
  sessionId: SessionId;
  /** Title shown in the session list at claude.ai/code. Defaults to the Francois
   * session name when omitted. */
  name?: string;
}

/**
 * francois:remote:stop → `remote_stop` → Result<RemoteControlStatus>
 * Kills the host process; resolves `{ phase: 'off' }`. Idempotent.
 */
export interface StopRemoteControlRequest {
  sessionId: SessionId;
}

/** francois:remote:get → `remote_get` → Result<RemoteControlStatus> */
export interface GetRemoteControlRequest {
  sessionId: SessionId;
}

// ---------- events: francois://remote/event ----------

export type RemoteControlEvent = {
  type: 'remote.status';
  sessionId: SessionId;
  state: RemoteControlState;
};
