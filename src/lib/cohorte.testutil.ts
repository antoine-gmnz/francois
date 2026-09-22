// Test fixtures for the cohorte-integration frontend (store, linkage, view
// models). Imported by *.test.ts files only — a normal build never reaches it.

import type { CohorteDetection, CohorteGate, CohortePhase, CohorteRun, CohorteStep } from '../../contract/cohorte-integration';
import type { CohorteApprovalRequest, CohorteEventHeader, CohorteFinding, CohorteWireEvent } from '../../contract/cohorte-events';

export const ROOT = '/code/orbit';
export const RUN_ID = 'run_7fa3c1d2e3f4a5b6c7d8e9f0a1b2c3d4';

export function header(over: Partial<CohorteEventHeader> = {}): CohorteEventHeader {
  return {
    projectRoot: ROOT,
    runId: RUN_ID,
    eventId: 'evt_1',
    sequence: 1,
    sub: 0,
    durability: 'durable',
    at: 1_000,
    source: 'cohorte',
    severity: 'info',
    summary: 'something happened',
    ...over,
  };
}

/** A wire event of any type. The payload defaults to `{}` — enough for the
 *  members whose UI effect is "log only". */
export function wire(type: string, payload: object = {}, over: Partial<CohorteEventHeader> = {}): CohorteWireEvent {
  if (type === 'unknown') return { ...header(over), type: 'unknown', cohorteType: 'foo.bar', malformed: false };
  return { ...header(over), type, payload } as unknown as CohorteWireEvent;
}

export function step(over: Partial<CohorteStep> = {}): CohorteStep {
  return { agentId: 'agt_1', role: 'implementer', label: 'implement · auth', status: 'completed', attempt: 1, incarnation: 1, ...over };
}

export function phase(state: string, over: Partial<CohortePhase> = {}): CohortePhase {
  return {
    state,
    label: state.charAt(0) + state.slice(1).toLowerCase(),
    status: 'pending',
    iteration: 1,
    steps: [],
    checks: [],
    ...over,
  };
}

export function finding(over: Partial<CohorteFinding> = {}): CohorteFinding {
  return {
    id: 'fnd_1',
    severity: 'major',
    kind: 'quality',
    rule: 'no-hardcode',
    title: 'Retry count is hardcoded in two services',
    expected: '',
    actual: 'Retry count is hardcoded in two services',
    file: 'services/auth/callback.ts',
    line: 41,
    confidence: 0.9,
    scope: 'in-scope',
    disposition: 'kept',
    blocking: true,
    label: 'blocking',
    ...over,
  };
}

export function request(over: Partial<CohorteApprovalRequest> = {}): CohorteApprovalRequest {
  return {
    approvalId: 'apr_1',
    kind: 'review-leftovers',
    affectedPaths: [],
    preview: { kind: 'text', text: '', truncated: false },
    ruleId: 'review',
    reason: 'Review found 4 issues, 1 blocking.',
    asks: [],
    allowedDecisions: ['allow-once', 'deny'],
    unattended: 'wait',
    cli: 'cohorte approve apr_1',
    ...over,
  };
}

export function gate(over: Partial<CohorteGate> = {}): CohorteGate {
  return {
    runId: RUN_ID,
    request: request(),
    requestedAt: 5_000,
    phaseIndex: 3,
    phaseCount: 5,
    findings: [finding()],
    actions: [
      { id: 'approve', stopsRun: false, cli: [`cohorte approve ${RUN_ID} apr_1`] },
      { id: 'fix', stopsRun: false, cli: [`cohorte deny ${RUN_ID} apr_1`, `cohorte fix ${RUN_ID}`] },
      { id: 'deny', stopsRun: true, cli: [`cohorte deny ${RUN_ID} apr_1`, `cohorte cancel ${RUN_ID}`] },
    ],
    morePending: 0,
    ...over,
  };
}

export function run(over: Partial<CohorteRun> = {}): CohorteRun {
  return {
    projectRoot: ROOT,
    runId: RUN_ID,
    title: 'auth-retry',
    specId: 'auth-retry',
    specKind: 'feature',
    profile: 'feature',
    state: 'BUILD',
    view: 'running',
    currentPhase: 'BUILD',
    since: 1_000,
    startedAt: 1_000,
    iteration: { fixRounds: 0, maxFixRounds: 3, reviewRounds: 0 },
    host: { alive: true },
    git: { baseBranch: 'main', integrationBranch: 'cohorte/auth-retry' },
    phases: [],
    worktrees: [],
    gate: null,
    review: null,
    artifacts: [],
    lastSequence: 1,
    tailTruncated: false,
    refreshedAt: 1_000,
    ...over,
  };
}

export function detection(over: Partial<CohorteDetection> = {}): CohorteDetection {
  return {
    startDir: ROOT,
    state: 'detected',
    root: ROOT,
    dir: `${ROOT}/.cohorte`,
    foundVia: 'walk-up',
    hasProjectFile: true,
    stateBackend: 'sqlite',
    rootBranch: 'main',
    cli: { installed: true, version: '3.0.0-dev.8', supportedRange: '>=3.0.0-dev.1 <4.0.0', compatible: true },
    checkedAt: 1_000,
    ...over,
  };
}
