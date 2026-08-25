// contract/session-settings-sheet.ts — session-settings-sheet.
// Physical Tauri binding: `francois:session:updateSettings` → command `session_update_settings`,
// invoked as invoke('session_update_settings', { sessionId, patch }).
// No new event: the feature consumes `session.meta` (owned by session-engine) and reuses
// `francois:project:update` (projects) and `francois:session:create` (session-engine) unchanged.

import type { PermissionMode, ResponseMode, Result, SessionId, SessionMeta } from './common';

/** The changed keys only. An absent key means "leave alone"; no key is ever null. */
export interface SessionSettingsPatch {
  /** Trimmed, 1–80 chars — the same rule session_rename enforces (`validate_session_name`).
   *  (The spec's §5 "1–200" is a slip; the rule it names is authoritative.) */
  name?: string;
  /** Must be a model id the session's ACCOUNT advertises. */
  modelId?: string;
  /** '' clears back to the model's own default, mirroring session_switch_effort. */
  effort?: string;
  permissionMode?: PermissionMode;
  responseMode?: ResponseMode;
  allowGit?: boolean;
}

/** francois:session:updateSettings — frontend → core. Tauri: `session_update_settings`. */
export interface SessionUpdateSettingsRequest {
  sessionId: SessionId;
  patch: SessionSettingsPatch;
}

/**
 * Result<SessionMeta> — the post-write snapshot, identical to the one carried by the single
 * `session.meta` this verb emits.
 *
 * ok:false error codes:
 *  - 'SESSION_NOT_FOUND'    — no session with that id (§7 case 1)
 *  - 'SESSION_NOT_RUNNING'  — session is done/error and the patch touches a run key (§7 case 2)
 *  - 'INVALID_INPUT'        — an enum/modelId/name failed re-validation; nothing written (§7 cases 3–5)
 *  - 'INTERNAL'             — unexpected core failure after the in-memory write (§7 case 6)
 */
export type SessionUpdateSettingsResponse = Result<SessionMeta>;

/** Which patch keys take effect only from the session's next turn (FR-5, FR-15). */
export const NEXT_TURN_KEYS = ['modelId', 'effort', 'permissionMode', 'responseMode'] as const;
export type NextTurnKey = (typeof NEXT_TURN_KEYS)[number];

/** Label used in the foot's timing line, keyed by patch key (FR-15). */
export const SETTING_LABELS: Record<keyof SessionSettingsPatch, string> = {
  name: 'name',
  modelId: 'model',
  effort: 'effort',
  permissionMode: 'permissions',
  responseMode: 'response',
  allowGit: 'git',
};
