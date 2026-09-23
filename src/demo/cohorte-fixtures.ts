// Demo fixtures for cohorte-integration (spec FR-89) — the fake Cohorte project
// behind frames 25–28 when VITE_FRANCOIS_DEMO=1. Project `orbit` is detected
// (cli 3.4.1, runtime Pi, SQLite); every other demo project is not initialised.
// One run, `run_7fa3c1…` (spec auth-retry), waits at a review-leftovers gate
// with the four frame-25 findings. orbit-api's transcript carries the three
// Cohorte tool rows, so the link is `launched`.
//
// Same shakeability rules as fixtures.ts: literals and functions only, no
// top-level calls — nothing here may run unless the demo flag is on.

import type { CohorteCommandOutcome, CohorteDetection, CohorteDoctorReport, CohorteGate, CohorteLogEntry, CohortePolicySummary, CohorteRun } from '../../contract/cohorte-integration';
import type { CohorteFinding } from '../../contract/cohorte-events';
import type { ConversationBlock } from '../../contract/conversation-view';
import { T0 } from './fixtures';

const MIN = 60_000;
export const DEMO_COHORTE_ROOT = '~/code/orbit';
export const DEMO_RUN_ID = 'run_7fa3c1d2e3f4a5b6c7d8e9f0a1b2c3d4';
const APPROVAL_ID = 'apr_4b1e9c0d7a2f';
const API_CWD = '~/code/orbit/services/api';
const AUTH_RETRY_CWD = '~/code/orbit-auth-retry';

/** Whether a demo start dir resolves to the orbit Cohorte root (walk-up, or a linked worktree). */
export function isOrbitDir(dir: string): boolean {
  return dir === DEMO_COHORTE_ROOT || dir.startsWith(`${DEMO_COHORTE_ROOT}/`) || dir.startsWith(`${DEMO_COHORTE_ROOT}-`);
}

export function demoDetection(startDir: string): CohorteDetection {
  const cli = { installed: true, version: '3.4.1', supportedRange: '>=3.0.0-dev.1 <4.0.0', compatible: true };
  if (!isOrbitDir(startDir)) {
    return { startDir, state: 'not-initialised', hasProjectFile: false, stateBackend: null, rootBranch: null, cli, checkedAt: Date.now() - 2 * MIN };
  }
  return {
    startDir,
    state: 'detected',
    root: DEMO_COHORTE_ROOT,
    dir: `${DEMO_COHORTE_ROOT}/.cohorte`,
    foundVia: startDir.startsWith(`${DEMO_COHORTE_ROOT}-`) ? 'git-common-dir' : 'walk-up',
    hasProjectFile: true,
    stateBackend: 'sqlite',
    rootBranch: 'main',
    runtime: 'Pi',
    cli,
    checkedAt: Date.now(),
  };
}

export function demoDoctor(): CohorteDoctorReport {
  const now = Date.now();
  return {
    root: DEMO_COHORTE_ROOT,
    ok: true,
    cohorteVersion: '3.4.1',
    generatedAt: now,
    ranAt: now,
    checks: [],
    rows: [
      { command: 'cohorte doctor', status: 'ok', summary: '12 checks passed · 0 warnings' },
      { command: 'cohorte config validate', status: 'ok', summary: '.cohorte/config.yaml valid' },
      { command: 'cohorte providers test', status: 'ok', summary: 'Pi reachable · 2 models' },
      { command: 'cohorte gc', status: 'ok', summary: '3 runs kept · last swept 2 days ago' },
    ],
  };
}

export function demoPolicy(): CohortePolicySummary {
  return {
    root: DEMO_COHORTE_ROOT,
    gatedSteps: ['ship', 'push', 'db migrations', 'network access', 'secrets'],
    unattended: 'wait',
    file: '.cohorte/config.yaml',
    readAt: Date.now(),
  };
}

function finding(id: string, title: string, file: string, line: number, severity: CohorteFinding['severity'], label: CohorteFinding['label']): CohorteFinding {
  return {
    id,
    severity,
    kind: 'quality',
    rule: 'review',
    title,
    expected: '',
    actual: title,
    file,
    line,
    confidence: 0.9,
    scope: 'in-scope',
    disposition: 'kept',
    blocking: label === 'blocking',
    label,
  };
}

function findings(): CohorteFinding[] {
  return [
    finding('fnd_1', 'Retry count is hardcoded in two services', 'services/auth/callback.ts', 41, 'major', 'blocking'),
    finding('fnd_2', 'Log line dropped without replacement', 'services/auth/callback.ts', 42, 'minor', 'minor'),
    finding('fnd_3', 'Test name does not say what is asserted', 'services/auth/retry.test.ts', 12, 'minor', 'minor'),
    finding('fnd_4', 'Unused import left behind', 'services/billing/src/params.ts', 3, 'info', 'nit'),
  ];
}

function gate(requestedAt: number): CohorteGate {
  const approve = `cohorte approve ${DEMO_RUN_ID} ${APPROVAL_ID}`;
  return {
    runId: DEMO_RUN_ID,
    requestedAt,
    phaseIndex: 3,
    phaseCount: 5,
    findings: findings(),
    morePending: 0,
    request: {
      approvalId: APPROVAL_ID,
      kind: 'review-leftovers',
      phase: { phaseRunId: 'phr_review_1', state: 'REVIEW', iteration: 1 },
      affectedPaths: [],
      preview: { kind: 'text', text: '', truncated: false },
      ruleId: 'review.leftovers',
      reason: 'Review found 4 issues, 1 blocking.',
      asks: [],
      allowedDecisions: ['allow-once', 'deny'],
      unattended: 'wait',
      cli: `cohorte approve ${APPROVAL_ID}`,
    },
    actions: [
      { id: 'approve', stopsRun: false, cli: [approve] },
      { id: 'fix', stopsRun: false, cli: [`cohorte deny ${DEMO_RUN_ID} ${APPROVAL_ID}`, `cohorte fix ${DEMO_RUN_ID}`] },
      { id: 'deny', stopsRun: true, cli: [`cohorte deny ${DEMO_RUN_ID} ${APPROVAL_ID}`, `cohorte cancel ${DEMO_RUN_ID}`] },
    ],
  };
}

type Step = CohorteRun['phases'][number]['steps'][number];
function step(agentId: string, label: string, role: string, startedAt: number, durationMs: number, worktree?: string): Step {
  return {
    agentId,
    role,
    label,
    status: 'completed',
    lifecycle: 'completed',
    attempt: 1,
    incarnation: 1,
    startedAt,
    endedAt: startedAt + durationMs,
    durationMs,
    ...(worktree ? { worktree: { path: worktree, branch: `cohorte/auth-retry/${agentId}` } } : {}),
  };
}

/** The frame 25/26 run, waiting at the review gate. */
export function demoRun(): CohorteRun {
  const start = T0 - 8 * MIN - 12_000;
  const requestedAt = Date.now() - 4 * MIN;
  const f = findings();
  return {
    projectRoot: DEMO_COHORTE_ROOT,
    runId: DEMO_RUN_ID,
    title: 'auth-retry',
    specId: 'auth-retry',
    specKind: 'feature',
    profile: 'feature',
    state: 'WAITING_APPROVAL',
    view: 'gate',
    currentPhase: 'REVIEW',
    resumeTo: 'REVIEW',
    since: requestedAt,
    startedAt: start,
    iteration: { fixRounds: 0, maxFixRounds: 3, reviewRounds: 1 },
    host: { alive: true, heartbeatAt: Date.now() },
    git: { baseBranch: 'main', baseSha: '9c1d2e3', integrationBranch: 'cohorte/auth-retry' },
    runtime: { id: 'Pi', version: '1.4.0', pinDigest: 'sha256:2f19c4be' },
    snapshotDigest: 'sha256:2f19c4be7a01',
    cohorteVersion: '3.4.1',
    unattended: false,
    phases: [
      {
        state: 'SPEC',
        label: 'Spec',
        status: 'completed',
        iteration: 1,
        startedAt: start,
        endedAt: start + 2 * MIN,
        durationMs: 2 * MIN,
        steps: [step('agt_brainstorm', 'brainstorm · 3 personas', '3 personas', start, 48_000), step('agt_specval', 'spec validate · 14 criteria', 'spec-writer', start + 48_000, 72_000)],
        checks: [],
      },
      {
        state: 'BUILD',
        label: 'Build',
        status: 'completed',
        iteration: 1,
        startedAt: start + 2 * MIN,
        endedAt: start + 5 * MIN,
        durationMs: 3 * MIN,
        steps: [
          step('agt_impl_auth', 'implement · auth', 'implementer', start + 2 * MIN, 161_000, API_CWD),
          step('agt_impl_billing', 'implement · billing', 'implementer', start + 2 * MIN + 5_000, 86_000, API_CWD),
          step('agt_tests', 'write tests', 'test-author', start + 3 * MIN, 58_000, AUTH_RETRY_CWD),
        ],
        checks: [{ name: 'npm test', status: 'passed', argv: ['npm', 'test'], exitCode: 0, durationMs: 18_700 }],
      },
      {
        state: 'REVIEW',
        label: 'Review',
        status: 'waiting-approval',
        iteration: 1,
        startedAt: start + 5 * MIN,
        steps: [{ ...step('agt_review', '4 findings · 1 blocking', 'code-reviewer', start + 5 * MIN, 67_000), findings: 4 }],
        checks: [],
      },
      { state: 'FIX', label: 'Fix', status: 'pending', iteration: 0, steps: [], checks: [] },
      { state: 'SHIP', label: 'Ship', status: 'pending', iteration: 0, steps: [], checks: [] },
    ],
    worktrees: [{ slot: 'impl-1', path: AUTH_RETRY_CWD, branch: 'cohorte/auth-retry/impl-1', agentId: 'agt_tests', removed: false }],
    gate: gate(requestedAt),
    review: { phaseRunId: 'phr_review_1', startedAt: start + 5 * MIN, verdict: 'needs-human', findings: f, counts: { critical: 0, major: 1, minor: 2, info: 1 }, blocking: 1, clean: false },
    artifacts: [
      { kind: 'spec', label: 'spec/auth-retry.md', meta: 'frozen · 14 criteria' },
      { kind: 'diff', label: 'diff · 7 files', meta: '+97 −31' },
      { kind: 'report', label: 'report.json', meta: 'review output' },
    ],
    usage: { tokens: { input: 812_000, output: 64_000, cacheRead: 540_000, cacheWrite: 21_000, total: 876_000 }, cost: null },
    lastSequence: 214,
    tailTruncated: false,
    refreshedAt: Date.now(),
  };
}

/** The run once the gate was answered: approve → shipping, fix → fixing, deny+cancel → cancelled. */
export function demoRunAfter(run: CohorteRun, action: 'approve' | 'fix' | 'deny'): CohorteRun {
  const now = Date.now();
  const phases = run.phases.map((p) => {
    if (p.state === 'REVIEW') return { ...p, status: 'completed', endedAt: now, durationMs: now - (p.startedAt ?? now) };
    if (action === 'approve' && p.state === 'SHIP') return { ...p, status: 'running', iteration: 1, startedAt: now };
    if (action === 'fix' && p.state === 'FIX') return { ...p, status: 'running', iteration: 1, startedAt: now };
    return p;
  });
  if (action === 'deny') {
    return { ...run, gate: null, view: 'cancelled', state: 'CANCELLED', endedAt: now, since: now, phases: run.phases.map((p) => (p.status === 'pending' || p.status === 'waiting-approval' ? { ...p, status: 'cancelled' } : p)) };
  }
  const next = action === 'approve' ? 'SHIP' : 'FIX';
  return { ...run, gate: null, view: 'running', state: next, currentPhase: next, since: now, phases };
}

export function demoOutcome(run: CohorteRun, action: 'approve' | 'fix' | 'deny'): CohorteCommandOutcome {
  const cli = run.gate?.actions.find((a) => a.id === action)?.cli ?? [];
  return {
    runId: run.runId,
    run,
    steps: cli.map((line, i) =>
      action === 'fix' && i === 1
        ? { cli: line, outcome: 'skipped', exitCode: 0, message: 'Cohorte routes the findings after the denial' }
        : { cli: line, outcome: 'completed', exitCode: 0 },
    ),
  };
}

export function demoRunLog(run: CohorteRun): CohorteLogEntry[] {
  const base = run.startedAt;
  const rows: [string, string, string, number][] = [
    ['pipeline.started', 'info', 'Run auth-retry started (feature profile, Pi runtime pinned)', 0],
    ['phase.started', 'info', 'Phase SPEC started', 1_000],
    ['agent.completed', 'success', 'brainstorm · 3 personas finished', 48_000],
    ['phase.completed', 'success', 'Phase SPEC passed', 120_000],
    ['phase.started', 'info', 'Phase BUILD started · 3 agents planned', 121_000],
    ['tool.completed', 'info', 'Edit services/auth/callback.ts (+41 −12)', 190_000],
    ['runtime.warning', 'warning', 'Model rate limited, retrying in 4s', 220_000],
    ['check.completed', 'success', 'npm test passed · 18.7s', 290_000],
    ['phase.completed', 'success', 'Phase BUILD passed', 300_000],
    ['review.started', 'info', 'Review started · 1 reviewer', 301_000],
    ['review.finding', 'warning', 'blocking: Retry count is hardcoded in two services', 340_000],
    ['review.completed', 'info', 'Review: 4 findings, 1 blocking', 368_000],
    ['approval.requested', 'warning', 'Gate review-leftovers: waiting for a human verdict', 370_000],
    ['x.experimental.metric', 'info', 'An event this build does not know', 371_000],
  ];
  return rows.map(([type, severity, summary, offset], i) => ({ runId: run.runId, sequence: i + 1, sub: 0, at: base + offset, type, severity, summary }));
}

/** orbit-api's transcript: the Cohorte turn of frame 25 (three tool rows). */
export function demoCohorteTranscript(): ConversationBlock[] {
  const at = (m: number) => T0 - m * MIN;
  const tool = (id: string, summary: string, meta: string, m: number): ConversationBlock => ({
    kind: 'tool',
    blockId: id,
    at: at(m),
    isStreaming: false,
    tool: 'Bash',
    glyph: '●',
    glyphColor: '#8b93a3',
    bodyColor: '#8b93a3',
    summary,
    meta,
  });
  return [
    { kind: 'user', blockId: 'coh-u1', at: at(9), isStreaming: false, text: 'Run the auth-retry feature through Cohorte — brainstorm is done, the spec is frozen.' },
    {
      kind: 'assistant',
      blockId: 'coh-a1',
      at: at(8.5),
      isStreaming: false,
      glyph: '●',
      glyphColor: '#8b93a3',
      bodyColor: '#c3c9d4',
      text: 'Cohorte started `run_7fa3c1` from the frozen spec. Build finished with 3 implementer steps; the review agent reported back.',
    },
    tool('coh-t1', 'cohorte spec freeze auth-retry', '14 criteria', 8.4),
    tool('coh-t2', 'cohorte run auth-retry --detach', `started ${DEMO_RUN_ID}`, 8.3),
    tool('coh-t3', `cohorte review ${DEMO_RUN_ID.slice(0, 10)}`, '4 findings · 1 blocking', 4.2),
    {
      kind: 'assistant',
      blockId: 'coh-a2',
      at: at(4),
      isStreaming: false,
      glyph: '●',
      glyphColor: '#8b93a3',
      bodyColor: '#c3c9d4',
      text: 'The run is paused at this gate. Approving ships the branch; sending it to fix starts a `cohorte fix` step with these findings.',
    },
  ];
}
