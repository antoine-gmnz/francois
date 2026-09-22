// contract/common.ts — shared vocabulary for all Francois feature contracts.
// Feature contracts (contract/<feature-id>.ts) import from this file and never redefine these types.
// Specs reference these names verbatim.

// ---------- primitives ----------

export type SessionId = string; // uuid v4
export type AgentId = string; // uuid v4
export type BlockId = string; // uuid v4 — one conversation block (message, tool call, …)
/** uuid v4, or the reserved 'default' (the built-in account, multi-account FR-2). */
export type AccountId = string;

/** Every fallible IPC call resolves to this — never throws across IPC. */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppError };

export interface AppError {
  code: ErrorCode;
  message: string; // human-readable, safe to render
  detail?: unknown;
  /** Sanitized runtime provenance; raw provider and Pi RPC payloads never cross IPC. */
  runtimeFailure?: RuntimeFailure;
}

export type ErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_RUNNING'
  | 'SESSION_ALREADY_RUNNING'
  | 'SPAWN_FAILED'
  | 'MODEL_CATALOG_UNAVAILABLE' // codex-model-catalog: detail is ModelCatalogFailureDetail
  | 'INVALID_INPUT'
  | 'GIT_ERROR'
  | 'NOT_A_GIT_REPO'
  | 'PTY_ERROR'
  | 'MCP_ERROR'
  | 'MCP_APPROVAL_REQUIRED' // mcp-panel: an interactive spawn (remote-control) would park on the consent/trust dialog (detail: McpApprovalState)
  | 'SKILL_ERROR'
  | 'AGENT_NOT_FOUND'
  | 'APP_NOT_RUNNING' // CLI companion: no app instance to talk to
  | 'USAGE_UNAVAILABLE' // usage bar: the CLI ran but returned no parseable meters
  | 'QUESTION_NOT_PENDING' // session-questions: answer arrived for a question that is not pending
  | 'PERMISSION_NOT_PENDING' // permission-guardrails: decision arrived for an ask that is not pending
  | 'SETTINGS_WRITE_FAILED' // permission-guardrails: settings.json could not be read-merged-written
  | 'RULE_NOT_FOUND' // permission-guardrails: editor mutation addressed an unknown rule id
  | 'PROJECT_NOT_FOUND' // projects: a projectId that is not in the registry
  | 'PROJECT_DUPLICATE_ROOT' // projects: another project already owns that normalized root
  | 'PROJECT_ROOT_MISSING' // projects: the project's root no longer exists on disk
  | 'STANDARDS_WRITE_FAILED' // projects: CLAUDE.md could not be read-merged-written
  | 'GROUP_NOT_FOUND' // project-groups: a groupId that is not in the registry
  | 'REMOTE_CONTROL_FAILED' // remote-control: the host process died, or published no URL before the deadline
  | 'WORKTREE_BRANCH_IN_USE' // session-worktree: the branch is already checked out at another path (detail: { path })
  | 'WORKTREE_CREATE_FAILED' // session-worktree: prune/add failed; the core reversed what it did (FR-11)
  | 'WORKTREE_DIRTY' // session-worktree: removal refused: uncommitted changes or unpushed commits (FR-19)
  | 'WORKTREE_NOT_FOUND' // session-worktree: no worktree registered at that path
  | 'ATTACHMENT_TOO_LARGE' // session-attachments FR-8: over the 10 MiB cap (detail: { bytes, cap })
  | 'ATTACHMENT_IS_DIRECTORY' // session-attachments FR-8: folders are refused, not walked
  | 'ATTACHMENT_NOT_FOUND' // session-attachments: release addressed an unknown attachment id
  | 'ATTACHMENT_IO_FAILED' // session-attachments: copy/write/delete failed (detail: { path })
  | 'ACCOUNT_NOT_FOUND' // multi-account: an accountId that is not in the registry
  | 'ACCOUNT_NOT_REMOVABLE' // multi-account: attempted removal of the built-in 'default' account
  | 'ACCOUNT_DUPLICATE' // multi-account: login identity matches an already-registered account (FR-14)
  | 'ACCOUNT_LOGIN_FAILED' // multi-account: login timed out or the PTY exited without an identity (FR-15)
  | 'ACCOUNT_NOT_AUTHENTICATED' // multi-account: a turn's account has no credentials on disk (FR-22)
  | 'ACCOUNT_ENDPOINT_UNREACHABLE' // multi-provider-endpoint: the base URL did not answer a usable /models
  | 'ACCOUNT_ENDPOINT_UNAUTHORIZED' // multi-provider-endpoint: the endpoint rejected the key (401/403)
  | 'ACCOUNT_KEY_WRITE_FAILED' // multi-provider-endpoint: the key file could not be written or removed
  | 'ACCOUNT_IN_USE' // pi-provider-auth: trust/remove refused while a session or setup PTY holds the account
  | 'ACCOUNT_CONFIG_UNTRUSTED' // pi-provider-auth: a Pi account's configDir was never explicitly trusted
  | 'ACCOUNT_CONFIG_CHANGED' // pi-provider-auth FR-4: the trusted executable-config fingerprint no longer matches
  | 'CLI_INSTALL_UNAVAILABLE' // multi-account: npm is not on PATH, so no vendor CLI can be installed from here
  | 'CLI_INSTALL_FAILED' // multi-account: `npm i -g <package>` exited non-zero (detail: { code, tail })
  | 'WORKFLOW_NOT_FOUND' // workflow-details: runId matches no run this session has seen
  | 'WORKFLOW_NO_TRANSCRIPT' // workflow-details FR-2/FR-7: the run has no usable transcriptDir
  | 'WORKFLOW_AGENT_NOT_FOUND' // workflow-details FR-8: agentId matches no agent the scan has seen
  | 'WORKFLOW_NO_SCRIPT' // workflow-details FR-9: the run has no readable scriptPath
  | 'UPDATE_CHECK_FAILED' // self-update: the npm registry was unreachable or unparseable (FR-6)
  | 'UPDATE_APPLY_FAILED' // self-update: npm/temp dir/spawn failed, or method is 'manual' (FR-18)
  | 'UPDATE_BLOCKED' // self-update: sessions are running (detail: { running: number }) (FR-12)
  | 'EDITOR_NOT_FOUND' // open-in-vscode: the requested editorId is not installed (detail: { editorId })
  | 'EDITOR_LAUNCH_FAILED' // open-in-vscode: the launcher could not be spawned (detail: { path })
  | 'SHELL_NOT_FOUND' // multiple-shells: no entry for that ShellId (unknown, disposed, or another session's)
  | 'SHELL_LIMIT_REACHED' // multiple-shells: shell_create at the 6-shell-per-session cap (FR-2)
  | 'STEP_DETAIL_NOT_FOUND' // command-inspect FR-11: no record for that blockId (never captured, or swept)
  // session-engine: the turn died on the plan's usage limit (or an API rate
  // limit). Carried by `session.error` and NOT terminal — the core sends the
  // session back to `idle` because the window resets on its own clock and emits
  // nothing when it does. Consumers must surface it as a transient notice, never
  // as a dead session.
  | 'USAGE_LIMIT'
  | 'CLOUD_AUTH_REQUIRED' // cloud-sessions FR-1: no claude.ai token; API-key auth is not sufficient (`no_access_token`)
  | 'CLOUD_AUTH_EXPIRED' // cloud-sessions FR-1: token past `expiresAt`, or the API said so; run a turn or `/login`
  | 'CLOUD_DEVICE_UNTRUSTED' // cloud-sessions: `untrusted_device`; enrol the device with `/login`
  | 'CLOUD_POLICY_DENIED' // cloud-sessions: the org's `allow_remote_sessions` policy is off
  | 'CLOUD_SESSION_NOT_FOUND' // cloud-sessions: unknown/invalid cloud session id
  | 'CLOUD_REPO_MISMATCH' // cloud-sessions FR-8: teleport's mismatch/not_in_repo/host_unverified (detail: { sessionRepo, currentRepo })
  | 'CLOUD_ADOPT_STALLED' // cloud-sessions FR-8/FR-9: a blocking dialog or the deadline (detail: { phase, logPath? })
  | 'CLOUD_ADOPT_FAILED' // cloud-sessions FR-6: the PTY exited without a usable local session (detail: { logPath? })
  | 'PROVIDER_REQUEST_FAILED' // multi-provider-openai: the endpoint errored, or the tool loop hit its cap
  | 'PROVIDER_CONTEXT_EXCEEDED' // multi-provider-openai: the next request would exceed the model's window
  | 'EXT_NOT_ENABLED' // extensions FR-7: the extension is toggled off; nothing was spawned
  | 'EXT_NOT_DETECTED' // extension-install FR-1: the extension's predicate does not hold for that root; when raised because no home directory could be resolved (fleet-scoped panels), detail: { command } per FR-49
  | 'EXT_PANEL_NOT_FOUND' // extension-install FR-12: a panelId that is not in the manifest-derived registry
  | 'EXT_PROVIDER_MISSING' // extensions FR-24: the binary could not be spawned (detail: { argv0, command })
  | 'EXT_PROVIDER_TIMEOUT' // extensions FR-21: killed at 10s (detail: { timeoutMs, command })
  | 'EXT_PROVIDER_EXIT' // extensions FR-24: non-zero exit (detail: { code, stderr, command })
  | 'EXT_SCHEMA_INVALID' // extensions FR-25: stdout did not validate; nothing was rendered
  | 'EXT_OUTPUT_CAPPED' // extensions FR-22: killed past 4 MiB (detail: { capBytes, command })
  | 'EXT_PATH_OUTSIDE_ROOT' // extensions FR-39: a log-tail file source escaped its declared root
  | 'EXT_INVALID_TOKEN' // extensions FR-38: the token slot failed its charset/length rule
  | 'EXT_STREAM_NOT_FOUND' // extensions: closeStream addressed an unknown or already-ended stream
  | 'EXT_MANIFEST_INVALID' // extension-install FR-6: schema failure; detail: { pointer, expected, manifestPath }
  | 'EXT_MANIFEST_UNSUPPORTED' // extension-install FR-5: unknown `manifest` version; detail: { found, supported }
  | 'EXT_NOT_CONSENTED' // extension-install FR-17: enable/spawn refused before consent
  | 'EXT_CONSENT_STALE' // extension-install FR-18: the manifest changed under the dialog
  | 'PROFILE_NOT_FOUND' // session-profiles: a profileId that is not in the registry
  | 'PROFILE_ARG_DENIED' // session-profiles: extraArgs carried a denied flag (detail: { flag, reason })
  | 'RUNTIME_UNAVAILABLE'
  | 'STEP_DETAIL_NOT_FOUND' // command-inspect: no captured detail record for this block
  | 'RUNTIME_INCOMPATIBLE'
  | 'RUNTIME_PROTOCOL_ERROR'
  | 'RUNTIME_TIMEOUT'
  | 'RUNTIME_EXITED'
  | 'RUNTIME_UNSUPPORTED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'TOOL_FAILED'
  | 'SESSION_BUSY' // pi-session-durability: reconnect/newFrom refused while a turn or another recovery is in flight
  | 'RUNTIME_SESSION_MISSING' // pi-session-durability FR-3: the recorded native conversation file is gone
  | 'RUNTIME_SESSION_CORRUPT' // pi-session-durability FR-3: the native file/identity failed validation or its parent chain is broken
  | 'RUNTIME_ACCOUNT_MISSING' // pi-session-durability FR-3: the pinned account was removed; never falls back to a default
  | 'QUEUE_FULL' // pi-turn-controls FR-4: the session already holds 20 pending intents (detail: { cap })
  | 'RUNTIME_POLICY_REQUIRED' // pi-skills-capabilities FR-5: first submit refused until the session's unrestricted-tools acknowledgment is recorded
  | 'PROFILE_RUNTIME_MISMATCH' // pi-migration-rollout: a legacy profile selected for a Pi account, or Pi settings for another runtime
  | 'INTERNAL';

// ---------- sessions ----------

/**
 * A session's lifecycle state. Three of these mean "a turn is in flight" —
 * `starting`, `running`, and the two `awaiting_*` states — so a consumer asking
 * "is this session busy?" must use `isBusyStatus` (contract/fleet-board.ts)
 * rather than comparing against `'running'`.
 *
 *   starting          — the turn's claude process was spawned; no stream line yet.
 *   running           — the stream is live (system/init seen).
 *   awaiting_approval — parked on a gated tool call (permission-guardrails FR-2).
 *   awaiting_input    — parked on an AskUserQuestion (session-questions FR-6).
 *   idle              — no turn in flight; ready for the next message.
 *   done / error      — terminal; the session accepts no further turns.
 *
 * The two `awaiting_*` states are DERIVED, never latched: the core recomputes
 * them from the turn's pending maps, so a cancelled ask cannot strand a session
 * looking blocked. Approval outranks question when both are pending.
 */
export type SessionStatus =
  | 'starting'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_input'
  | 'idle'
  | 'done'
  | 'error';

/**
 * Permission mode a session's claude turns run with (`claude --permission-mode`).
 * 'default' passes NO flag — the turn inherits the user's own ~/.claude settings
 * (permissions.defaultMode / allow rules), which is the pre-feature behavior.
 * The CLI's `auto`/`dontAsk` modes are deliberately not offered: `auto` aborts
 * headless (-p) runs on repeated classifier blocks, `dontAsk` needs a paired
 * allowedTools list.
 */
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';

/**
 * response-mode FR-1: how the model should WRITE, orthogonal to what it may do.
 * Closed set; user-authored modes are a stated non-goal. Every `match` on this in
 * the core is exhaustive with no wildcard arm.
 *
 * 'default' is the absence of an instruction, not an instruction saying "be
 * normal" — see FR-7/FR-8. (The one exception is the codex/grok clearing
 * directive, FR-11, which exists because those threads carry history.)
 */
export type ResponseMode = 'default' | 'concise' | 'explanatory' | 'learning';

/** Where the claude CLI runs for a session: natively, or inside WSL (Windows only). */
export type ClaudeRuntime = 'native' | 'wsl';

/**
 * Who owns the agent loop (multi-provider-seam FR-11a). Renames SessionProvider —
 * honest name: 'claude-code' is the Claude Code CLI harness driving its own loop,
 * 'francois' is our loop in the Rust core, 'codex' is OpenAI's codex CLI driving
 * its own (multi-provider-codex FR-1). It answers "who decides what happens
 * next", NOT "which vendor's API" — that is ProviderProtocol plus the session's
 * account, which together name the wire and the credential.
 *
 * 'codex' is what makes the two axes load-bearing rather than tidy: it pairs with
 * protocol 'openai' exactly as 'francois' does, and the two differ ONLY in who
 * owns the loop. A single collapsed enum could not tell them apart.
 *
 * 'grok' (multi-provider-grok FR-1) is xAI's `grok` CLI driving its own loop over
 * `grok -p --output-format streaming-json`, a third non-interactive transport
 * alongside 'codex'. It also pairs with protocol 'openai' — xAI's API is an
 * OpenAI `/chat/completions` dialect — even though the vendor is neither
 * Anthropic nor OpenAI; ProviderProtocol names the wire, not the vendor.
 *
 * NOT called `runtime`: SessionMeta.runtime is taken by wsl-filesystem and means
 * native-vs-WSL. NOT called 'native' for the second member, for the same reason.
 *
 * Every `match` on this type in the core is exhaustive with NO wildcard arm
 * (multi-provider-grok FR-1) — a fifth member must fail the build, not default.
 */
export type AgentRuntime = 'claude-code' | 'francois' | 'codex' | 'grok' | 'pi';

/**
 * Which wire dialect the session's endpoint speaks (multi-provider-seam FR-11a).
 * Orthogonal to AgentRuntime: the Claude Code CLI honours ANTHROPIC_BASE_URL, so
 * ('claude-code','anthropic') against a third-party endpoint is a real cell — one
 * a single collapsed enum could not name. Vendor IDENTITY is neither of these
 * two; it is the session's account and its endpoint baseUrl.
 */
export type ProviderProtocol = 'anthropic' | 'openai' | null;

/** Opaque provider/model identity. Both identifiers are nonempty UTF-8 strings up to 256 bytes. */
export interface RuntimeModelRef {
  providerId: string;
  modelId: string;
}

/**
 * pi-models-metrics §5: one provider/model row as the runtime reports it. Identity is
 * the `(providerId, modelId)` pair in `ref` — `displayName` is presentation only, and
 * two providers advertising the same `modelId` are two distinct rows (FR-1).
 *
 * `authState` is an observation, never a claim: catalogue presence does not establish
 * that credentials work. `unavailableReason` is present iff `availability` is
 * 'unavailable' — the shape a saved/default/favorite selection keeps after its model
 * disappears, so it renders disabled with its exact identity instead of being silently
 * replaced (FR-3).
 *
 * `contextWindow` / `maxOutputTokens` are positive safe integers, or null when unknown.
 */
export interface RuntimeModelDescriptor {
  ref: RuntimeModelRef;
  displayName: string;
  input: ('text' | 'image')[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  reasoning: boolean;
  authState: 'unknown' | 'configured' | 'verified' | 'failed';
  availability: 'available' | 'unavailable';
  unavailableReason?: string;
}

/**
 * pi-models-metrics §5: usage as the runtime reports it, with explicit unknowns.
 * Every non-null counter is a finite nonnegative number. `null` means UNKNOWN and
 * renders as an em dash — never as zero, and never as an empty or full bar (FR-7).
 *
 * `contextTokens` is CURRENT context occupancy; the four token counters are cumulative
 * totals. They are tracked separately, and the sum of historical input tokens is never
 * presented as occupancy. After compaction `contextTokens` stays null until the runtime
 * reports a trustworthy value, with `contextBasis: 'unknown'`.
 *
 * `costUsd` is an estimate at best: `costBasis` is 'estimated' only when the runtime
 * supplied pricing-derived values. Zero pricing does not establish free execution and
 * missing/untrusted pricing yields null + 'unknown' (FR-8).
 *
 * `stale: true` ⇒ the values predate a restart or a failed refresh (FR-9).
 */
export interface RuntimeMetrics {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  contextBasis: 'reported' | 'estimated' | 'unknown';
  costUsd: number | null;
  costBasis: 'estimated' | 'unknown';
  measuredAt: number; // epoch ms
  stale: boolean;
}

/**
 * pi-turn-controls §5: how a message is delivered to a runtime-owned session.
 * 'normal' is valid only when idle (busy ⇒ SESSION_BUSY); 'steer' only when busy
 * (idle ⇒ INVALID_INPUT); 'followUp' when idle is submitted as a normal prompt while
 * the recorded intent stays 'followUp' (FR-1).
 */
export type DeliveryMode = 'normal' | 'steer' | 'followUp';

/**
 * pi-turn-controls §5: where one client message stands in the core's admissions ledger.
 * `clientMessageId` is the core-owned identity — two messages with identical text are
 * two receipts. 'delivery-unknown' means identity could not be resolved: it is never
 * upgraded to delivered on the strength of matching text (FR-3).
 * `queuePosition` is 1-based and present iff `state` is 'queued'.
 */
export interface RuntimeMessageReceipt {
  clientMessageId: string;
  state: 'admitting' | 'queued' | 'consumed' | 'cancelled' | 'delivery-unknown' | 'rejected';
  delivery: DeliveryMode;
  queuePosition?: number;
}

/** pi-turn-controls §5: a ledger entry as the composer strip renders it. */
export interface RuntimeQueueEntry extends RuntimeMessageReceipt {
  text: string;
  attachmentIds: string[];
  createdAt: number; // epoch ms
}

/**
 * pi-skills-capabilities §5: the launch policy a Pi session is pinned to. Snapshotted
 * at creation and never converted into an allow/deny tool rule. `extensions` has one
 * member on purpose — arbitrary Pi extensions are disabled in this release (FR-6).
 * `acknowledgedUnrestrictedTools` records that the user saw "Pi tools run with your
 * user permissions"; the core refuses the first submit with RUNTIME_POLICY_REQUIRED
 * while it is false (FR-5). It is distinct from account consent.
 */
export interface RuntimeResourcePolicy {
  projectResources: 'ignore' | 'allow';
  extensions: 'disabled';
  acknowledgedUnrestrictedTools: boolean;
}

export type RuntimeCapability =
  | 'mcp'
  | 'subagents'
  | 'skills'
  | 'skillsInstall'
  | 'workflows'
  | 'interactiveCommands'
  | 'permissions'
  | 'remoteControl'
  | 'usageBar'
  | 'compaction'
  | 'steering'
  | 'followUps'
  | 'resumableSessions'
  | 'modelSwitching'
  | 'images'
  | 'contextMetrics'
  | 'costMetrics';

/** `reason` is present iff `available` is false. */
export interface CapabilityState {
  available: boolean;
  reason?: string;
}

export type RuntimeCapabilities = Record<RuntimeCapability, CapabilityState>;

/**
 * pi-session-durability: whether a runtime-owned session can continue its
 * native conversation. Presentation only — the native file path stays
 * core-private and never crosses IPC.
 *
 * - `ready`: connected, or verified resumable on the next send.
 * - `disconnected`: history is readable; the next send (or an explicit
 *   reconnect) re-attaches to the recorded native session.
 * - `missing` / `corrupt` / `incompatible` / `account-missing`: resume is
 *   refused with one cause; the user picks Retry or Create new session. None of
 *   these ever falls back to a fresh thread (FR-3).
 *
 * `message` is user-facing English copy naming the single cause; present for
 * every state except `ready`. `lastVerifiedAt` is epoch ms of the last
 * successful identity/file validation, absent if never verified.
 */
export interface RuntimeRecovery {
  state: 'ready' | 'disconnected' | 'missing' | 'corrupt' | 'incompatible' | 'account-missing';
  lastVerifiedAt?: number;
  message?: string;
}

export interface RuntimeFailure {
  origin: 'application' | 'runtime' | 'provider' | 'tool';
  code: ErrorCode;
  message: string;
  retryable: boolean;
  requestId?: string;
  toolCallId?: string;
}

/**
 * pi-transcript-events: a normalized generic tool-call lifecycle, sanitized in the
 * adapter before it crosses IPC — never the raw Pi RPC input/output object.
 */
export interface RuntimeToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  inputText: string;
  outputText: string;
  /** true ⇒ `inputText` was cut at the 64 KiB preview bound (pi-transcript-events FR-4). */
  inputTruncated: boolean;
  /** true ⇒ `outputText` was cut at the 64 KiB preview bound (pi-transcript-events FR-4). */
  outputTruncated: boolean;
  startedAt?: number;
  completedAt?: number;
}

/** pi-transcript-events FR-7: a user-attached file/image, resolved against the
 *  existing attachment ingest/asset scopes — never a base64 payload over IPC. */
export interface RuntimeAttachmentRef {
  id: string; // existing core attachment ID
  name: string;
  mimeType: string;
  state: 'available' | 'missing';
}

/**
 * pi-transcript-events §5: runtime-sourced transcript normalization events, merged
 * into `RuntimeEventPayload` below. `blockId` ties each event to the conversation
 * block it updates/creates (contract/conversation-view.ts).
 */
export type TranscriptRuntimePayload =
  | { kind: 'message.user'; blockId: BlockId; text: string; attachments: RuntimeAttachmentRef[]; clientMessageId?: string }
  | { kind: 'assistant.delta'; blockId: BlockId; contentIndex: number; text: string; offset: number }
  | { kind: 'assistant.complete'; blockId: BlockId; text: string; outcome: 'complete' | 'interrupted' | 'error' }
  | { kind: 'tool.update'; blockId: BlockId; tool: RuntimeToolCall }
  | { kind: 'notice'; blockId: BlockId; tone: 'info' | 'warning' | 'error'; text: string };

/**
 * pi-models-metrics §5: published only AFTER the core read the accepted value back
 * from the runtime (FR-5/FR-6) — `effort` is the actual read-back level, absent when
 * the model runs at its own default or a model change cleared an incompatible one.
 *
 * Where the AVAILABLE levels travel: a descriptor only says `reasoning: boolean`. The
 * list the runtime reports for the CURRENT model rides on `SessionMeta.model.efforts`
 * (the existing ModelInfo field — runtime-reported strings in reported order, empty when
 * the model reports none; never Claude's subset). Ordering is pinned so the list is never
 * clobbered: the core emits `model.changed` FIRST, then the authoritative `session.meta`
 * snapshot carrying `model.efforts` and `effort`. A consumer handling `model.changed`
 * must therefore not treat its own efforts-less projection as final.
 */
export type ModelRuntimePayload =
  | { kind: 'model.changed'; model: RuntimeModelDescriptor; effort?: string }
  | { kind: 'metrics'; metrics: RuntimeMetrics };

/**
 * pi-turn-controls §5. `queue.changed` always carries the session's FULL unresolved
 * ledger (an empty array clears the strip) — raw runtime queue texts are normalized to
 * ledger ids in the core before emission. "Unresolved" means: 'admitting' and 'queued'
 * entries, PLUS the recoverable terminal ones — 'cancelled', 'delivery-unknown' and
 * 'rejected' — which stay listed (text intact, FR-6/FR-9) until the user removes them
 * with session_unqueue. A 'consumed' entry drops out: its transcript block replaces it.
 * Entries keep admission order. `compaction` with `automatic: true` and
 * `retry` are progress inside the current run: neither is a turn completion (FR-8).
 */
export type ControlRuntimePayload =
  | { kind: 'queue.changed'; entries: RuntimeQueueEntry[] }
  | { kind: 'compaction'; state: 'started' | 'completed' | 'failed'; automatic: boolean; message?: string }
  | { kind: 'retry'; state: 'waiting' | 'running' | 'finished'; attempt: number; delayMs?: number };

export type RuntimeEventPayload =
  | { kind: 'run.state'; state: 'starting' | 'running' | 'idle' | 'stopping' | 'failed' }
  | { kind: 'capabilities'; capabilities: RuntimeCapabilities }
  | { kind: 'failure'; failure: RuntimeFailure }
  | TranscriptRuntimePayload
  | ModelRuntimePayload
  | ControlRuntimePayload;

export interface RuntimeEventEnvelope {
  type: 'runtime.event';
  sessionId: SessionId;
  generation: string;
  sequence: number;
  runId?: string;
  requestId?: string;
  at: number;
  event: RuntimeEventPayload;
}

export interface ModelInfo {
  id: string; // e.g. 'claude-sonnet-5'
  label: string; // display label, e.g. 'Sonnet 5'
  /** short factual summary derived from /v1/models (context/output/capabilities). */
  brief?: string;
  /** max input tokens (real context window) from /v1/models. */
  contextTokens?: number;
  /** Runtime/model-advertised effort strings, in advertised order (empty = none). */
  efforts?: string[];
  /** Advertised default, present only when included in efforts. */
  defaultEffort?: string;
  /** pi-models-metrics: the exact provider/model pair this row stands for. Present on
   *  every Pi row, where `id` alone is NOT an identity (FR-1/FR-4).
   *  WEBVIEW-SIDE ONLY, like `descriptor` below: the core never serializes either on a
   *  `ModelInfo` (its serde mirror has no such fields). A Pi picker row is built in the
   *  webview from a `runtime_models` descriptor; the core's own identity for a session's
   *  Pi model is `SessionMeta.runtimeModel`. */
  runtimeModel?: RuntimeModelRef;
  /** pi-models-metrics: required on Pi catalogue rows; absent for every other runtime. */
  descriptor?: RuntimeModelDescriptor;
}

export interface SessionMeta {
  id: SessionId;
  name: string; // defaults to basename(cwd)
  cwd: string; // absolute path
  model: ModelInfo;
  status: SessionStatus;
  contextUsedTokens: number;
  contextLimitTokens: number;
  startedAt: number; // epoch ms
  lastActivityAt: number; // epoch ms
  errorMessage?: string; // set when status === 'error'
  /** Permission mode for this session's turns; 'default' = inherit ~/.claude settings. */
  permissionMode: PermissionMode;
  /**
   * rework-top-bar (design 11c): epoch ms of the last permissionMode write —
   * creation counts as the first one, so this is never absent and never 0. The run
   * chip renders it as the `on since HH:MM` line under `bypass`, the one mode whose
   * age you want before walking away from it. Stamped on EVERY write, including a
   * no-op re-pick: "on since" means since you last said so.
   */
  permissionModeSince: number;
  /**
   * rework-top-bar (design 11c): the reasoning-effort level this session's NEXT turn
   * spawns with. Absent (never null) when the model runs at its own default — which
   * is also the only state for a model whose ModelInfo advertises no `efforts`.
   */
  effort?: string;
  /** CLI runtime for this session; 'wsl' spawns `wsl.exe -- claude …` (Windows only). */
  runtime: ClaudeRuntime;
  /**
   * The project this session was created under; absent when unlinked (projects FR-18).
   * Set at creation ONLY — editing a project's defaults never changes a session
   * (projects FR-24). Cleared, with a session.meta emission, when that project is
   * removed (projects FR-9). A persisted value that no longer resolves to a registry
   * entry is dropped on load.
   */
  projectId?: ProjectId;
  /** Present ⇔ this session runs in a Francois-created or Francois-adopted git worktree. */
  worktree?: SessionWorktree;
  /**
   * The account this session's every claude spawn runs under (multi-account FR-19/FR-21).
   * Set at creation ONLY — never re-derived or changed afterwards, except when the account
   * is removed (FR-9) or a persisted value no longer resolves (FR-10), both of which fall
   * back to 'default'. Required: persisted sessions without it load as 'default'.
   */
  accountId: AccountId;
  /**
   * Present ⇔ this session was ADOPTED from a Claude Code on the web session
   * (cloud-sessions FR-10). Presence is the whole signal — it drives the `cloud`
   * provenance chip (FR-16). Set at adoption ONLY, never re-derived, and persisted
   * with the rest of the durable-sessions state.
   *
   * Adoption is a ONE-WAY pull: after it, the cloud copy no longer receives the
   * user's work. Nothing here implies a live link back to claude.ai.
   */
  cloud?: CloudProvenance;
  /**
   * Who owns this session's agent loop (multi-provider-seam FR-11a). DERIVED
   * from the account's kind at creation and never re-derived. Absent ⇒
   * 'claude-code'; a record carrying the superseded `provider` key maps
   * 'claude-code' → 'claude-code', 'openai-compatible' → 'francois'.
   */
  agentRuntime: AgentRuntime;
  /**
   * The wire dialect this session's endpoint speaks (multi-provider-seam FR-11a).
   * Absent ⇒ 'anthropic'; superseded `provider: 'openai-compatible'` ⇒ 'openai'.
   */
  protocol: ProviderProtocol;
  /** Explicit provider/model pair for runtime-owned connections; Pi supplies it after initialization. */
  runtimeModel?: RuntimeModelRef;
  /** Live core snapshot may narrow static defaults; a missing Pi snapshot enables no action. */
  effectiveCapabilities?: RuntimeCapabilities;
  /** Core-minted UUID for the currently connected runtime child; never persisted as a live handle. */
  runtimeGeneration?: string;
  /** Present for Pi sessions only (pi-session-durability); absent for every other runtime.
   *  Republished on the existing `session.meta` event whenever it changes. */
  recovery?: RuntimeRecovery;
  /** pi-models-metrics: the most recent runtime-reported usage. Persisted with the
   *  session and loaded `stale: true` after a restart until refreshed. Absent for a
   *  runtime that reports none — never synthesized from `contextUsedTokens`. */
  metrics?: RuntimeMetrics;
  /** pi-skills-capabilities: present for Pi sessions only; the pinned launch policy. */
  resourcePolicy?: RuntimeResourcePolicy;
  /** Present ⇔ created from a profile; snapshot-only (session-profiles FR-16). */
  profile?: SessionProfileRef;
  /** How this session's NEXT turn is told to write. A persisted record without
   *  the key loads as 'default' (response-mode FR-1). */
  responseMode: ResponseMode;
  /** Francois auto-approves direct `git`/`gh` Bash calls for this session
   *  (session-settings-sheet FR-1). Read LIVE by the control channel, so a change
   *  applies to the very next permission request. Pre-feature records load `false`. */
  allowGit: boolean;
}

/** The id of a Claude Code on the web session — `'session_…'` or `'cse_…'`. */
export type CloudSessionId = string;

/**
 * Cloud provenance for an adopted session (cloud-sessions FR-10).
 * Deliberately minimal: nothing about the cloud session itself is cached, because
 * after adoption the local session is the only live copy of the thread.
 */
export interface CloudProvenance {
  cloudSessionId: CloudSessionId;
  adoptedAt: number; // epoch ms
}

/** Worktree provenance for a session created with isolation (session-worktree FR-12). */
export interface SessionWorktree {
  branch: string; // the checked-out branch, verbatim
  baseRef: string; // the ref it was forked from; echoed verbatim, ignored when createdBranch is false
  /**
   * FR-7b: the ref `git worktree add -b` was ACTUALLY given, when the fetch found a newer
   * `<remote>/<baseRef>` than the local `baseRef` — always a full `refs/remotes/<remote>/<baseRef>`.
   * Absent when the local base was already current, had diverged, the fetch failed / was skipped,
   * or `createdBranch` is false (an existing branch ignores the base entirely).
   * It — not `baseRef` — is the reliable fork point for WorktreeStatusData's unpushed count.
   */
  baseResolved?: string;
  path: string; // absolute worktree path, in the HOST's dialect (FR-10)
  sourceRepoRoot: string; // absolute root of the repo this tree belongs to, host dialect
  createdBranch: boolean; // false ⇒ the branch already existed, or the tree was adopted (FR-5)
  fetched: boolean; // a fetch ran and succeeded (FR-7)
  fetchError?: string; // one-line reason; absent when fetched, or when there is no remote
  /** attach-to-worktree FR-15: the tree has a detached HEAD; `branch` carries the 7-char short
   *  sha, not a ref. Absent on a session persisted before this feature ⇒ falsy. */
  detached?: boolean;
  /** attach-to-worktree FR-16: the tree was adopted, not created by Francois (suppresses the
   *  session-worktree FR-14 "nothing came along" banner). Absent ⇒ falsy. */
  adopted?: boolean;
}

// ---------- projects ----------

export type ProjectId = string; // uuid v4

/**
 * Session settings a project pre-fills into the new-session modal (projects §5.1).
 * Every field is optional: an absent field means "inherit" — the modal keeps its
 * pre-feature default for that control. Defaults are a SNAPSHOT — they are copied onto
 * the session at creation and never re-applied afterwards (projects FR-24).
 */
export interface ProjectDefaults {
  modelId?: string;
  /** pi-models-metrics FR-4: the default for a Pi account — an exact pair, mutually
   *  exclusive with `modelId`. A pair that is no longer available stays saved and renders
   *  disabled (FR-3); it is never swapped for a similarly named model. */
  runtimeModel?: RuntimeModelRef;
  /** Runtime/model-advertised value. Codex membership is checked on relevant edits,
   * while syntactically valid saved values survive catalogue changes. */
  effort?: string;
  permissionMode?: PermissionMode;
  runtime?: ClaudeRuntime;
  allowGit?: boolean;
  /** A removed account falls back to the isDefault account in the modal (multi-account FR-20). */
  accountId?: AccountId;
  /** A profile that no longer resolves is dropped in the modal (session-profiles FR-21). */
  profileId?: ProfileId;
  /** Pre-fills the New Session modal; a SNAPSHOT, like every other default. */
  responseMode?: ResponseMode;
}

// ---------- session profiles ----------

export type ProfileId = string; // uuid v4

/**
 * The profile identity a session snapshots at creation (session-profiles FR-16). Absent ⇒
 * no profile. Never re-resolved against the registry: a deleted profile's name still
 * renders (FR-22).
 */
export interface SessionProfileRef {
  id: ProfileId;
  name: string; // snapshotted at creation
  /** true iff the session was created with a non-empty systemPrompt (FR-17). */
  replacesSystemPrompt: boolean;
}

// ---------- subagents ----------

export type AgentStatus = 'running' | 'idle' | 'done' | 'error';

export interface AgentInfo {
  id: AgentId;
  sessionId: SessionId;
  name: string; // e.g. 'test-writer'
  task: string; // one-line task description
  status: AgentStatus;
  /** epoch ms when the agent was first minted (real anchor for the elapsed timer). */
  startedAt: number;
  /** epoch ms when it reached done/error; absent while running (freezes the timer). */
  endedAt?: number;
  /**
   * true when the dispatch was asynchronous (async-agents FR-2). For these, the dispatch's
   * tool_result is a spawn ack and never sets `endedAt` (FR-5) — the elapsed clock keeps running.
   */
  background: boolean;
  /** Label of the newest AgentStep (async-agents FR-10); absent until the first step. */
  lastActivity?: string;
  /** Total steps ever observed for this agent — may exceed the 200-step trail window (FR-12). */
  stepCount: number;
}

// ---------- agent activity trail ----------
// async-agents §5: AgentStep rides on SessionEvent (agent.step), so it is shared
// vocabulary and lives here. contract/async-agents.ts re-exports it.

export type AgentStepKind =
  | 'text' // the subagent said something
  | 'tool' // the subagent called a tool
  | 'notice'; // lifecycle marker minted by the engine (dispatch / completion / kill / turn end)

export interface AgentStep {
  /** Strictly increasing per agent, starting at 1 — stable sort key and React key (FR-12). */
  seq: number;
  kind: AgentStepKind;
  /** epoch ms the step was observed. */
  at: number;
  /** Tool name for kind 'tool' (e.g. 'Read'); absent for the other kinds. */
  tool?: string;
  /** One line: tool summary, text excerpt, or notice text. Never empty. */
  label: string;
  /** kind 'tool' only: the derived meta once the step's tool_result arrived; absent while open. */
  meta?: string;
}

// ---------- workflows ----------
// workflow-panel §5: a run of the harness's `Workflow` tool — the multi-agent
// orchestration script the assistant dispatches during a turn. WorkflowRun rides
// on SessionEvent (workflow.update), so it is shared vocabulary and lives here.

export type WorkflowRunId = string; // uuid v4 — minted by the core, not the harness

export type WorkflowStatus = 'running' | 'done' | 'error';

/** One phase declared in the script's `meta.phases` block. */
export interface WorkflowPhaseInfo {
  title: string;
  /** The phase's one-line `detail`, when the script declared one. */
  detail?: string;
}

export interface WorkflowRun {
  id: WorkflowRunId;
  sessionId: SessionId;
  /** `meta.name` from the script — else the saved-workflow name, else the script file's stem. */
  name: string;
  /** `meta.description`; empty when the dispatch carried no script to read it from. */
  description: string;
  status: WorkflowStatus;
  /** epoch ms the dispatch was first seen (anchor for the elapsed timer). */
  startedAt: number;
  /** epoch ms it reached done/error; absent while running (freezes the timer). */
  endedAt?: number;
  /**
   * The phases the script declared, in order. Empty when the dispatch named a
   * saved workflow (no script text to parse) — the panel then shows none rather
   * than inventing progress the stream never reported.
   */
  phases: WorkflowPhaseInfo[];
  /** The harness run id (`wf_…`) parsed out of the dispatch ack; absent until it lands. */
  runId?: string;
  /** One line of the newest thing observed for this run (the ack, or the completion notice). */
  lastActivity?: string;
  /** workflow-details FR-1: the ack's `Transcript dir:`, if it resolved to an existing directory. */
  transcriptDir?: string;
  /** workflow-details FR-24: count of asks currently attributed to this run; absent/0 when none. */
  pendingAsks?: number;
}

// ---------- MCP ----------

/**
 * `pending` / `rejected` are APPROVAL states, not connection states: Claude Code
 * gates project-scope `.mcp.json` servers behind a first-run consent dialog, and a
 * server on either side of that decision never starts, so it would otherwise sit
 * at `connecting` forever. Only ever reported for a server the session's stream
 * has said nothing about — a live status always wins.
 */
export type McpStatus =
  | 'connected'
  | 'connecting'
  | 'error'
  | 'pending' //  project-scope, no decision on record — Claude Code would ask
  | 'rejected' // project-scope, explicitly refused
  | 'approved'; // project-scope, decided yes but not started yet (next turn spawns it)

/** Which Claude Code config declares an MCP server (mirrors `claude mcp list` scopes). */
export type McpScope =
  | 'project' // <cwd>/.mcp.json (checked into the repo)
  | 'local' //  ~/.claude.json → projects[cwd].mcpServers (private to this machine)
  | 'user'; //  ~/.claude.json → top-level mcpServers (global)

export interface McpServerInfo {
  name: string;
  status: McpStatus;
  toolCount?: number; // present when connected
  errorMessage?: string; // present when status === 'error', e.g. 'timeout'
  scope?: McpScope; // config scope this server is declared in (absent for runtime-only updates)
}

// ---------- skills ----------

/** Where an invocable comes from. */
export type SkillScope =
  | 'project' // <cwd>/.claude/{skills,commands}
  | 'user' //   ~/.claude/{skills,commands}
  | 'plugin' // an enabled (installed) or marketplace (available) plugin
  | 'path'; // pi-skills-capabilities: loaded from an explicit path (a Pi profile's skillPaths)

/** SKILL.md skill vs. a slash-command markdown file — both invoked as /<name>. */
export type SkillKind = 'skill' | 'command';

export interface SkillInfo {
  name: string;
  description: string; // one-line purpose, e.g. 'read & parse PDFs'
  installed: boolean; // installed/active (✦) vs available-to-enable (◇)
  scope?: SkillScope; // where it was discovered
  kind?: SkillKind; // skill (SKILL.md) or command (*.md)
  pluginId?: string; // for plugin entries: '<plugin>@<marketplace>' (enabling target)
  // ---- pi-skills-capabilities §5 (RuntimeSkillFields). Optional on the type, REQUIRED
  // on every entry a Pi session lists; absent for every other runtime. ----
  /** The exact command text the runtime resolves, spelling preserved — e.g.
   *  '/skill:review' or '/summarize'. Never rebuilt from `name` (FR-1). */
  invocation?: string;
  /** A Pi skill vs. a Pi prompt template. */
  source?: 'skill' | 'prompt';
  sourcePath?: string;
  /** false ⇒ listed but not runnable under the session's policy; see `unavailableReason`. */
  loaded?: boolean;
  unavailableReason?: string;
}

// ---------- interactive commands ----------
// Card payloads for slash-command responses rendered in the SESSION transcript.
// Emitted by the engine via the command.started / command.output events below;
// rendered by conversation-view as CommandConversationBlock
// (contract/interactive-commands.ts). Spec: specs/interactive-commands.md §5.

/** One plan-limit meter parsed from the CLI's /usage output. */
export interface UsageMeter {
  label: string; // e.g. 'Current session', 'Current week (all models)'
  percentUsed: number; // 0–100 integer
  resetsAt: string; // verbatim reset text, e.g. 'Jul 22, 5:29pm (Europe/Paris)'
}

export interface HelpEntry {
  command: string; // without the leading '/', e.g. 'usage'
  description: string;
}

export type CommandCard =
  /** /usage & /cost, parsed. meters non-empty; tail = remaining lines, preformatted. */
  | { kind: 'usage'; command: 'usage' | 'cost'; meters: UsageMeter[]; tail: string }
  /** /context. percentUsed/usedLabel/limitLabel null when the tokens line didn't parse. */
  | {
      kind: 'context';
      percentUsed: number | null;
      usedLabel: string | null; // e.g. '26.4k'
      limitLabel: string | null; // e.g. '200k'
      body: string; // normalized markdown, preformatted
    }
  /** /model bare. currentId is a snapshot; the live marker derives from SessionMeta. */
  | { kind: 'model'; models: ModelInfo[]; currentId: string }
  /** /status. */
  | { kind: 'status'; meta: SessionMeta }
  /** /help. */
  | { kind: 'help'; entries: HelpEntry[] }
  /** Dim one-liner: unknown command, unavailable command, probe failure, model switch ack. */
  | { kind: 'notice'; text: string }
  /** Generic CLI-local output that fits no richer card. */
  | { kind: 'text'; command: string; text: string };

// ---------- session questions ----------
// Shared vocabulary for session-questions (the SessionEvent union below needs
// these, and this file never imports from feature files — spec §5.3 placement
// rule). contract/session-questions.ts re-exports them. Shapes mirror the CLI's
// AskUserQuestion tool input verbatim.

export interface QuestionOption {
  label: string; // display text, also the canonical answer value
  description: string; // what choosing it means
  preview?: string; // optional monospace preview content
  /**
   * design 13c: true when the CLI marked this the recommended pick. The tool's
   * own convention carries it as a `(Recommended)` suffix ON the label, which
   * the core lifts into this flag (control.rs). The label itself stays
   * verbatim — it is the canonical answer value (FR-12) — so rendering, and
   * only rendering, drops the marker. Absent ⇔ not recommended.
   */
  recommended?: boolean;
}

export interface SessionQuestion {
  /** Opaque answer key; absent preserves legacy question-text keys. */
  id?: string;
  /** With offered options, false suppresses Other; absent preserves legacy behavior. */
  isOther?: boolean;
  /** Secret answers travel transiently to the native runtime; history uses [redacted]. */
  isSecret?: boolean;
  question: string; // full question text — also the key in the answers map
  header: string; // short chip label (nominally ≤ 12 chars; render verbatim)
  options: QuestionOption[]; // 2–4 in practice; render whatever arrives
  multiSelect: boolean; // true → answers joined with ', '
}

// ---------- permission guardrails ----------
// Shared vocabulary for permission-guardrails (the SessionEvent union below
// needs both types — same placement rule as SessionQuestion).
// contract/permission-guardrails.ts re-exports them. Spec §5.2.

/** Where a permission rule is written. 'local' = <cwd>/.claude/settings.local.json. */
export type PermissionTier = 'local' | 'global';

/** The three effect buckets of Claude Code's `permissions` settings object. */
export type PermissionEffect = 'allow' | 'deny' | 'ask';

/** Native cancel may interrupt the turn; only offer it explicitly, never as Deny once. */
export type PermissionDecision = 'allowOnce' | 'denyOnce' | 'allowAlways' | 'denyAlways' | 'cancel';

/** A gated tool call parked on the stdio control channel (FR-2..FR-5). */
export interface PermissionAsk {
  /** Exact offered subset. Absent retains the four legacy choices (never cancel). */
  allowedDecisions?: PermissionDecision[];
  toolName: string; // verbatim from the control request, e.g. 'Bash'
  summary: string; // one-line human rendering (command / path / url); '' when none
  inputJson: string; // whole tool input, pretty JSON, truncated to 4000 chars
  cwd: string; // the session's working directory
  pattern: string; // the Claude rule an "always" decision would write, e.g. 'Bash(npm test:*)'
  patternLabel: string; // human reading of that pattern, e.g. 'npm test (any arguments)'
}

/** One permission rule as it exists on disk (FR-16/FR-17). */
export interface PermissionRule {
  id: string; // `${tier}|${effect}|${pattern}` — derived, never stored, stable across reads
  pattern: string; // raw Claude pattern
  effect: PermissionEffect;
  tier: PermissionTier;
  /** false ⇔ parked in the Francois-owned francois-permissions.json sidecar (FR-15). */
  enabled: boolean;
  label: string; // human reading of the pattern
}

// ---------- slash menu ----------
// Shared vocabulary for slash-menu (the SessionEvent union below needs it —
// same placement rule as SessionQuestion). contract/slash-menu.ts re-exports.

export type SlashCommandSource = 'builtin' | 'skill' | 'cli';

export interface SlashCommandInfo {
  name: string; // without the leading '/'; rendering adds it
  description: string; // '' when the source provides none (cli)
  source: SlashCommandSource;
  /** skill entries only: the SkillInfo scope, shown as the source tag. */
  scope?: SkillScope;
  /** pi-skills-capabilities: the exact text to submit for a runtime-listed command
   *  (e.g. '/skill:review'). Absent ⇒ the legacy '/' + name. A Pi session's menu holds
   *  only runtime-listed commands plus François-owned actions — never a TUI-only
   *  command such as '/login'. */
  invocation?: string;
}

// ---------- session event stream ----------
// Emitted by session-engine on channel 'francois:session:event'.
// The session-engine spec is the authority on emission semantics; consumers
// (conversation-view, agents-panel, mcp-panel, sessions-sidebar, app-shell)
// must use these member names.

export type SessionEvent =
  | { type: 'session.meta'; meta: SessionMeta } // full snapshot (created/updated)
  | RuntimeEventEnvelope
  | { type: 'session.status'; sessionId: SessionId; status: SessionStatus }
  | { type: 'session.removed'; sessionId: SessionId }
  | { type: 'message.user'; sessionId: SessionId; blockId: BlockId; text: string }
  // Streamed partial. `offset` is how many UTF-16 code units of this block were
  // already streamed BEFORE this chunk, so an append is idempotent and a
  // listener that joined mid-block (hydration seeds the prefix, then drains its
  // buffered deltas) can tell an overlap from a genuine append.
  | { type: 'assistant.delta'; sessionId: SessionId; blockId: BlockId; text: string; offset: number }
  // `text` is the block's COMPLETE text — authoritative, so a block that lost a
  // chunk in transit is repaired the moment it closes rather than staying truncated.
  | { type: 'assistant.done'; sessionId: SessionId; blockId: BlockId; text: string }
  // e.g. tool 'Read', summary 'src/auth/middleware.ts'. `model` is set only on a
  // subagent dispatch that named one — see SubagentConversationBlock.agentModel.
  | { type: 'tool.start'; sessionId: SessionId; blockId: BlockId; tool: string; summary: string; model?: string }
  | { type: 'tool.done'; sessionId: SessionId; blockId: BlockId; meta: string; hasDetail?: boolean } // e.g. '128 lines', '+34 −19'; hasDetail: command-inspect FR-10
  | { type: 'command.started'; sessionId: SessionId; blockId: BlockId; command: string } // interactive-commands: side-spawn began (loading card)
  | { type: 'command.output'; sessionId: SessionId; blockId: BlockId; card: CommandCard } // interactive-commands: card ready (creates or finalizes the block)
  | { type: 'question.asked'; sessionId: SessionId; blockId: BlockId; questions: SessionQuestion[]; blocking?: boolean } // absent blocking preserves legacy parked-turn semantics
  | { type: 'question.resolved'; sessionId: SessionId; blockId: BlockId; state: 'answered' | 'cancelled'; answers?: Record<string, string> } // session-questions FR-11/13: exactly one per asked
  | { type: 'permission.asked'; sessionId: SessionId; blockId: BlockId; ask: PermissionAsk } // permission-guardrails FR-2: a gated tool call parked the turn
  | { type: 'permission.resolved'; sessionId: SessionId; blockId: BlockId; state: 'allowed' | 'denied' | 'cancelled'; rule?: PermissionRule } // permission-guardrails FR-8/10: exactly one per asked
  | { type: 'session.commands'; sessionId: SessionId; commands: SlashCommandInfo[] } // slash-menu FR-2: merged registry after an init changed the cli set
  | { type: 'agent.update'; agent: AgentInfo }
  | { type: 'agent.step'; sessionId: SessionId; agentId: AgentId; step: AgentStep } // async-agents FR-10: a trail step was appended, or an existing seq re-emitted with meta filled
  | { type: 'workflow.update'; run: WorkflowRun } // workflow-panel FR-3: a run was minted, acked, or reached a terminal state
  | { type: 'mcp.update'; sessionId: SessionId; server: McpServerInfo }
  | { type: 'context.usage'; sessionId: SessionId; usedTokens: number; limitTokens: number }
  | { type: 'session.resumeFailed'; sessionId: SessionId } // a --resume turn was rejected; the turn fails and the anchor is kept, never replayed on a fresh thread (process-session-continuity FR-5)
  | { type: 'session.cleared'; sessionId: SessionId } // /clear: transcript wiped + context reset (full reset)
  | { type: 'session.error'; sessionId: SessionId; error: AppError };
