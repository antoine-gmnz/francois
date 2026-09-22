// contract/cohorte-integration.ts — cohorte-integration (Cohorte v3 runs inside
// Francois: detection, the per-project watcher, gates, the run view, Settings ·
// Cohorte). Authored from specs/cohorte-integration.md and the Figma frames
// 25 `154:14871`, 26 `156:15293`, 27 `158:15589`, 28 `159:15655`.
// Imports shared vocabulary from common.ts; never redefines it.
//
// Physical Tauri binding: `francois:cohorte:<verb>` → command `cohorte_<snake_verb>`,
// every command resolves to `Result<T>` (never rejects). One event stream:
// `francois:cohorte:event` → Tauri event `francois://cohorte/event`, payload
// `CohorteEvent` (tagged by `type`).
//
// Source of truth for the wire shapes mirrored below: D:\cohorte @ 3.0.0-dev.8 —
// packages/protocol/src/{envelope,catalogue,refs,agent-output,documents,commands,vocabulary}.ts
// and packages/protocol/src/events/*.ts. Francois NEVER forwards a raw Cohorte
// envelope: the core normalises every event (ISO → epoch ms, agent-controlled
// text sanitised, sealed/large blobs dropped) into the members below.
//
// Error codes this feature adds live in common.ts's `ErrorCode` union
// (COHORTE_*); `CohorteErrorCode` below names the subset for documentation.

import type { ErrorCode, Result, SessionId } from './common';

// =====================================================================
// 0. Vocabulary (mirrors packages/protocol/src/vocabulary.ts)
// =====================================================================

/** Open on the wire (AC-07 reader contract): known values listed, any other string kept as-is. */
export type Open<T extends string> = T | (string & Record<never, never>);

export type CohorteActiveState = 'BRAINSTORM' | 'SPEC' | 'PREFLIGHT' | 'BUILD' | 'TEST' | 'REVIEW' | 'FIX' | 'SHIP';
export type CohorteSuspendedState = 'PAUSED' | 'WAITING_APPROVAL' | 'AUTH_REQUIRED' | 'QUOTA_EXCEEDED';
export type CohorteHaltedState = 'FAILED' | 'BLOCKED';
export type CohorteTerminalState = 'COMPLETED' | 'CANCELLED';
export type CohortePipelineState =
  | 'IDLE'
  | CohorteActiveState
  | CohorteSuspendedState
  | CohorteHaltedState
  | CohorteTerminalState;

/** R2 NodeStatus — phases, phase runs and agents. */
export type CohorteNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'waiting-approval'
  | 'cancelled'
  | 'skipped'
  | 'blocked';

export type CohorteAgentState =
  | 'declared'
  | 'planned'
  | 'spawning'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'escalated'
  | 'cancelled';

export type CohorteProfile = Open<'feature' | 'bugfix' | 'review'>;
export type CohorteSeverity = 'critical' | 'major' | 'minor' | 'info';
export type CohorteFindingKind = 'spec-violation' | 'security' | 'quality' | 'complexity' | 'check-failure';
export type CohorteFindingDisposition = 'kept' | 'refuted' | 'deferred' | 'needs-investigation' | 'duplicate';

/** ApprovalRequest.kind — OPEN on the wire (refs.ts). */
export type CohorteApprovalKind = Open<
  | 'tool'
  | 'shared-path'
  | 'ship'
  | 'budget'
  | 'loop-stalled'
  | 'contract-change'
  | 'spec-not-ready'
  | 'review-leftovers'
  | 'unowned-path'
  | 'api-billing'
  | 'blocked-ack'
  | 'provision-network'
>;
export type CohorteApprovalDecision = 'allow-once' | 'allow-for-run' | 'deny' | 'expired' | 'superseded';

export type CohorteStopReason = Open<
  | 'review-clean'
  | 'iteration-limit'
  | 'budget-exhausted'
  | 'timeout'
  | 'identical-failure'
  | 'no-progress'
  | 'policy-violation'
  | 'approval-required'
  | 'unexpected-repo-change'
  | 'runtime-incompatible'
  | 'auth-required'
  | 'quota-exceeded'
  | 'paused'
  | 'cancelled'
  | 'agent-dead'
  | 'unreviewed'
  | 'internal-error'
  | 'check-environment'
>;

/** Francois' UI mapping of a finding (spec FR-40): blocking | minor | nit. */
export type CohorteFindingLabel = 'blocking' | 'minor' | 'nit';

// =====================================================================
// 1. Shared records (normalised)
// =====================================================================

export interface CohortePhaseRef {
  phaseRunId: string;
  state: Open<CohorteActiveState>;
  iteration: number;
}

export interface CohorteAgentRef {
  agentId: string;
  /** plain string on the wire: unknown roles must still render. */
  role: string;
  surface?: string;
  incarnation: number;
  attempt: number;
}

/** base ErrorInfo, flattened: `cause`/`details` dropped, text sanitised. */
export interface CohorteErrorInfo {
  code: string; // e.g. 'conflict/run-active'
  class?: string;
  message: string;
  remediation?: string;
  retryable?: boolean;
}

export interface CohorteStop {
  reason: CohorteStopReason;
  detail: string;
  resumable: boolean;
  resumeRequires?: string;
}

export interface CohorteTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** base BudgetCounters (all optional). */
export interface CohorteBudgetCounters {
  tokens?: number;
  modelRequests?: number;
  toolCalls?: number;
  wallClockMs?: number;
  retries?: number;
  fixRounds?: number;
  contextTokens?: number;
  concurrentAgents?: number;
  estimatedQuotaPercent?: number;
}

/** MonetaryCost: `null` for 'not_applicable' (plan-limit legs). */
export type CohorteCost = { currency: 'USD'; amount: number; basis: 'catalogue' | 'estimate' } | null;

export interface CohorteQuotaWindow {
  name: string;
  usedPercent?: number;
  resetsAt?: number; // epoch ms
  limitLabel?: string;
}
export type CohorteQuota = { known: false } | { known: true; provider: string; windows: CohorteQuotaWindow[]; observedAt: number };

export interface CohorteModelRef {
  provider: string;
  model: string;
}

export interface CohorteArtifactRef {
  artifactId: string;
  kind: Open<'diff' | 'file' | 'log' | 'report' | 'agent-output' | 'transcript' | 'context' | 'prompt' | 'patch'>;
  path: string; // as Cohorte reports it (store-relative or worktree-relative)
  bytes: number;
}

export interface CohorteFileTouch {
  path: string; // worktree-relative, POSIX
  op: 'read' | 'create' | 'modify' | 'delete';
  bytes?: number;
}

export interface CohorteCheckResult {
  name: string;
  status: 'passed' | 'failed' | 'errored' | 'skipped';
  argv: string[];
  exitCode?: number;
  durationMs: number;
}

export interface CohorteLock {
  scope: Open<'project' | 'zone' | 'run' | 'integration' | 'slot'>;
  key: string;
  mode: 'shared' | 'exclusive';
  owner: string;
}

/** agent-output.ts Finding, normalised. `label` is Francois' mapping (FR-40). */
export interface CohorteFinding {
  /** Cohorte's `fnd_…`; when absent Francois synthesises `evt:<eventId>` so rows stay keyed. */
  id: string;
  severity: CohorteSeverity;
  kind: CohorteFindingKind;
  rule: string;
  /** the row title: sanitised `actual` (≤160 chars), falling back to `rule` (FR-40). */
  title: string;
  expected: string;
  actual: string;
  file?: string;
  line?: number;
  endLine?: number;
  symbol?: string;
  confidence: number;
  suggestedFix?: string;
  scope: 'in-scope' | 'deferred';
  disposition: CohorteFindingDisposition;
  reviewerAgentId?: string;
  /** true ⇔ Cohorte counted it blocking (review.completed.blockingItems), else severity fallback (FR-40). */
  blocking: boolean;
  label: CohorteFindingLabel;
}

/** The full ApprovalRequest (refs.ts R6), normalised. */
export interface CohorteApprovalRequest {
  approvalId: string;
  kind: CohorteApprovalKind;
  agent?: CohorteAgentRef;
  phase?: CohortePhaseRef;
  tool?: string;
  affectedPaths: string[];
  /** agent-controlled: sanitised (C0/C1 stripped), capped at 4 KiB, `truncated` set when cut. */
  preview: { kind: 'diff' | 'command' | 'text'; text: string; truncated: boolean };
  options?: string[];
  ruleId: string;
  reason: string;
  asks: { stage: string; ruleId: string; reason: string }[];
  allowedDecisions: ('allow-once' | 'allow-for-run' | 'deny')[];
  expiresAt?: number;
  unattended: 'deny' | 'wait';
  /** Cohorte's own literal hint (`cohorte approve <id>`) — shown only as a fallback. */
  cli: string;
}

// =====================================================================
// 2. The event catalogue — EVERY Cohorte type, one typed member each
//    (catalogue.ts EVENTS = RUN + AGENT + TOOL + GOVERNANCE + GIT + STREAM)
// =====================================================================

export interface CohorteEventHeader {
  /** The Cohorte root: the directory that holds `.cohorte/` (spec §6). */
  projectRoot: string;
  runId: string;
  eventId: string;
  /** durable: gapless per run (1..n). ephemeral: last committed durable sequence. */
  sequence: number;
  /** durable: 0. ephemeral: 1.. — total order is (sequence, sub), NEVER `at`. */
  sub: number;
  durability: 'durable' | 'ephemeral';
  at: number; // epoch ms, from the envelope's RFC3339 `timestamp`
  source: Open<'cohorte' | 'runtime' | 'client' | 'human'>;
  severity: Open<'info' | 'success' | 'warning' | 'error' | 'progress'>;
  /** sanitised one-liner (≤200), safe to render verbatim. */
  summary: string;
  phase?: CohortePhaseRef;
  agent?: CohorteAgentRef;
  causationId?: string;
}

type Wire<T extends string, P> = CohorteEventHeader & { type: T; payload: P };

// ---------- run family (events/run.ts) ----------
export type CohortePipelineStarted = Wire<
  'pipeline.started',
  {
    profile: CohorteProfile;
    spec: { id: string; kind: Open<'feature' | 'patch' | 'review'> };
    runtime: { id: string; version: string; pinDigest: string };
    snapshotDigest: string;
    base: { branch: string; sha: string };
    integrationBranch: string;
    cohorteVersion: string;
    unattended: boolean; // plan.unattended
  }
>;
export type CohortePipelineCompleted = Wire<
  'pipeline.completed',
  {
    stop: CohorteStop;
    integration: { branch: string; headSha: string };
    totals: { tokens: CohorteTokenUsage; cost: CohorteCost; fixRounds: number; durationMs: number };
  }
>;
export type CohortePipelineFailed = Wire<
  'pipeline.failed',
  { state: CohorteHaltedState; error: CohorteErrorInfo; stop: CohorteStop; checkpointSequence: number }
>;
export type CohorteRunStateChanged = Wire<
  'run.state.changed',
  {
    from: Open<CohortePipelineState>;
    to: Open<CohortePipelineState>;
    reason: string; // TransitionReason
    actor: { kind: 'human' | 'client' | 'system'; id: string };
    resumeTo?: Open<CohorteActiveState>;
    stop?: CohorteStop;
  }
>;
export type CohorteRunPaused = Wire<'run.paused', { parkedAgents: string[] }>;
export type CohorteRunResumed = Wire<'run.resumed', { mode: 'unpause' | 'recovery' | 'retry'; takeover: boolean }>;
export type CohorteRunCancelled = Wire<'run.cancelled', { reason: string; cancelledAgents: string[]; worktreesKept: boolean }>;
export type CohorteRunHostAttached = Wire<'run.host.attached', { hostId: string; pid: number; cohorteVersion: string; takeover: boolean }>;
export type CohorteRunHostDetached = Wire<
  'run.host.detached',
  { hostId: string; cause: Open<'exit' | 'signal' | 'lease-lost' | 'shutdown-command' | 'fatal'> }
>;
export type CohortePhaseStarted = Wire<
  'phase.started',
  { phase: CohortePhaseRef; planned: { agentId: string; role: string; surface?: string }[] }
>;
export type CohortePhaseCompleted = Wire<
  'phase.completed',
  {
    phase: CohortePhaseRef;
    outcome: 'passed' | 'failed' | 'needs-human' | 'skipped';
    outputs: CohorteArtifactRef[];
    checks: CohorteCheckResult[];
    durationMs: number;
  }
>;
export type CohorteCheckStarted = Wire<'check.started', { name: string; argv: string[]; slot: string }>;
export type CohorteCheckCompleted = Wire<'check.completed', CohorteCheckResult>;
export type CohorteErrorEvent = Wire<'error', { error: CohorteErrorInfo; fatal: boolean }>;
export type CohorteCheckpointCreated = Wire<
  'checkpoint.created',
  { atSequence: number; cause: Open<'phase-boundary' | 'interval' | 'pause' | 'shutdown' | 'pre-effect' | 'fatal'> }
>;

// ---------- agent family (events/agent.ts) ----------
export type CohorteAgentDeclared = Wire<
  'agent.declared',
  { agent: CohorteAgentRef; parentAgentId?: string; owner: string; ownedPaths: string[]; requestedModel: CohorteModelRef; routingReason: string }
>;
export type CohorteAgentSpawned = Wire<
  'agent.spawned',
  {
    agent: CohorteAgentRef;
    /** absolute path as Cohorte reports it (host dialect) — the session↔run join key (FR-30). */
    worktree?: { slot: string; path: string; branch: string; baseSha: string };
    tools: string[];
    authMode: 'subscription' | 'api';
    sandbox: { level: string; backend: string; filesystem: string; network: string };
  }
>;
export type CohorteAgentStarted = Wire<'agent.started', { agent: CohorteAgentRef }>;
export type CohorteAgentStateChanged = Wire<
  'agent.state.changed',
  { agent: CohorteAgentRef; from: Open<CohorteAgentState>; to: Open<CohorteAgentState>; reason: string; attemptConsumed: boolean }
>;
export type CohorteAgentCompleted = Wire<
  'agent.completed',
  {
    agent: CohorteAgentRef;
    status: 'completed' | 'failed' | 'blocked' | 'needs-input';
    summary: string; // sanitised, capped 2000
    confidence: number;
    findings: number;
    questions: string[];
    artifacts: CohorteArtifactRef[];
    usage: CohorteBudgetCounters;
  }
>;
export type CohorteAgentFailed = Wire<'agent.failed', { agent: CohorteAgentRef; error: CohorteErrorInfo; willRetry: boolean; nextIncarnation?: number }>;
export type CohorteAgentTurnStarted = Wire<'agent.turn.started', { turn: number }>; // ephemeral
export type CohorteAgentTurnCompleted = Wire<'agent.turn.completed', { turn: number; toolCalls: number }>;
export type CohorteAgentMessageStarted = Wire<'agent.message.started', { messageId: string; role: 'assistant' | 'user' | 'tool-result' }>; // ephemeral
/** ephemeral; COALESCED by the core per (runId, messageId, channel) within one poll (FR-22). */
export type CohorteAgentMessageDelta = Wire<
  'agent.message.delta',
  { messageId: string; channel: 'text' | 'thinking' | 'tool-input'; delta: string; coalesced: number }
>;
export type CohorteAgentMessageCompleted = Wire<
  'agent.message.completed',
  { messageId: string; role: 'assistant' | 'user' | 'tool-result'; preview: string; bytes: number; stop?: Open<'stop' | 'length' | 'tool-use' | 'error' | 'aborted'> }
>;
export type CohorteAgentMessageAccepted = Wire<'agent.message.accepted', { agent: CohorteAgentRef; messageId: string; delivery: 'steer' | 'follow-up' }>;
export type CohorteRuntimeWarning = Wire<'runtime.warning', { agent?: CohorteAgentRef; code: string; message: string }>;
export type CohorteModelRequested = Wire<'model.requested', { requestId: string; model: CohorteModelRef; expectedAuthMode: 'subscription' | 'api'; attempt: number }>;
export type CohorteModelResponded = Wire<
  'model.responded',
  {
    requestId: string;
    requestedModel: CohorteModelRef;
    effectiveModel: CohorteModelRef;
    authMode: 'subscription' | 'api';
    status: 'ok' | 'error';
    httpStatus?: number;
    durationMs: number;
    tokens: CohorteTokenUsage;
    cost: CohorteCost;
    quota: CohorteQuota;
    attempt: number;
    error?: CohorteErrorInfo;
  }
>;
/** manifest entries/reductions/exclusions dropped — only the totals cross IPC. */
export type CohorteContextBuilt = Wire<
  'context.built',
  { agent: CohorteAgentRef; tokenEstimate: number; tokenLimit: number; entries: number; exclusions: number }
>;
export type CohorteEscalationApplied = Wire<
  'escalation.applied',
  { agent: CohorteAgentRef; step: { kind: Open<'model-tier' | 'role' | 'human'>; from?: string; to?: string }; because: string }
>;

// ---------- tool family (events/tool.ts) ----------
/** `args` is sealed on the wire and never crosses IPC. */
export type CohorteToolRequested = Wire<'tool.requested', { toolCallId: string; tool: string }>;
export type CohorteToolDenied = Wire<
  'tool.denied',
  { toolCallId: string; tool: string; stage: string; ruleId: string; reason: string; overridable: boolean; approvalId?: string }
>;
export type CohorteToolRejected = Wire<'tool.rejected', { tool: string; cause: Open<'unknown-tool' | 'invalid-input' | 'output-truncated'>; message: string }>;
export type CohorteToolStarted = Wire<
  'tool.started',
  { toolCallId: string; tool: string; decision: 'allow' | 'allow-once' | 'allow-for-run'; ruleId: string; replayOfApproval?: string }
>;
/** ephemeral; COALESCED to the last one per toolCallId within one poll (FR-22). */
export type CohorteToolProgress = Wire<'tool.progress', { toolCallId: string; text?: string; bytes?: number }>;
export type CohorteToolCompleted = Wire<
  'tool.completed',
  {
    toolCallId: string;
    tool: string;
    isError: boolean;
    exitCode?: number;
    timedOut: boolean;
    durationMs: number;
    waitedMs: number;
    /** output.preview, sanitised and capped at 512 chars. */
    preview: string;
    filesTouched: CohorteFileTouch[];
    replayed: boolean;
  }
>;
export type CohorteFileRead = Wire<'file.read', { toolCallId: string; file: CohorteFileTouch }>;
export type CohorteFileWritten = Wire<'file.written', { toolCallId: string; file: CohorteFileTouch; diffStat?: { added: number; removed: number } }>;
export type CohorteFileChanged = Wire<
  'file.changed',
  { slot: string; files: CohorteFileTouch[]; detectedBy: 'post-command-scan' | 'ledger-audit'; attributedTo?: string }
>;
export type CohorteReviewStarted = Wire<'review.started', { phase: CohortePhaseRef; reviewRef: { ref: string; sha: string }; surfaces: string[]; reviewers: string[] }>;
export type CohorteReviewFinding = Wire<'review.finding', { finding: CohorteFinding; reviewer: CohorteAgentRef; disposition: CohorteFindingDisposition }>;
export type CohorteReviewCompleted = Wire<
  'review.completed',
  {
    verdict: 'approved' | 'findings' | 'needs-human';
    blocking: number;
    blockingItems: string[];
    unreviewed: string[];
    counts: Record<CohorteSeverity, number>;
    clean: boolean;
  }
>;
export type CohorteReviewApproved = Wire<'review.approved', { reviewRef: { ref: string; sha: string }; waivers: { findingId: string; approvalId: string }[] }>;

// ---------- governance family (events/governance.ts) ----------
export type CohorteApprovalRequested = Wire<'approval.requested', CohorteApprovalRequest>;
export type CohorteApprovalResolved = Wire<
  'approval.resolved',
  { approvalId: string; decision: CohorteApprovalDecision; actor: { kind: 'human' | 'client' | 'system'; id: string }; answer?: string; note?: string }
>;
export type CohorteBudgetUpdated = Wire<
  'budget.updated',
  { scope: { level: Open<'run' | 'phase' | 'agent' | 'provider' | 'tool'>; id: string }; consumed: CohorteBudgetCounters; limit: CohorteBudgetCounters; threshold?: 50 | 80 | 100 }
>;
export type CohorteBudgetExceeded = Wire<
  'budget.exceeded',
  { scope: { level: Open<'run' | 'phase' | 'agent' | 'provider' | 'tool'>; id: string }; counter: string; limit: number; consumed: number }
>;
export type CohorteQuotaUpdated = Wire<'quota.updated', { provider: string; authMode: 'subscription' | 'api'; quota: CohorteQuota }>;
export type CohorteAuthRequired = Wire<
  'auth.required',
  { provider: string; cause: Open<'absent' | 'expired' | 'refresh-failed' | 'revoked' | 'entitlement' | 'mode-mismatch' | 'ambient-source'>; cli: string }
>;
export type CohorteRetryScheduled = Wire<
  'retry.scheduled',
  { target: { kind: Open<'agent' | 'model-request' | 'tool' | 'phase'>; id: string }; attempt: number; maxAttempts: number; delayMs: number; cause: CohorteErrorInfo }
>;
export type CohorteCommandAccepted = Wire<'command.accepted', { commandId: string; commandType: string; actor: { kind: 'human' | 'client' | 'system'; id: string } }>;
/** `result` (arbitrary JSON) is dropped. */
export type CohorteCommandCompleted = Wire<'command.completed', { commandId: string; commandType: string }>;
export type CohorteCommandRejected = Wire<'command.rejected', { commandId: string; commandType: string; error: CohorteErrorInfo }>;

// ---------- git family (events/git.ts) ----------
export type CohorteGitWorktreeCreated = Wire<'git.worktree.created', { slot: string; path: string; branch: string; baseSha: string }>;
export type CohorteGitWorktreeProvisioned = Wire<'git.worktree.provisioned', { slot: string; network: boolean }>;
export type CohorteGitWorktreeQuarantined = Wire<'git.worktree.quarantined', { slot: string; resetTo: string; patch: CohorteArtifactRef }>;
export type CohorteGitWorktreeRemoved = Wire<'git.worktree.removed', { slot: string; path: string }>;
export type CohorteGitCommitCreated = Wire<'git.commit.created', { slot: string; branch: string; sha: string; kind: 'result' | 'checkpoint'; paths: string[] }>;
export type CohorteGitMergeCompleted = Wire<'git.merge.completed', { from: string; into: string; mergeSha: string }>;
export type CohorteGitMergeConflicted = Wire<'git.merge.conflicted', { from: string; into: string; files: string[] }>;
export type CohorteRepoChangeDetected = Wire<'repo.change.detected', { slot: string; expected: string; actual: string; files: CohorteFileTouch[] }>;
export type CohorteLockAcquired = Wire<'lock.acquired', CohorteLock>;
export type CohorteLockReleased = Wire<'lock.released', CohorteLock>;
export type CohorteLockStolen = Wire<'lock.stolen', CohorteLock>;

// ---------- stream family (events/stream.ts, synthetic) ----------
/** The embedded RunSnapshotDocument is folded into the projection (→ `francois.run.updated`), never forwarded. */
export type CohorteSnapshot = Wire<'snapshot', { lastSequence: number }>;
/** Consumed by the core (host liveness); forwarded only when `hostAlive` flips. */
export type CohorteHeartbeat = Wire<'heartbeat', { hostAlive: boolean; lastSequence: number }>;

// ---------- forward-compat (AC-07) ----------
/** Any `type` not in COHORTE_WIRE_EVENT_TYPES, or a known type whose payload failed to parse. Never an error. */
export type CohorteUnknownEvent = CohorteEventHeader & {
  type: 'unknown';
  /** the Cohorte `type` string, verbatim (sanitised). */
  cohorteType: string;
  /** true when the type is known but the payload did not match (e.g. a newer minor added a required field). */
  malformed: boolean;
};

export type CohorteWireEvent =
  | CohortePipelineStarted
  | CohortePipelineCompleted
  | CohortePipelineFailed
  | CohorteRunStateChanged
  | CohorteRunPaused
  | CohorteRunResumed
  | CohorteRunCancelled
  | CohorteRunHostAttached
  | CohorteRunHostDetached
  | CohortePhaseStarted
  | CohortePhaseCompleted
  | CohorteCheckStarted
  | CohorteCheckCompleted
  | CohorteErrorEvent
  | CohorteCheckpointCreated
  | CohorteAgentDeclared
  | CohorteAgentSpawned
  | CohorteAgentStarted
  | CohorteAgentStateChanged
  | CohorteAgentCompleted
  | CohorteAgentFailed
  | CohorteAgentTurnStarted
  | CohorteAgentTurnCompleted
  | CohorteAgentMessageStarted
  | CohorteAgentMessageDelta
  | CohorteAgentMessageCompleted
  | CohorteAgentMessageAccepted
  | CohorteRuntimeWarning
  | CohorteModelRequested
  | CohorteModelResponded
  | CohorteContextBuilt
  | CohorteEscalationApplied
  | CohorteToolRequested
  | CohorteToolDenied
  | CohorteToolRejected
  | CohorteToolStarted
  | CohorteToolProgress
  | CohorteToolCompleted
  | CohorteFileRead
  | CohorteFileWritten
  | CohorteFileChanged
  | CohorteReviewStarted
  | CohorteReviewFinding
  | CohorteReviewCompleted
  | CohorteReviewApproved
  | CohorteApprovalRequested
  | CohorteApprovalResolved
  | CohorteBudgetUpdated
  | CohorteBudgetExceeded
  | CohorteQuotaUpdated
  | CohorteAuthRequired
  | CohorteRetryScheduled
  | CohorteCommandAccepted
  | CohorteCommandCompleted
  | CohorteCommandRejected
  | CohorteGitWorktreeCreated
  | CohorteGitWorktreeProvisioned
  | CohorteGitWorktreeQuarantined
  | CohorteGitWorktreeRemoved
  | CohorteGitCommitCreated
  | CohorteGitMergeCompleted
  | CohorteGitMergeConflicted
  | CohorteRepoChangeDetected
  | CohorteLockAcquired
  | CohorteLockReleased
  | CohorteLockStolen
  | CohorteSnapshot
  | CohorteHeartbeat
  | CohorteUnknownEvent;

/** The Cohorte Protocol 1.0 catalogue, verbatim — 68 types (catalogue.ts EVENTS). */
export const COHORTE_WIRE_EVENT_TYPES = [
  // run
  'pipeline.started',
  'pipeline.completed',
  'pipeline.failed',
  'run.state.changed',
  'run.paused',
  'run.resumed',
  'run.cancelled',
  'run.host.attached',
  'run.host.detached',
  'phase.started',
  'phase.completed',
  'check.started',
  'check.completed',
  'error',
  'checkpoint.created',
  // agent
  'agent.declared',
  'agent.spawned',
  'agent.started',
  'agent.state.changed',
  'agent.completed',
  'agent.failed',
  'agent.turn.started',
  'agent.turn.completed',
  'agent.message.started',
  'agent.message.delta',
  'agent.message.completed',
  'agent.message.accepted',
  'runtime.warning',
  'model.requested',
  'model.responded',
  'context.built',
  'escalation.applied',
  // tool
  'tool.requested',
  'tool.denied',
  'tool.rejected',
  'tool.started',
  'tool.progress',
  'tool.completed',
  'file.read',
  'file.written',
  'file.changed',
  'review.started',
  'review.finding',
  'review.completed',
  'review.approved',
  // governance
  'approval.requested',
  'approval.resolved',
  'budget.updated',
  'budget.exceeded',
  'quota.updated',
  'auth.required',
  'retry.scheduled',
  'command.accepted',
  'command.completed',
  'command.rejected',
  // git
  'git.worktree.created',
  'git.worktree.provisioned',
  'git.worktree.quarantined',
  'git.worktree.removed',
  'git.commit.created',
  'git.merge.completed',
  'git.merge.conflicted',
  'repo.change.detected',
  'lock.acquired',
  'lock.released',
  'lock.stolen',
  // stream
  'snapshot',
  'heartbeat',
] as const;
export type CohorteWireEventType = (typeof COHORTE_WIRE_EVENT_TYPES)[number];

// Compile-time proof that the union and the catalogue list are the same set.
type KnownWireType = Exclude<CohorteWireEvent['type'], 'unknown'>;
type Assert<T extends true> = T;
export type _CatalogueCoversUnion = Assert<[KnownWireType] extends [CohorteWireEventType] ? true : false>;
export type _UnionCoversCatalogue = Assert<[CohorteWireEventType] extends [KnownWireType] ? true : false>;

// =====================================================================
// 3. The projection the UI renders (core-reduced; spec §6)
// =====================================================================

/** Francois' reading of a run, derived in the core (FR-24). */
export type CohorteRunView =
  | 'idle'
  | 'running'
  | 'gate' // ≥1 pending approval known from the event log
  | 'waiting' // WAITING_APPROVAL but the approval.requested event not seen yet
  | 'paused'
  | 'auth' // AUTH_REQUIRED
  | 'quota' // QUOTA_EXCEEDED
  | 'failed'
  | 'blocked'
  | 'completed'
  | 'cancelled';

export interface CohorteStep {
  agentId: string;
  role: string;
  surface?: string;
  /** AgentNode.label when known, else `<role> · <surface>` / `<role>`. */
  label: string;
  status: Open<CohorteNodeStatus>;
  lifecycle?: Open<CohorteAgentState>;
  attempt: number;
  incarnation: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  worktree?: { path: string; branch?: string };
  summary?: string;
  findings?: number;
  lastError?: CohorteErrorInfo;
  pendingApprovalId?: string;
}

export interface CohortePhase {
  state: Open<CohorteActiveState>;
  /** 'Build', 'Review' … (PhaseNode.label, else title-cased state). */
  label: string;
  status: Open<CohorteNodeStatus>;
  /** latest phase run's iteration (FIX may run several). */
  iteration: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  outcome?: string;
  steps: CohorteStep[];
  checks: CohorteCheckResult[];
}

export interface CohorteReviewRound {
  phaseRunId?: string;
  startedAt: number;
  verdict?: 'approved' | 'findings' | 'needs-human';
  /** refuted + duplicate excluded; ordered blocking first, then severity, then event order. */
  findings: CohorteFinding[];
  counts: Record<CohorteSeverity, number>;
  blocking: number;
  clean?: boolean;
}

/** Action ids the UI renders as 1 / 2 / 3 (spec FR-41..FR-44). */
export type CohorteGateActionId = 'approve' | 'fix' | 'deny';

export interface CohorteGateAction {
  id: CohorteGateActionId;
  /** true for `deny` when it also cancels the run (FR-44): the label reads "Deny · stop run". */
  stopsRun: boolean;
  /** The exact CLI the core will run, one display line per step, e.g.
   *  ["cohorte deny run_7fa3c1 apr_…", "cohorte cancel run_7fa3c1"]. */
  cli: string[];
}

export interface CohorteGate {
  runId: string;
  request: CohorteApprovalRequest;
  requestedAt: number;
  /** 1-based index of the gate's phase in `CohorteRun.phases`, when it has one. */
  phaseIndex?: number;
  phaseCount: number;
  /** the latest review round's findings when the gate is a review/ship gate (FR-39), else []. */
  findings: CohorteFinding[];
  /** in display order approve · fix · deny; an action absent here is not offered. */
  actions: CohorteGateAction[];
  /** other pending approvals on the same run (the card shows "+N more"). */
  morePending: number;
}

export interface CohorteWorktree {
  slot: string;
  path: string; // absolute, host dialect
  branch: string;
  agentId?: string;
  removed: boolean;
}

export interface CohorteArtifact {
  kind: Open<'spec' | 'diff' | 'report' | 'log' | 'file' | 'patch' | 'agent-output' | 'transcript' | 'context' | 'prompt'>;
  /** display label: 'spec/auth-retry.md', 'report.json' … */
  label: string;
  /** absolute path when Francois can open it (inside the Cohorte root or a run worktree), else absent. */
  path?: string;
  meta?: string; // 'frozen', '+97 −31', 'review output'
}

export interface CohorteRun {
  projectRoot: string;
  runId: string;
  /** RunNode.title, else spec id. */
  title: string;
  /** spec id — the "feature" name (auth-retry). */
  specId: string;
  specKind?: string;
  profile: CohorteProfile;
  state: Open<CohortePipelineState>;
  view: CohorteRunView;
  /** the active phase (current, or resumeTo while suspended). */
  currentPhase?: Open<CohorteActiveState>;
  resumeTo?: Open<CohorteActiveState>;
  since: number;
  startedAt: number;
  endedAt?: number;
  stop?: CohorteStop;
  lastError?: CohorteErrorInfo;
  iteration: { fixRounds: number; maxFixRounds: number; reviewRounds: number };
  host: { alive: boolean; heartbeatAt?: number; pid?: number };
  git: { baseBranch: string; baseSha?: string; integrationBranch?: string; integrationHead?: string };
  runtime?: { id: string; version: string; pinDigest?: string };
  snapshotDigest?: string;
  cohorteVersion?: string;
  unattended?: boolean;
  phases: CohortePhase[];
  worktrees: CohorteWorktree[];
  gate: CohorteGate | null;
  review: CohorteReviewRound | null;
  artifacts: CohorteArtifact[];
  usage?: { tokens: CohorteTokenUsage; cost: CohorteCost };
  /** highest durable sequence folded in. */
  lastSequence: number;
  /** the CLI's tail dump was capped (dev.8: 1000 events) and events past it are not visible (FR-20). */
  tailTruncated: boolean;
  /** last successful refresh of this run, epoch ms. */
  refreshedAt: number;
}

/** One row of the activity log ("Tail logs", FR-69). Every wire event yields one. */
export interface CohorteLogEntry {
  runId: string;
  sequence: number;
  sub: number;
  at: number;
  type: string; // the Cohorte type verbatim ('unknown' types included)
  severity: string;
  summary: string; // sanitised
  agentId?: string;
  phase?: string;
}

// =====================================================================
// 4. Detection, doctor, policy (Settings · Cohorte, frames 27/28)
// =====================================================================

/**
 * Precedence (FR-3): cli-missing is reported only when `.cohorte/` exists —
 * a project with neither reads `not-initialised` (with `cli.installed: false`).
 */
export type CohorteDetectionState =
  | 'detected' // .cohorte/ found and a compatible CLI answered
  | 'not-initialised' // no .cohorte/ from the start dir, nor in the main checkout
  | 'cli-missing' // .cohorte/ found, `cohorte` does not resolve on the login-shell PATH
  | 'cli-incompatible' // .cohorte/ found, CLI answered a version outside the supported range
  | 'no-project'; // the start dir does not exist / is not a directory

export interface CohorteCliInfo {
  installed: boolean;
  /** `cohorte --version` verbatim (e.g. '3.0.0-dev.8'). */
  version?: string;
  /** semver range Francois speaks (FR-5): '>=3.0.0-dev.1 <4.0.0'. */
  supportedRange: string;
  compatible: boolean;
}

export interface CohorteDetection {
  /** the directory the caller asked about (project root or session cwd), normalised. */
  startDir: string;
  state: CohorteDetectionState;
  /** directory that holds `.cohorte/` (walk-up or git-common-dir); absent unless found. */
  root?: string;
  /** `<root>/.cohorte`, for display. */
  dir?: string;
  /** how `root` was found. */
  foundVia?: 'walk-up' | 'git-common-dir';
  /** `.cohorte/project.yaml` present (the CLI's own "is a Cohorte project" test). */
  hasProjectFile: boolean;
  /** `.cohorte/state/cohorte.db` present → 'sqlite'; else null (never opened, never read). */
  stateBackend: 'sqlite' | null;
  /** current branch of `root` (`git rev-parse --abbrev-ref HEAD`); null on detached HEAD / not git. */
  rootBranch: string | null;
  /** runtime id from `cohorte config get` (`runtime.id`/`runtime`), e.g. 'pi'. */
  runtime?: string;
  cli: CohorteCliInfo;
  checkedAt: number; // epoch ms
}

export type CohorteCheckStatus = Open<'ok' | 'warning' | 'error' | 'skipped'>;

/** One row of the Detection card's check list. */
export interface CohorteHealthRow {
  /** the command shown in the row: 'cohorte doctor', 'cohorte config validate', or 'cohorte doctor · <checkId>'. */
  command: string;
  status: CohorteCheckStatus;
  summary: string; // sanitised
  remediation?: string;
}

export interface CohorteDoctorReport {
  root: string;
  ok: boolean;
  cohorteVersion: string;
  generatedAt: number;
  /** DoctorReport.checks verbatim (id, status, summary, detail?, remediation?). */
  checks: { id: string; status: CohorteCheckStatus; summary: string; detail?: string; remediation?: string }[];
  /** rows for the card, in order (FR-10). */
  rows: CohorteHealthRow[];
  ranAt: number;
}

export interface CohortePolicySummary {
  root: string;
  /** labels of steps that always ask (FR-11), e.g. ['ship', 'git push', 'db migrations']. */
  gatedSteps: string[];
  /** policy.approvals.unattended. */
  unattended?: 'deny' | 'wait';
  /** where the policy lives, for the note: '.cohorte/config.yaml'. */
  file: string;
  readAt: number;
}

// =====================================================================
// 5. Commands (request/response) — francois:cohorte:<verb> → cohorte_<verb>
// =====================================================================

/** francois:cohorte:detect → cohorte_detect. Cached 30 s per startDir unless `force`. */
export interface CohorteDetectRequest {
  startDir: string;
  force?: boolean;
}
export type CohorteDetectResponse = Result<CohorteDetection>;

/** francois:cohorte:doctor → cohorte_doctor. `cohorte doctor --json` + `cohorte config validate`. */
export interface CohorteRootRequest {
  root: string;
}
export type CohorteDoctorResponse = Result<CohorteDoctorReport>;

/** francois:cohorte:policy → cohorte_policy. `cohorte config get` (read-only JSON). */
export type CohortePolicyResponse = Result<CohortePolicySummary>;

/** francois:cohorte:init → cohorte_init. `cohorte init` in `projectRoot` — the ONE write Francois triggers,
 *  always through the CLI (FR-12). Resolves to the fresh detection. */
export interface CohorteInitRequest {
  projectRoot: string;
}
export type CohorteInitResponse = Result<CohorteDetection>;

/**
 * francois:cohorte:watch → cohorte_watch. DECLARATIVE: the complete set of Cohorte roots this window wants
 * watched, plus whether the window is in the foreground. The core diffs against the previous call; `roots: []`
 * stops every watcher (after the 30 s linger, FR-15).
 */
export interface CohorteWatchRequest {
  roots: string[];
  foreground: boolean;
}
export type CohorteWatchResponse = Result<null>;

/** francois:cohorte:listRuns → cohorte_list_runs. The current projections for one root (hydration). */
export type CohorteListRunsResponse = Result<CohorteRun[]>;

/** francois:cohorte:getRun → cohorte_get_run. Forces one status + tail refresh of that run first. */
export interface CohorteRunRequest {
  root: string;
  runId: string;
}
export type CohorteGetRunResponse = Result<CohorteRun>;

/** francois:cohorte:runLog → cohorte_run_log. The in-memory activity ring (≤500 per run), oldest first. */
export interface CohorteRunLogRequest extends CohorteRunRequest {
  /** default 200, clamped 1..500; returns the newest `limit`. */
  limit?: number;
}
export type CohorteRunLogResponse = Result<CohorteLogEntry[]>;

/** How one CLI step ended (spec FR-47). Exit 4 is NOT an error. */
export interface CohorteCommandStep {
  /** display form of the argv that ran: 'cohorte approve run_… apr_…'. */
  cli: string;
  outcome: 'completed' | 'pending' | 'rejected' | 'skipped';
  exitCode: number;
  /** CommandResultDocument.error.message when rejected (sanitised). */
  message?: string;
  errorCode?: string; // Cohorte's own 'conflict/run-active' …
}

export interface CohorteCommandOutcome {
  runId: string;
  steps: CohorteCommandStep[];
  /** the run as re-read right after the command (status + tail). */
  run: CohorteRun | null;
}
export type CohorteCommandResponse = Result<CohorteCommandOutcome>;

/** francois:cohorte:approve → cohorte_approve: `cohorte approve <runId> <approvalId> [<answer>]`. */
export interface CohorteApproveRequest extends CohorteRunRequest {
  approvalId: string;
  /** must be one of the request's `options` when it has them. */
  answer?: string;
}

/**
 * francois:cohorte:sendToFix → cohorte_send_to_fix (FR-43):
 *  (a) request.options holds a fix answer → `cohorte approve <runId> <approvalId> <that option>`;
 *  (b) else `cohorte deny <runId> <approvalId>` then `cohorte fix <runId>` (= retry --phase FIX); a fix step
 *      rejected with `conflict/*` is reported `outcome:'rejected'` but the response stays ok (Cohorte routes).
 */
export interface CohorteSendToFixRequest extends CohorteRunRequest {
  approvalId: string;
  /** composer text for the fix step; passed as a note only when the CLI supports it (FR-45), else dropped. */
  note?: string;
}

/** francois:cohorte:deny → cohorte_deny: `cohorte deny <runId> <approvalId>`, then `cohorte cancel <runId>`
 *  iff `stopRun` (FR-44). */
export interface CohorteDenyRequest extends CohorteRunRequest {
  approvalId: string;
  stopRun: boolean;
  note?: string;
}

/** francois:cohorte:pause | resume | cancel → cohorte_pause | cohorte_resume | cohorte_cancel. */
export interface CohorteRunControlRequest extends CohorteRunRequest {
  /** pause/cancel only; passed positionally to `pause` (dev.8 reads it), ignored by `cancel` at dev.8. */
  reason?: string;
}

export interface CohorteCommandMap {
  cohorte_detect: { req: CohorteDetectRequest; res: CohorteDetectResponse };
  cohorte_doctor: { req: CohorteRootRequest; res: CohorteDoctorResponse };
  cohorte_policy: { req: CohorteRootRequest; res: CohortePolicyResponse };
  cohorte_init: { req: CohorteInitRequest; res: CohorteInitResponse };
  cohorte_watch: { req: CohorteWatchRequest; res: CohorteWatchResponse };
  cohorte_list_runs: { req: CohorteRootRequest; res: CohorteListRunsResponse };
  cohorte_get_run: { req: CohorteRunRequest; res: CohorteGetRunResponse };
  cohorte_run_log: { req: CohorteRunLogRequest; res: CohorteRunLogResponse };
  cohorte_approve: { req: CohorteApproveRequest; res: CohorteCommandResponse };
  cohorte_send_to_fix: { req: CohorteSendToFixRequest; res: CohorteCommandResponse };
  cohorte_deny: { req: CohorteDenyRequest; res: CohorteCommandResponse };
  cohorte_pause: { req: CohorteRunControlRequest; res: CohorteCommandResponse };
  cohorte_resume: { req: CohorteRunControlRequest; res: CohorteCommandResponse };
  cohorte_cancel: { req: CohorteRunControlRequest; res: CohorteCommandResponse };
}

// =====================================================================
// 6. The event stream — francois://cohorte/event
// =====================================================================

/** Derived events the core emits beside the wire events (FR-23). */
export type CohorteDerivedEvent =
  /** a detection result differs from the last one emitted for that startDir (state, root, version). */
  | { type: 'francois.detection.changed'; detection: CohorteDetection }
  /** the projection of one run changed (any field). Carries the whole run: the store replaces, never merges. */
  | { type: 'francois.run.updated'; run: CohorteRun }
  /** a run no longer appears in `status` (gc'd / store reset). */
  | { type: 'francois.run.removed'; projectRoot: string; runId: string }
  /** an approval became the run's gate (edge-triggered once per approvalId). */
  | { type: 'francois.gate.opened'; projectRoot: string; gate: CohorteGate }
  /** the gate closed: resolved by anyone (approval.resolved), or vanished from status (`decision: 'unknown'`). */
  | {
      type: 'francois.gate.resolved';
      projectRoot: string;
      runId: string;
      approvalId: string;
      decision: CohorteApprovalDecision | 'unknown';
      /** 'human:<id>' / 'client:<id>' / 'system:<id>' when known. */
      actor?: string;
    }
  /** watcher health for one root: `error` set while polls fail; cleared on the next success (FR-19). */
  | {
      type: 'francois.watch.status';
      projectRoot: string;
      healthy: boolean;
      error?: { code: ErrorCode; message: string };
      nextPollInMs: number;
    };

export type CohorteEvent = CohorteWireEvent | CohorteDerivedEvent;
export type CohorteEventType = CohorteEvent['type'];

export const COHORTE_EVENT_CHANNEL = 'francois://cohorte/event';

// =====================================================================
// 7. Francois-side preferences (frontend only, localStorage; FR-53)
// =====================================================================

export interface CohortePrefs {
  showPanelTab: boolean; // default true
  gatesInNeedsYou: boolean; // default true
  groupSessionsUnderRun: boolean; // default true
  notifyOnGate: boolean; // default false
}

export const COHORTE_PREF_KEYS: Record<keyof CohortePrefs, string> = {
  showPanelTab: 'francois.cohorte.showPanelTab',
  gatesInNeedsYou: 'francois.cohorte.gatesInNeedsYou',
  groupSessionsUnderRun: 'francois.cohorte.groupSessionsUnderRun',
  notifyOnGate: 'francois.cohorte.notifyOnGate',
};

export const COHORTE_PREF_DEFAULTS: CohortePrefs = {
  showPanelTab: true,
  gatesInNeedsYou: true,
  groupSessionsUnderRun: true,
  notifyOnGate: false,
};

// =====================================================================
// 8. Session ↔ run linkage (frontend, src/features/cohorte/linkage.ts; FR-30)
// =====================================================================

export type CohorteLinkReason =
  | 'launched' // 1. the session's own transcript ran `cohorte run|loop|build|fix|review` and printed this runId
  | 'worktree' // 2. session cwd == a run worktree path
  | 'branch' // 3. session worktree branch == run integration branch or a run worktree branch
  | 'base-branch'; // 4. session in the Cohorte root checkout on the run's base branch, run not terminal

export interface CohorteSessionLink {
  sessionId: SessionId;
  projectRoot: string;
  runId: string;
  reason: CohorteLinkReason;
  /** 'worktree' and 'branch' links are STEP sessions (nested under the run); the others are ORIGIN sessions. */
  role: 'origin' | 'step';
}

// =====================================================================
// 9. Error codes (members of common.ts ErrorCode)
// =====================================================================

export type CohorteErrorCode = Extract<
  ErrorCode,
  | 'COHORTE_NOT_DETECTED'
  | 'COHORTE_CLI_MISSING'
  | 'COHORTE_CLI_INCOMPATIBLE'
  | 'COHORTE_TIMEOUT'
  | 'COHORTE_OUTPUT_CAPPED'
  | 'COHORTE_OUTPUT_INVALID'
  | 'COHORTE_COMMAND_FAILED'
  | 'COHORTE_REJECTED'
  | 'COHORTE_RUN_NOT_FOUND'
  | 'COHORTE_GATE_NOT_PENDING'
  | 'INVALID_INPUT'
>;
