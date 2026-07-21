// contract/session-engine.ts — session-engine (Rust core backbone).
// Authored from specs/session-engine.md §5. Imports shared vocabulary from
// common.ts; never redefines it. The SessionEvent union and SessionMeta /
// ModelInfo / AgentInfo / McpServerInfo all live in common.ts — this feature
// adds no members to them.
//
// Physical Tauri binding (PIPELINE.md): request channel
// `francois:session:<verb>` → Tauri command `session_<verb>`; the event stream
// `francois:session:event` → Tauri event `francois://session/event`. Every
// command RESOLVES a `Result<T>` (never rejects across the bridge).

import type { SessionId, ModelInfo, SessionEvent, Result, PermissionMode, ClaudeRuntime } from './common';

// ---------- francois:session:create ----------

export interface SessionCreateInput {
  cwd: string; // absolute path; must exist and be a directory
  name?: string; // defaults to basename(cwd)
  modelId?: string; // defaults to the default model; from session:models
  effort?: string; // effort level (low/medium/high/xhigh/max); omit for model default
  /** omit for 'default' (inherit ~/.claude settings). Passed to every turn incl. --resume. */
  permissionMode?: PermissionMode;
  /** omit for 'native'. 'wsl' is INVALID_INPUT off Windows. */
  runtime?: ClaudeRuntime;
}
// invoke('session_create', req: SessionCreateInput): Promise<Result<SessionMeta>>

// ---------- francois:session:remove ----------

export interface SessionRemoveInput {
  sessionId: SessionId;
}
// invoke('session_remove', req: SessionRemoveInput): Promise<Result<null>>

// ---------- francois:session:send ----------

export interface SessionSendInput {
  sessionId: SessionId;
  text: string; // non-empty after trim
}

export interface SessionSendOutput {
  queued: boolean; // true if a turn was already in flight and this text was enqueued
  queuePosition?: number; // 1-based FIFO position; present iff queued === true
}
// invoke('session_send', req: SessionSendInput): Promise<Result<SessionSendOutput>>

// ---------- francois:session:interrupt ----------

export interface SessionInterruptInput {
  sessionId: SessionId;
}
// invoke('session_interrupt', req: SessionInterruptInput): Promise<Result<null>>

// ---------- francois:session:switchModel ----------

export interface SessionSwitchModelInput {
  sessionId: SessionId;
  modelId: string;
}
// invoke('session_switch_model', req: SessionSwitchModelInput): Promise<Result<SessionMeta>>

// ---------- francois:session:compact ----------

export interface SessionCompactInput {
  sessionId: SessionId;
}
// invoke('session_compact', req: SessionCompactInput): Promise<Result<null>>

// ---------- francois:session:list  (no payload) ----------
// invoke('session_list'): Promise<Result<SessionMeta[]>>
//   Side effect (FR-12): re-emits one `session.meta` per registry entry, in
//   registry order, on francois://session/event before resolving.

// ---------- francois:session:models  (no payload) ----------
// invoke('session_models'): Promise<Result<ModelInfo[]>>

// ---------- v1 static model catalog (§5.1) ----------
// Mirrors the Rust core's catalog; UIs may use it directly for labels.
// v1 note: session_models now fetches the account's LIVE model list from the
// Anthropic /v1/models endpoint (using Claude Code's OAuth token) so newly
// released models appear without a redeploy. This static list is only the
// fallback the core returns when that fetch fails (no token / offline). `id` is
// passed verbatim to `claude --model <id>` — tier aliases and full ids both work.
export const MODEL_CATALOG_FALLBACK: ReadonlyArray<ModelInfo & { contextLimitTokens: number }> = [
  { id: 'sonnet', label: 'Sonnet', contextLimitTokens: 200_000 },
  { id: 'opus', label: 'Opus', contextLimitTokens: 200_000 },
  { id: 'haiku', label: 'Haiku', contextLimitTokens: 200_000 },
];
export const DEFAULT_MODEL_ID = 'sonnet';

// ---------- event channel ----------
// francois://session/event carries `SessionEvent` (from common.ts).
export type { SessionEvent, Result };
