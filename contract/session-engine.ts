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
  AgentRuntime,
  AppError,
  BlockId,
  ModelInfo,
  SessionEvent,
  Result,
  PermissionMode,
  ClaudeRuntime,
  ProfileId,
  ResponseMode,
  DeliveryMode,
  RuntimeMessageReceipt,
  RuntimeModelRef,
  RuntimeQueueEntry,
  RuntimeResourcePolicy,
} from './common';
import type { WorktreeCreateOptions } from './session-worktree';
import type { PiProfileSettings } from './session-profiles';

// ---------- francois:session:create ----------

export interface SessionCreateInput {
  cwd: string; // absolute path; must exist and be a directory
  name?: string; // defaults to basename(cwd)
  modelId?: string; // defaults to the default model; from session:models
  accountId?: AccountId; // omitted uses the existing configured default-account resolution
  /**
   * pi-provider-auth: closes a contract drift — `session_create` has always
   * accepted this (linking the session to a project for standards/defaults);
   * it was simply never declared here. For a Pi account, `accountId` must
   * resolve to a Pi account and the runtime is derived from that account's
   * kind (its own `runtime`/`distro`, not this field).
   */
  projectId?: string;
  effort?: string; // Codex: selected model's advertised effort; omit/blank for model default
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
  /**
   * pi-models-metrics FR-4: REQUIRED for a Pi account, where it must be an exact pair
   * from a FRESH available snapshot (a stale cached catalogue does not authorize a new
   * session) and `modelId` is omitted. Other runtimes keep `modelId` semantics. Supplying
   * both fields is INVALID_INPUT; `modelId` alone for Pi is INVALID_INPUT.
   */
  runtimeModel?: RuntimeModelRef;
  /**
   * pi-skills-capabilities: REQUIRED for a Pi account, INVALID_INPUT for any other
   * runtime. `extensions` must be 'disabled'. `acknowledgedUnrestrictedTools` may be
   * false at creation — the core then refuses the first submit with
   * RUNTIME_POLICY_REQUIRED until it is recorded (FR-5).
   */
  resourcePolicy?: RuntimeResourcePolicy;
  /**
   * pi-migration-rollout: the Pi profile settings this session launches with — either
   * the saved profile's, or the New Session form's edited override of them. Requires a
   * Pi account. With `profileId` the core resolves the profile ITSELF, requires
   * `kind: 'pi'`, and snapshots its own name/settings — it never trusts the caller's
   * claim about what is saved. A legacy `profileId`, `systemPrompt` or `extraArgs` on a
   * Pi account, or `piProfile` on any other runtime, is PROFILE_RUNTIME_MISMATCH.
   * `piProfile.projectResources` is only the New Session form's INITIAL choice: the
   * frontend seeds its policy field from it, and the session's effective value is always
   * the explicit `resourcePolicy.projectResources` sent alongside (required for Pi). The
   * core does no seeding of its own, and a profile can never fabricate the acknowledgment.
   */
  piProfile?: PiProfileSettings;
}
// invoke('session_create', req: SessionCreateInput): Promise<Result<SessionMeta>>
// Added error codes for session-profiles: 'PROFILE_NOT_FOUND' | 'PROFILE_ARG_DENIED'.
// Added for the Pi tasks: 'MODEL_UNAVAILABLE' (pair absent from the fresh snapshot) ·
//   'PROFILE_RUNTIME_MISMATCH' · 'ACCOUNT_CONFIG_UNTRUSTED' · 'ACCOUNT_CONFIG_CHANGED'.

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
// pi-turn-controls FR-5: a message the Pi runtime already ACCEPTED ('queued') cannot be
// removed individually — that answers RUNTIME_UNSUPPORTED (use session_clear_queue).
// For a Pi session `blockId` carries the entry's `clientMessageId`, and the verb removes
// any entry Pi does NOT own: a local unsent intent, or a recoverable terminal entry
// ('cancelled' / 'delivery-unknown' / 'rejected'). This is how the strip's Discard — and
// the cleanup after a Resend minted a new id — forgets a row. `removed: true` is followed
// by one `queue.changed`; an unknown id is `removed: false`, never an error.

// ---------- francois:session:submit (NEW, pi-turn-controls) ----------
// The explicit-delivery send. Pi callers use this; session_send stays valid for the
// existing runtimes. Both route through ONE per-session admissions owner in the core —
// never two independent queues.

export interface RuntimeMessageInput {
  sessionId: SessionId;
  /** uuid v4, client-minted. Retrying an id returns its CURRENT receipt without sending
   *  again; the same id with different content is INVALID_INPUT (FR-4). */
  clientMessageId: string;
  text: string; // non-empty after trim; at most 1 MiB of UTF-8
  delivery: DeliveryMode;
  attachmentIds: string[]; // existing attachment ids; existing count/size caps apply
}
// invoke('session_submit', req: RuntimeMessageInput): Promise<Result<RuntimeMessageReceipt>>
//   (flat payload, like every other command here — the fields ARE the command's args)
//   Acceptance creates/updates a PENDING ledger entry (published as `queue.changed`);
//   the transcript block is created only by the consumed `message.user` runtime event.
//   errors: SESSION_NOT_FOUND · INVALID_INPUT (steer while idle, empty/oversized text,
//     id reuse with different content, unsupported image input) · SESSION_BUSY (normal
//     while busy, or stopping) · QUEUE_FULL (20 pending) · RUNTIME_UNSUPPORTED ·
//     RUNTIME_POLICY_REQUIRED · RUNTIME_EXITED · RUNTIME_TIMEOUT · RUNTIME_PROTOCOL_ERROR ·
//     PROVIDER_AUTH_FAILED · PROVIDER_UNAVAILABLE · INTERNAL

// ---------- francois:session:clearQueue (NEW, pi-turn-controls) ----------

export interface RuntimeQueueClearInput {
  sessionId: SessionId;
}
export interface RuntimeQueueClearOutput {
  /** Every entry the clear removed, state 'cancelled', text intact — the composer turns
   *  them back into recoverable drafts. Consumed messages are never in this list. */
  entries: RuntimeQueueEntry[];
}
// invoke('session_clear_queue', req: RuntimeQueueClearInput): Promise<Result<RuntimeQueueClearOutput>>
//   errors: SESSION_NOT_FOUND · RUNTIME_UNSUPPORTED · RUNTIME_EXITED · RUNTIME_TIMEOUT ·
//     RUNTIME_PROTOCOL_ERROR · INTERNAL

export type { DeliveryMode, RuntimeMessageReceipt, RuntimeQueueEntry };

// ---------- francois:session:acknowledgePolicy (NEW, pi-skills-capabilities FR-5) ----------
// LEAD ADDITION at build time — specs/pi-skills-capabilities.md §5 requires the core to
// refuse the first submit while `acknowledgedUnrestrictedTools` is false, but names no
// verb that records the acknowledgment AFTER creation. Without one, a session created
// unacknowledged (session_new_from copies settings into a NEW session, which needs its
// own acknowledgment) could never send. This is the minimal verb that closes that.

export interface RuntimePolicyAcknowledgeInput {
  sessionId: SessionId;
}
// invoke('session_acknowledge_policy', req: RuntimePolicyAcknowledgeInput): Promise<Result<SessionMeta>>
//   Sets `resourcePolicy.acknowledgedUnrestrictedTools = true`, persists it, and publishes
//   one `session.meta`. Idempotent. It changes NOTHING else: `projectResources` and
//   `extensions` stay pinned, and it never becomes an allow/deny tool rule.
//   errors: SESSION_NOT_FOUND · RUNTIME_UNSUPPORTED (not a Pi session) · INTERNAL

// ---------- francois:session:interrupt ----------

export interface SessionInterruptInput {
  sessionId: SessionId;
}
// invoke('session_interrupt', req: SessionInterruptInput): Promise<Result<null>>
// pi-turn-controls FR-6/FR-7, for a Pi session: resolves only AFTER the stop is confirmed
// (admission closed → clear_queue → abort → clear again once idle → settled). Idle Stop and
// a second Stop are no-op successes. RUNTIME_TIMEOUT / RUNTIME_EXITED when cleanup could
// not be confirmed inside the 5 s budget — the tracked child tree is then terminated and
// uncertain entries become 'delivery-unknown'. Drained messages never auto-start after it.

// ---------- francois:session:switchModel ----------

export interface SessionSwitchModelInput {
  sessionId: SessionId;
  /** Existing runtimes. Exactly one of `modelId` / `runtimeModel`; both ⇒ INVALID_INPUT. */
  modelId?: string;
  /** pi-models-metrics FR-5: required for a Pi session. Accepted only when the session is
   *  settled with no dispatch or compaction pending (else SESSION_BUSY). The core sends
   *  the change, then READS BACK state before publishing metadata; on failure the
   *  previous selection is preserved. */
  runtimeModel?: RuntimeModelRef;
}
// invoke('session_switch_model', req: SessionSwitchModelInput): Promise<Result<SessionMeta>>
//   Pi adds: SESSION_BUSY · MODEL_UNAVAILABLE · PROVIDER_AUTH_FAILED · RUNTIME_UNAVAILABLE ·
//     RUNTIME_TIMEOUT · RUNTIME_PROTOCOL_ERROR. A success also emits `model.changed`.

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
   * non-blank Codex value against the selected model's advertised efforts
   * (other runtimes retain their existing validation) and answers INVALID_INPUT
   * rather than silently falling back, which would read as "the pick did not take".
   */
  effort?: string | null;
}
// invoke('session_switch_effort', req: SessionSwitchEffortInput): Promise<Result<SessionMeta>>
//   ok:false — 'SESSION_NOT_FOUND' | 'SESSION_NOT_RUNNING' | 'INVALID_INPUT' | 'INTERNAL'
//   Accompanied by exactly one `session.meta` emission carrying the same snapshot.
//   pi-models-metrics FR-6, for a Pi session: levels are the ones the runtime REPORTS for
//   the current model (never Claude's subset). An unsupported level is INVALID_INPUT — a
//   clamped value is never silently accepted; the published effort is the read-back one.
//   Adds SESSION_BUSY (not settled) and RUNTIME_UNSUPPORTED (model reports no levels).

// ---------- francois:session:compact ----------

export interface SessionCompactInput {
  sessionId: SessionId;
}
// invoke('session_compact', req: SessionCompactInput): Promise<Result<null>>
// pi-turn-controls FR-8, for a Pi session: goes through the session's OWN runtime
// connection (never a claude side-spawn), is accepted only while idle (else SESSION_BUSY),
// and resolves on COMPLETION under the 180 s operation deadline. A failed compaction
// keeps the conversation and its display history intact and reports the error.

// ---------- francois:session:list  (no payload) ----------
// invoke('session_list'): Promise<Result<SessionMeta[]>>
//   Side effect (FR-12): re-emits one `session.meta` per registry entry, in
//   registry order, on francois://session/event before resolving.

// ---------- francois:session:models ----------

/** Account resolved at request time; discovery emits no session event. */
export interface SessionModelsInput {
  accountId?: AccountId; // omitted -> 'default'; trimmed; explicit blank -> INVALID_INPUT
  refresh?: boolean; // omitted -> false; bypasses age freshness only
}

export interface ModelCatalog {
  accountId: AccountId;
  agentRuntime: AgentRuntime;
  models: ModelInfo[];
  defaultModelId: string | null;
  source: 'codex-app-server' | 'memory-cache' | 'legacy-adapter';
  freshness: 'fresh' | 'stale' | 'unverified';
  fetchedAt: number | null; // epoch ms of successful core probe; null for legacy
  warning: AppError | null;
}

export type SessionModelsResponse = Result<ModelCatalog>;
export type ModelCatalogFailureReason =
  | 'timeout' | 'protocol' | 'unsupported-cli' | 'runtime' | 'limit';
export interface ModelCatalogFailureDetail { reason: ModelCatalogFailureReason }

// invoke('session_models', req?: SessionModelsInput): Promise<SessionModelsResponse>
// Errors: INVALID_INPUT, ACCOUNT_NOT_FOUND, ACCOUNT_NOT_AUTHENTICATED,
// SPAWN_FAILED, MODEL_CATALOG_UNAVAILABLE, INTERNAL; legacy adapter errors unchanged.
// Codex mutations validate against this same catalogue before side effects.
// An explicit incompatible effort rejects atomically; a model change clears an
// incompatible inherited effort. Clear-only effort/unrelated edits do not probe.
// Discovery never changes persisted selections. See specs/codex-model-catalog.md §5.

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
