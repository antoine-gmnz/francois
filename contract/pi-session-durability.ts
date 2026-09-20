// contract/pi-session-durability.ts — Pi persistence, resume and recovery.
// Authored from specs/pi-session-durability.md §5.
//
// Shared presentation type `RuntimeRecovery` and the optional `SessionMeta.recovery`
// field live in common.ts (imported here, never redefined). This file owns the two
// recovery commands. Recovery status changes are published on the EXISTING
// `francois://session/event` channel as `session.meta` — no new event type.
//
// Core-private, deliberately NOT defined here: the persisted `PiResumeRecord`
// (nativeSessionId, nativeSessionFile, accountId, configDir, cwd, piVersion,
// lastEntryId, leafId, projectionVersion — spec §5 "Core-only persisted shape"), the
// projection checkpoint, and every native Pi entry DTO. The native file path never
// crosses IPC, and no command accepts an arbitrary replacement native path (FR-9).
import type { Result, SessionId, SessionMeta } from './common';

export type { RuntimeRecovery } from './common';

// ---------- francois:session:reconnect ----------
// invoke('session_reconnect', req: RuntimeReconnectInput): Promise<Result<SessionMeta>>
//
// Explicit, read-only re-attachment to the session's RECORDED native conversation
// (FR-3/FR-7). Validates the owned file location, exact native identity, pinned account
// and working directory, then reconnects and reconciles the projection. It never sends
// a prompt, never issues a model call, and never creates a fresh thread on failure.
//
// Resolves to the updated SessionMeta (its `recovery.state` is 'ready' on success).
// Errors: SESSION_NOT_FOUND · SESSION_BUSY · RUNTIME_UNAVAILABLE · RUNTIME_INCOMPATIBLE ·
//   RUNTIME_TIMEOUT · RUNTIME_PROTOCOL_ERROR · RUNTIME_SESSION_MISSING ·
//   RUNTIME_SESSION_CORRUPT · RUNTIME_ACCOUNT_MISSING · INTERNAL.
// Also, from gates this command runs before it may spawn anything:
//   RUNTIME_UNSUPPORTED — the session is not a Pi session (its `recovery` is absent and
//     stays absent; a healthy non-Pi session is never reported as missing).
//   ACCOUNT_CONFIG_UNTRUSTED · ACCOUNT_CONFIG_CHANGED — the pinned Pi account's
//     configuration is not trusted, or drifted since trust was recorded (pi-provider-auth
//     FR-4). Nothing executes and `recovery` is left unchanged.
// On any RUNTIME_SESSION_* / RUNTIME_ACCOUNT_MISSING / RUNTIME_INCOMPATIBLE failure the
// core also publishes `session.meta` with the matching non-ready `recovery` state, so the
// banner and the rejected promise never disagree.
export interface RuntimeReconnectInput {
  sessionId: SessionId;
}
export type RuntimeReconnectResult = Result<SessionMeta>;

// ---------- francois:session:newFrom ----------
// invoke('session_new_from', req: RuntimeNewFromSessionInput): Promise<Result<SessionMeta>>
//
// "Create new session" from a session whose native conversation cannot be resumed.
// Copies ONLY the validated cwd / project / account / profile snapshot / model settings
// into a NEW session id — no messages, no native resume anchor. It never auto-sends the
// prior prompt, and the source session is left untouched (its history stays readable).
// The result is a distinct sidebar item.
//
// `name`: optional display name for the new session, cleaned by the SAME rule as
// session-rename FR-1 (trimmed, control characters stripped, 1–80 chars; INVALID_INPUT when
// empty after cleaning or over the cap). Absent ⇒ the core derives one from the source's name.
// Errors: SESSION_NOT_FOUND · SESSION_BUSY · RUNTIME_UNSUPPORTED (not a Pi session) ·
//   RUNTIME_ACCOUNT_MISSING (the pinned account was removed — never falls back to a
//   default) · INVALID_INPUT · INTERNAL. It executes nothing, so it does NOT run the
//   configuration-trust gate: the new session meets that gate at its own first connect.
export interface RuntimeNewFromSessionInput {
  sessionId: SessionId;
  name?: string;
}
export type RuntimeNewFromSessionResult = Result<SessionMeta>;
