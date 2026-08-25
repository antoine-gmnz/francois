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

import type {
  SessionId,
  AccountId,
  BlockId,
  ModelInfo,
  SessionEvent,
  Result,
  PermissionMode,
  ClaudeRuntime,
  ProfileId,
  ResponseMode,
} from './common';
import type { WorktreeCreateOptions } from './session-worktree';

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
  /** omit to create a normal (non-isolated) session; see session-worktree.ts. */
  worktree?: WorktreeCreateOptions;
  /** Resolved (post-edit) prompt text; present ⇒ --system-prompt on every turn (session-profiles FR-12/FR-13). */
  systemPrompt?: string;
  /** Resolved argv tokens, appended last. Re-validated against DENIED_ARG_FLAGS (session-profiles FR-11). */
  extraArgs?: string[];
  /** The profile the values came from; the core snapshots its name itself (session-profiles FR-15). */
  profileId?: ProfileId;
  /** omit for 'default'. Applied to every turn incl. --resume (response-mode FR-7). */
  responseMode?: ResponseMode;
}
// invoke('session_create', req: SessionCreateInput): Promise<Result<SessionMeta>>
// Added error codes for session-profiles: 'PROFILE_NOT_FOUND' | 'PROFILE_ARG_DENIED'.

// ---------- francois:session:remove ----------

export interface SessionRemoveInput {
  sessionId: SessionId;
}
// invoke('session_remove', req: SessionRemoveInput): Promise<Result<null>>

// ---------- francois:session:send (amended, transcript-perf FR-20) ----------

export interface SessionSendInput {
  sessionId: SessionId;
  /** Client-minted so the optimistic block matches the eventual message.user
   *  (conversation-view FR-15/21). Already sent and already accepted by the
   *  core — declared here to close the drift. Omitted ⇒ the core mints one. */
  blockId?: BlockId;
  text: string; // non-empty after trim
}

export interface SessionSendOutput {
  queued: boolean; // true if a turn was already in flight and this text was enqueued
  queuePosition?: number; // 1-based FIFO position; present iff queued === true
}
// invoke('session_send', req: SessionSendInput): Promise<Result<SessionSendOutput>>
// errors: SESSION_NOT_FOUND · SESSION_NOT_RUNNING · INVALID_INPUT (empty text, queue full)

// ---------- francois:session:unqueue (NEW, transcript-perf FR-19) ----------

export interface SessionUnqueueInput {
  sessionId: SessionId;
  blockId: BlockId; // the id session:send was called with
}

export interface SessionUnqueueOutput {
  /** false ⇒ the turn already drained it (or it was never queued); the caller
   *  leaves the composer alone and lets message.user clear the row. */
  removed: boolean;
}
// invoke('session_unqueue', req: SessionUnqueueInput): Promise<Result<SessionUnqueueOutput>>
// errors: SESSION_NOT_FOUND

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

// ---------- francois:session:switchEffort ----------

/**
 * rework-top-bar (design 11c) — the twin of switchModel above, for the property
 * that lives INSIDE the model row in the run chip's panel. Like the permission
 * mode it only ever reaches the NEXT turn.
 */
export interface SessionSwitchEffortInput {
  sessionId: SessionId;
  /**
   * The level, or omitted/null to CLEAR it and hand the model back its own
   * default — a real choice, not an error, and the only state available for a
   * model whose ModelInfo advertises no `efforts`. The core re-validates a
   * non-blank value against low|medium|high|xhigh|max and answers INVALID_INPUT
   * rather than silently falling back, which would read as "the pick did not take".
   */
  effort?: string | null;
}
// invoke('session_switch_effort', req: SessionSwitchEffortInput): Promise<Result<SessionMeta>>
//   ok:false — 'SESSION_NOT_FOUND' | 'SESSION_NOT_RUNNING' | 'INVALID_INPUT' | 'INTERNAL'
//   Accompanied by exactly one `session.meta` emission carrying the same snapshot.

// ---------- francois:session:compact ----------

export interface SessionCompactInput {
  sessionId: SessionId;
}
// invoke('session_compact', req: SessionCompactInput): Promise<Result<null>>

// ---------- francois:session:list  (no payload) ----------
// invoke('session_list'): Promise<Result<SessionMeta[]>>
//   Side effect (FR-12): re-emits one `session.meta` per registry entry, in
//   registry order, on francois://session/event before resolving.

// ---------- francois:session:models ----------

/**
 * multi-provider-openai FR-18/FR-21's account-keyed wire fix: `accountId`,
 * NOT `sessionId` — the model picker's only mount is the New Session modal
 * (`useModelCatalog`), which is choosing a model in order to create a
 * session and so has no session id yet, only the account the user picked in
 * the form. Omitted/undefined (every pre-existing call site — the palette
 * prefetch, the project registry warm-up) resolves EXACTLY as before, the
 * default account's Claude Code catalog. When present and resolvable, the
 * core routes through THAT account's own runtime (derived from its
 * `AccountKind`), which is what makes an `openai-compatible` account's model
 * list reachable at all.
 */
export interface SessionModelsInput {
  accountId?: AccountId;
}
// invoke('session_models', req?: SessionModelsInput): Promise<Result<ModelInfo[]>>

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
