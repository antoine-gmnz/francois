// contract/sessions-sidebar.ts — sessions-sidebar (pane [1]).
// Authored from specs/sessions-sidebar.md §5. Imports shared vocabulary from
// common.ts; never redefines it.
//
// Physical Tauri binding: `francois:session:pickDirectory` → command
// `session_pick_directory`. The consumed session-engine channels bind per
// contract/session-engine.ts. The event stream is francois://session/event.

import type { SessionId, SessionMeta, ModelInfo, Result, SessionEvent, PermissionMode, ClaudeRuntime } from './common';

// ---------- owned by this feature ----------

/** francois:session:pickDirectory — frontend -> core, no payload. */
export type PickDirectoryRequest = void;

/** null = user cancelled the native OS directory dialog (not an error). */
export type PickDirectoryData = { path: string } | null;

/** Result<PickDirectoryData>; ok:false error codes: 'INTERNAL'. */
export type PickDirectoryResponse = Result<PickDirectoryData>;

/**
 * UI-side shape assembled by the new-session modal; sent as the payload of
 * francois:session:create (channel owned by session-engine).
 */
export interface NewSessionRequest {
  cwd: string;
  name: string;
  modelId: string;
  /** effort level (low/medium/high/xhigh/max); omit for the model default. */
  effort?: string;
  /** omit for 'default' (inherit ~/.claude settings). */
  permissionMode?: PermissionMode;
  /** omit for 'native'; 'wsl' runs claude inside WSL (Windows only). */
  runtime?: ClaudeRuntime;
}

// ---------- consumed (owned by session-engine; pinned here for build-ability) ----------

export type SessionListResponse = Result<SessionMeta[]>;
export type SessionModelsResponse = Result<ModelInfo[]>;
export type SessionCreateResponse = Result<SessionMeta>;

export interface SessionRemoveRequest {
  sessionId: SessionId;
}
export type SessionRemoveResponse = Result<null>;

/** sessions-sidebar handles only these SessionEvent members. */
export type SidebarHandledSessionEvent = Extract<
  SessionEvent,
  { type: 'session.meta' } | { type: 'session.status' } | { type: 'session.removed' }
>;

// ---------- shared frontend store fields owned by this feature ----------

export interface SessionsSidebarStoreSlice {
  /** App-wide active session. Written ONLY by sessions-sidebar; read by everyone else. */
  activeSessionId: SessionId | null;
  /** null = filter UI closed; non-null = open (value is the query, '' allowed). */
  sidebarFilter: string | null;
}
