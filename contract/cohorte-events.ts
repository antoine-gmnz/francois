// contract/cohorte-events.ts — cohorte-integration, part 1 of 2: the Cohorte vocabulary,
// the normalised shared records and the full event catalogue (one typed member per
// Cohorte Protocol 1.0 event type). Split out of contract/cohorte-integration.ts only to
// stay under the 1000-line cap; the IPC channels, the run projection and the derived
// `francois.*` events live there. Spec: specs/cohorte-integration.md.

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
