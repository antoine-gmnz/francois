// contract/cohorte-integration.ts — cohorte-integration (Cohorte v3 runs inside // no .cohorte/ for that root (detail: { startDir }) // `cohorte` does not resolve on the login-shell PATH // version outside the supported range (detail: { version, supportedRange }) // a CLI spawn was killed at its deadline (detail: { cli, timeoutMs }) // stdout past the cap (detail: { cli, capBytes }) // stdout is not a document Francois can read (detail: { cli }) // exit code other than 0/3/4 (detail: { cli, code, stderr }) // exit 3 on the FIRST step (detail: { cli, cohorteCode, message }) // runId unknown to status (detail: { runId }) // the approval is no longer pending (resolved elsewhere)
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

// The vocabulary, shared records and event catalogue live in ./cohorte-events.ts (size cap).
import type { ErrorCode, Result, SessionId } from './common';
import type {
  Open,
  CohorteActiveState,
  CohortePipelineState,
  CohorteNodeStatus,
  CohorteAgentState,
  CohorteProfile,
  CohorteSeverity,
  CohorteApprovalDecision,
  CohorteErrorInfo,
  CohorteStop,
  CohorteTokenUsage,
  CohorteCost,
  CohorteCheckResult,
  CohorteFinding,
  CohorteApprovalRequest,
  CohorteWireEvent,
} from './cohorte-events';

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
  | 'COHORTE_NOT_DETECTED' // no .cohorte/ for that root (detail: { startDir })
  | 'COHORTE_CLI_MISSING' // `cohorte` does not resolve on the login-shell PATH
  | 'COHORTE_CLI_INCOMPATIBLE' // version outside the supported range (detail: { version, supportedRange })
  | 'COHORTE_TIMEOUT' // a CLI spawn was killed at its deadline (detail: { cli, timeoutMs })
  | 'COHORTE_OUTPUT_CAPPED' // stdout past the cap (detail: { cli, capBytes })
  | 'COHORTE_OUTPUT_INVALID' // stdout is not a document Francois can read (detail: { cli })
  | 'COHORTE_COMMAND_FAILED' // exit code other than 0/3/4 (detail: { cli, code, stderr })
  | 'COHORTE_REJECTED' // exit 3 on the FIRST step (detail: { cli, cohorteCode, message })
  | 'COHORTE_RUN_NOT_FOUND' // runId unknown to status (detail: { runId })
  | 'COHORTE_GATE_NOT_PENDING' // the approval is no longer pending (resolved elsewhere)
  | 'INVALID_INPUT'
>;
