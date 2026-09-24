// Demo fixtures for github-page, split out of fixtures.ts (file-size cap).
// Same rule as fixtures.ts: only src/demo/ imports this, so it tree-shakes out
// of real builds — keep every export a literal or a function, never a
// module-scope call (scripts/capture/no-demo.test.mjs).

import type {
  BranchInfo,
  CheckJob,
  CommitDetail,
  CommitSummary,
  GithubRepoInfo,
  JobStep,
  PullDetail,
  PullSummary,
  StepLog,
} from '../../contract/github-page';
import { fileDiff, T0 } from './fixtures';

const MIN = 60_000;

// ---------- github-page ----------
//
// One repo — antoine-gmnz/orbit, the same repo PROJECT_ORBIT's sessions work
// in — with branches/PRs/commits lifted from the redesign frames (29 PRs
// `160:15836`, 30 Commits `161:15989`, 31 Branches `162:16108`): PR numbers
// #124-#128 and the branch table's ahead/behind, worktree paths and commit
// subjects are the frames' own data; everything else (bodies, reviewers,
// check names) is invented to be internally consistent with it.

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const GITHUB_REPO: GithubRepoInfo = {
  root: '~/code/orbit',
  owner: 'antoine-gmnz',
  name: 'orbit',
  remoteName: 'origin',
  remoteHost: 'github.com',
  webUrl: 'https://github.com/antoine-gmnz/orbit',
  defaultBranch: 'main',
  currentBranch: 'main',
  upstream: { ahead: 0, behind: 0 },
  lastFetchedAt: T0 - 2 * MIN,
  gh: 'ok',
};

export const GITHUB_BRANCHES: BranchInfo[] = [
  {
    name: 'main',
    isDefault: true,
    isCurrent: true,
    vsDefault: { ahead: 0, behind: 0 },
    merged: false,
    worktree: { path: '~/code/orbit', displayPath: '~/code/orbit', isMain: true, dirty: false },
    lastCommit: { shortSha: 'a1b2c3d', subject: 'Ship: bump Pi runtime to 0.9.2', committedAt: T0 - 1 * DAY },
  },
  {
    name: 'auth-retry',
    isDefault: false,
    isCurrent: false,
    vsDefault: { ahead: 2, behind: 1 },
    merged: false,
    worktree: { path: '~/code/orbit-auth-retry', displayPath: '../orbit-auth-retry', isMain: false, dirty: true },
    lastCommit: { shortSha: '9c41ea2', subject: 'Cap the auth backoff window at 30 s', committedAt: T0 - 2 * HOUR },
  },
  {
    name: 'rate-limit',
    isDefault: false,
    isCurrent: false,
    vsDefault: { ahead: 4, behind: 0 },
    merged: false,
    worktree: { path: '~/code/orbit-rate-limit', displayPath: '../orbit-rate-limit', isMain: false, dirty: true },
    lastCommit: { shortSha: '7fd90b1', subject: 'Extract the rate limiter into its own module', committedAt: T0 - 5 * HOUR },
  },
  {
    name: 'docs-worktree',
    isDefault: false,
    isCurrent: false,
    vsDefault: { ahead: 1, behind: 3 },
    merged: false,
    lastCommit: { shortSha: '2ab6e14', subject: 'Document the worktree flow', committedAt: T0 - 2 * DAY },
  },
  {
    name: 'pi-0.9.2',
    isDefault: false,
    isCurrent: false,
    vsDefault: { ahead: 0, behind: 6 },
    merged: true,
    lastCommit: { shortSha: 'f30cd88', subject: 'Bump Pi runtime to 0.9.2', committedAt: T0 - 3 * DAY },
  },
  {
    name: 'fix-restore-test',
    isDefault: false,
    isCurrent: false,
    vsDefault: { ahead: 0, behind: 9 },
    merged: true,
    lastCommit: { shortSha: '61e0a4c', subject: 'Fix flaky session restore test', committedAt: T0 - 4 * DAY },
  },
  {
    name: 'spike/streaming',
    isDefault: false,
    isCurrent: false,
    vsDefault: { ahead: 7, behind: 22 },
    merged: false,
    lastCommit: { shortSha: 'd402f7e', subject: 'Try a streaming transcript reader', committedAt: T0 - 21 * DAY },
  },
];

export const GITHUB_PULLS: PullSummary[] = [
  {
    number: 128,
    title: 'Cap the auth backoff window at 30 s',
    head: 'auth-retry',
    base: 'main',
    state: 'open',
    author: 'you',
    authorIsViewer: true,
    createdAt: T0 - 6 * HOUR,
    updatedAt: T0 - 2 * HOUR,
    checks: { total: 3, passed: 1, failed: 1, pending: 1 },
    review: 'changes_requested',
    changesRequested: 1,
    url: 'https://github.com/antoine-gmnz/orbit/pull/128',
  },
  {
    number: 127,
    title: 'Extract the rate limiter into its own module',
    head: 'rate-limit',
    base: 'main',
    state: 'open',
    author: 'you',
    authorIsViewer: true,
    createdAt: T0 - 10 * HOUR,
    updatedAt: T0 - 5 * HOUR,
    checks: { total: 2, passed: 2, failed: 0, pending: 0 },
    review: 'approved',
    changesRequested: 0,
    url: 'https://github.com/antoine-gmnz/orbit/pull/127',
  },
  {
    number: 126,
    title: 'Document the worktree flow',
    head: 'docs-worktree',
    base: 'main',
    state: 'open',
    author: 'you',
    authorIsViewer: true,
    createdAt: T0 - 3 * DAY,
    updatedAt: T0 - 2 * DAY,
    checks: { total: 1, passed: 0, failed: 0, pending: 1 },
    review: 'review_required',
    changesRequested: 0,
    url: 'https://github.com/antoine-gmnz/orbit/pull/126',
  },
  {
    number: 125,
    title: 'Bump Pi runtime to 0.9.2',
    head: 'pi-0.9.2',
    base: 'main',
    state: 'merged',
    author: 'you',
    authorIsViewer: true,
    createdAt: T0 - 4 * DAY,
    updatedAt: T0 - 3 * DAY,
    mergedAt: T0 - 3 * DAY,
    mergedBy: 'you',
    mergedByViewer: true,
    checks: { total: 2, passed: 2, failed: 0, pending: 0 },
    review: 'approved',
    changesRequested: 0,
    url: 'https://github.com/antoine-gmnz/orbit/pull/125',
  },
  {
    number: 124,
    title: 'Fix flaky session restore test',
    head: 'fix-restore-test',
    base: 'main',
    state: 'merged',
    author: 'you',
    authorIsViewer: true,
    createdAt: T0 - 5 * DAY,
    updatedAt: T0 - 4 * DAY,
    mergedAt: T0 - 4 * DAY,
    mergedBy: 'you',
    mergedByViewer: true,
    checks: { total: 2, passed: 2, failed: 0, pending: 0 },
    review: 'approved',
    changesRequested: 0,
    url: 'https://github.com/antoine-gmnz/orbit/pull/124',
  },
];

const PULL_DETAIL_EXTRA: Record<number, Omit<PullDetail, keyof PullSummary | 'mergeMethods' | 'crossRepository'>> = {
  128: {
    additions: 34,
    deletions: 9,
    files: [
      { path: 'src/auth/retry.ts', additions: 21, deletions: 6, comments: 1 },
      { path: 'src/auth/retry.test.ts', additions: 13, deletions: 3, comments: 0 },
    ],
    checkRuns: [
      { name: 'unit tests', state: 'passed', durationMs: 41_000, jobId: 5101, runId: 9200, startedAt: T0 - 8 * MIN },
      {
        name: 'lint',
        state: 'failed',
        durationMs: 8_000,
        summary: '1 error',
        detailsUrl: 'https://github.com/antoine-gmnz/orbit/actions/runs/9200/job/5102',
        jobId: 5102,
        runId: 9200,
        startedAt: T0 - 8 * MIN,
      },
      { name: 'typecheck', state: 'pending', jobId: 5103, runId: 9200, startedAt: T0 - 90_000 },
      { name: 'preview', state: 'pending', detailsUrl: 'https://vercel.com/antoine-gmnz/orbit/preview' },
    ],
    comments: [
      {
        author: 'antoine-gmnz',
        path: 'src/auth/retry.ts',
        line: 42,
        body: 'Should this cap read from config instead of a literal 30?',
        createdAt: T0 - 90 * MIN,
        url: 'https://github.com/antoine-gmnz/orbit/pull/128#discussion_r1',
      },
    ],
    reviewers: ['antoine-gmnz'],
    labels: ['auth'],
    headSha: '9c41ea2',
    headOid: '9c41ea2'.padEnd(40, '0'),
    body: [
      '<!-- Thanks for the PR! Describe what changed and why. -->',
      '## Why',
      '',
      'A flapping auth server pushed the retry loop past **4 minutes** of backoff, and the session looked hung. This caps the window at 30 s.',
      '',
      '## What changed',
      '',
      '- `nextDelay()` clamps to `MAX_BACKOFF_MS` (30 000)',
      '- jitter stays proportional, so the cap never synchronises clients',
      '- new tests for the clamp and the jitter bounds',
      '',
      '## Test plan',
      '',
      '1. `npm test -- retry`',
      '2. Point the app at a stub that always returns 503 and watch the retry log',
      '',
      'Follow-up to [#119](https://github.com/antoine-gmnz/orbit/pull/119). The cap could read from config later — see the review thread.',
    ].join('\n'),
    mergeable: 'blocked',
  },
  127: {
    additions: 58,
    deletions: 12,
    files: [{ path: 'src/http/rate-limiter.ts', additions: 58, deletions: 12, comments: 0 }],
    checkRuns: [
      { name: 'unit tests', state: 'passed', durationMs: 22_000 },
      { name: 'lint', state: 'passed', durationMs: 5_000 },
    ],
    comments: [],
    reviewers: ['antoine-gmnz'],
    labels: [],
    headSha: '7fd90b1',
    headOid: '7fd90b1'.padEnd(40, '0'),
    body: 'Moves the token bucket out of `http/client.ts` into `http/rate-limiter.ts` so the websocket path can share it. No behaviour change.',
    mergeable: 'clean',
  },
  126: {
    additions: 44,
    deletions: 2,
    files: [{ path: 'docs/worktrees.md', additions: 44, deletions: 2, comments: 0 }],
    checkRuns: [{ name: 'lint', state: 'pending' }],
    comments: [],
    reviewers: [],
    labels: ['docs'],
    headSha: '2ab6e14',
    headOid: '2ab6e14'.padEnd(40, '0'),
    body: '',
    mergeable: 'behind',
  },
  125: {
    additions: 6,
    deletions: 6,
    files: [
      { path: 'src-tauri/Cargo.toml', additions: 3, deletions: 3, comments: 0 },
      { path: 'package.json', additions: 3, deletions: 3, comments: 0 },
    ],
    checkRuns: [
      { name: 'unit tests', state: 'passed', durationMs: 39_000 },
      { name: 'lint', state: 'passed', durationMs: 6_000 },
    ],
    comments: [],
    reviewers: ['antoine-gmnz'],
    labels: [],
    headSha: 'f30cd88',
    headOid: 'f30cd88'.padEnd(40, '0'),
    body: 'Routine bump of the Pi runtime. Release notes: https://github.com/pi/runtime/releases/tag/v0.9.2',
    mergeable: 'clean',
  },
  124: {
    additions: 11,
    deletions: 4,
    files: [{ path: 'src-tauri/src/session/mod.rs', additions: 11, deletions: 4, comments: 0 }],
    checkRuns: [
      { name: 'unit tests', state: 'passed', durationMs: 51_000 },
      { name: 'lint', state: 'passed', durationMs: 6_000 },
    ],
    comments: [],
    reviewers: ['antoine-gmnz'],
    labels: [],
    headSha: '61e0a4c',
    headOid: '61e0a4c'.padEnd(40, '0'),
    body: ['The restore test raced the autosave timer.', '', 'Now it awaits `flushPending()` before asserting, which removes the 1-in-20 failure.'].join('\n'),
    mergeable: 'clean',
  },
};

export const GITHUB_PULL_DETAILS: Record<number, PullDetail> = Object.fromEntries(
  GITHUB_PULLS.map((p) => [
    p.number,
    { ...p, ...PULL_DETAIL_EXTRA[p.number], mergeMethods: ['squash', 'merge', 'rebase'], crossRepository: false },
  ]),
);

/** One commit list per interesting ref; every other branch/ref falls back to
 *  a single-commit list built from GITHUB_BRANCHES' own lastCommit. */
export const GITHUB_COMMITS: Record<string, CommitSummary[]> = {
  main: [
    {
      sha: 'a1b2c3d'.padEnd(40, '0'),
      shortSha: 'a1b2c3d',
      subject: 'Ship: bump Pi runtime to 0.9.2',
      author: 'you',
      authorIsViewer: true,
      committedAt: T0 - 1 * DAY,
      byAgent: false,
    },
    {
      sha: 'f30cd88'.padEnd(40, '0'),
      shortSha: 'f30cd88',
      subject: 'Bump Pi runtime to 0.9.2',
      author: 'you',
      authorIsViewer: true,
      committedAt: T0 - 3 * DAY,
      byAgent: true,
    },
    {
      sha: '61e0a4c'.padEnd(40, '0'),
      shortSha: '61e0a4c',
      subject: 'Fix flaky session restore test',
      author: 'you',
      authorIsViewer: true,
      committedAt: T0 - 4 * DAY,
      byAgent: true,
    },
    {
      sha: '2ab6e14'.padEnd(40, '0'),
      shortSha: '2ab6e14',
      subject: 'Document the worktree flow',
      author: 'antoine-gmnz',
      authorIsViewer: false,
      committedAt: T0 - 2 * DAY,
      byAgent: false,
    },
  ],
  'auth-retry': [
    {
      sha: '9c41ea2'.padEnd(40, '0'),
      shortSha: '9c41ea2',
      subject: 'Cap the auth backoff window at 30 s',
      author: 'you',
      authorIsViewer: true,
      committedAt: T0 - 2 * HOUR,
      byAgent: true,
    },
    {
      sha: '5e08a3f'.padEnd(40, '0'),
      shortSha: '5e08a3f',
      subject: 'Retry the token exchange with the captured state',
      author: 'you',
      authorIsViewer: true,
      committedAt: T0 - 3 * HOUR,
      byAgent: true,
    },
  ],
  'rate-limit': [
    {
      sha: '7fd90b1'.padEnd(40, '0'),
      shortSha: '7fd90b1',
      subject: 'Extract the rate limiter into its own module',
      author: 'you',
      authorIsViewer: true,
      committedAt: T0 - 5 * HOUR,
      byAgent: true,
    },
    {
      sha: 'c118d4a'.padEnd(40, '0'),
      shortSha: 'c118d4a',
      subject: 'Add a sliding-window test for burst traffic',
      author: 'you',
      authorIsViewer: true,
      committedAt: T0 - 6 * HOUR,
      byAgent: true,
    },
    {
      sha: 'b4e93a0'.padEnd(40, '0'),
      shortSha: 'b4e93a0',
      subject: 'Draft the token-bucket limiter',
      author: 'you',
      authorIsViewer: true,
      committedAt: T0 - 8 * HOUR,
      byAgent: true,
    },
  ],
};

function fallbackCommits(ref: string): CommitSummary[] {
  const branch = GITHUB_BRANCHES.find((b) => b.name === ref);
  if (!branch) return [];
  return [
    {
      sha: branch.lastCommit.shortSha.padEnd(40, '0'),
      shortSha: branch.lastCommit.shortSha,
      subject: branch.lastCommit.subject,
      author: 'you',
      authorIsViewer: true,
      committedAt: branch.lastCommit.committedAt,
      byAgent: false,
    },
  ];
}

export function githubCommitsForRef(ref: string): CommitSummary[] {
  return GITHUB_COMMITS[ref] ?? fallbackCommits(ref);
}

// A function, not a top-level array: a module-scope call chain is a side effect
// to the bundler, which would keep these fixtures in the production build
// (scripts/capture/no-demo.test.mjs).
function allCommits(): CommitSummary[] {
  return [
    ...GITHUB_COMMITS.main,
    ...GITHUB_COMMITS['auth-retry'],
    ...GITHUB_COMMITS['rate-limit'],
    ...GITHUB_BRANCHES.filter((b) => !GITHUB_COMMITS[b.name]).map((b) => fallbackCommits(b.name)[0]),
  ];
}

// ---------- github-ci-logs demo fixtures (FR-17) ----------
// PR #128's three Actions jobs on run 9200: unit tests (passed), lint (failed,
// an error inside a group), typecheck (running — its steps advance one at a
// time on each poll, no timer needed). Plus a non-Actions status ("preview")
// for the no-caret / Open on GitHub case.

const UNIT_TESTS_JOB: CheckJob = {
  jobId: 5101,
  runId: 9200,
  runAttempt: 1,
  name: 'unit tests',
  workflowName: 'CI',
  state: 'passed',
  completed: true,
  startedAt: T0 - 8 * MIN,
  durationMs: 41_000,
  steps: [
    { number: 1, name: 'Set up job', state: 'passed', durationMs: 2_000 },
    { number: 2, name: 'Checkout', state: 'passed', durationMs: 1_000 },
    { number: 3, name: 'Install dependencies', state: 'passed', durationMs: 9_000 },
    { number: 4, name: 'Run tests', state: 'passed', durationMs: 29_000 },
  ],
  htmlUrl: 'https://github.com/antoine-gmnz/orbit/actions/runs/9200/job/5101',
};

const LINT_JOB: CheckJob = {
  jobId: 5102,
  runId: 9200,
  runAttempt: 1,
  name: 'lint',
  workflowName: 'CI',
  state: 'failed',
  completed: true,
  startedAt: T0 - 8 * MIN,
  durationMs: 8_000,
  steps: [
    { number: 1, name: 'Set up job', state: 'passed', durationMs: 1_000 },
    { number: 2, name: 'Checkout', state: 'passed', durationMs: 500 },
    { number: 3, name: 'Install dependencies', state: 'passed', durationMs: 4_500 },
    { number: 4, name: 'Run eslint', state: 'failed', durationMs: 2_000 },
  ],
  htmlUrl: 'https://github.com/antoine-gmnz/orbit/actions/runs/9200/job/5102',
};

const TYPECHECK_STEP_NAMES = ['Set up job', 'Checkout', 'Install dependencies', 'Run tsc'];
let typecheckStepIndex = 0;

function typecheckJob(): CheckJob {
  const steps: JobStep[] = TYPECHECK_STEP_NAMES.map((name, i) => {
    if (i < typecheckStepIndex) return { number: i + 1, name, state: 'passed', durationMs: 4_000 };
    if (i === typecheckStepIndex) return { number: i + 1, name, state: 'running', startedAt: Date.now() - 3_000 };
    return { number: i + 1, name, state: 'queued' };
  });
  const completed = typecheckStepIndex >= TYPECHECK_STEP_NAMES.length;
  return {
    jobId: 5103,
    runId: 9200,
    runAttempt: 1,
    name: 'typecheck',
    workflowName: 'CI',
    state: completed ? 'passed' : 'pending',
    completed,
    startedAt: T0 - 90_000,
    durationMs: completed ? 96_000 : undefined,
    steps,
    htmlUrl: 'https://github.com/antoine-gmnz/orbit/actions/runs/9200/job/5103',
  };
}

/** Every read of the running job (getJob or a list-checks poll) advances it
 *  one step, so the demo fleet's "typecheck" walks to completion over a few
 *  polls with no timer. Once done, PR #128's own checkRuns entry updates too. */
function advanceTypecheck(): void {
  if (typecheckStepIndex >= TYPECHECK_STEP_NAMES.length) return;
  typecheckStepIndex += 1;
  if (typecheckStepIndex >= TYPECHECK_STEP_NAMES.length) {
    const check = GITHUB_PULL_DETAILS[128]?.checkRuns.find((c) => c.jobId === 5103);
    if (check) Object.assign(check, { state: 'passed' as const, durationMs: 96_000 });
    const summary = GITHUB_PULLS.find((p) => p.number === 128);
    if (summary) summary.checks = { total: summary.checks.total, passed: summary.checks.passed + 1, failed: summary.checks.failed, pending: summary.checks.pending - 1 };
  }
}

function simpleLog(jobId: number, stepNumber: number, lines: string[]): StepLog {
  return {
    jobId,
    stepNumber,
    lines: lines.map((text, i) => ({ n: i + 1, text, kind: 'plain' as const })),
    totalLines: lines.length,
    droppedLines: 0,
  };
}

const LINT_LOG: StepLog = {
  jobId: 5102,
  stepNumber: 4,
  lines: [
    { n: 1, text: '> eslint .', kind: 'command' },
    { n: 2, text: 'Linting src/', kind: 'groupStart' },
    { n: 3, text: 'src/auth/retry.ts', kind: 'plain' },
    { n: 4, text: '  42:11  error  Unexpected any  @typescript-eslint/no-explicit-any', kind: 'error' },
    { n: 5, text: '', kind: 'plain' },
    { n: 6, text: '', kind: 'groupEnd' },
    { n: 7, text: '✖ 1 problem (1 error, 0 warnings)', kind: 'error' },
  ],
  totalLines: 7,
  droppedLines: 0,
  firstErrorLine: 4,
};

const STEP_LOGS: Record<string, StepLog> = {
  '5101:1': simpleLog(5101, 1, ['Preparing runner', 'Runner image: ubuntu-22.04']),
  '5101:2': simpleLog(5101, 2, ['Cloning into orbit…', 'HEAD is now at 9c41ea2']),
  '5101:3': simpleLog(5101, 3, ['npm ci', 'added 412 packages in 6s']),
  '5101:4': simpleLog(5101, 4, ['> vitest run', '✓ 128 tests passed (38.1s)']),
  '5102:1': simpleLog(5102, 1, ['Preparing runner', 'Runner image: ubuntu-22.04']),
  '5102:2': simpleLog(5102, 2, ['Cloning into orbit…', 'HEAD is now at 9c41ea2']),
  '5102:3': simpleLog(5102, 3, ['npm ci', 'added 412 packages in 4s']),
  '5102:4': LINT_LOG,
  '5103:1': simpleLog(5103, 1, ['Preparing runner', 'Runner image: ubuntu-22.04']),
  '5103:2': simpleLog(5103, 2, ['Cloning into orbit…', 'HEAD is now at 9c41ea2']),
  '5103:3': simpleLog(5103, 3, ['npm ci', 'added 412 packages in 5s']),
  '5103:4': simpleLog(5103, 4, ['> tsc --noEmit', 'No errors found.']),
};

export function githubJobById(jobId: number): CheckJob | undefined {
  if (jobId === 5101) return UNIT_TESTS_JOB;
  if (jobId === 5102) return LINT_JOB;
  if (jobId === 5103) {
    const job = typecheckJob();
    advanceTypecheck();
    return job;
  }
  return undefined;
}

export function githubStepLogFor(jobId: number, stepNumber: number): StepLog | undefined {
  return STEP_LOGS[`${jobId}:${stepNumber}`];
}

/** Checks for a full sha — the PR head (advancing typecheck a step, same as
 *  polling its job would) or a commit's own checkRuns. */
export function githubChecksForSha(sha: string) {
  const pull = Object.values(GITHUB_PULL_DETAILS).find((p) => p.headOid === sha);
  if (pull) {
    advanceTypecheck();
    return pull.checkRuns;
  }
  return githubCommitDetail(sha)?.checkRuns;
}

/** github_rerun_failed demo: puts every failed check on `runId` back to
 *  pending and rewinds the typecheck walk, so FR-13 polling shows it live again. */
export function githubRerunDemo(runId: number): void {
  for (const detail of Object.values(GITHUB_PULL_DETAILS)) {
    for (const check of detail.checkRuns) {
      if (check.runId === runId && check.state === 'failed') Object.assign(check, { state: 'pending' as const, durationMs: undefined, summary: undefined });
    }
  }
  if (runId === 9200) typecheckStepIndex = 0;
}

export function githubCommitDetail(sha: string): CommitDetail | undefined {
  const summary = allCommits().find((c) => c.sha === sha || c.shortSha === sha);
  if (!summary) return undefined;
  const pull = Object.values(GITHUB_PULL_DETAILS).find((p) => p.headSha === summary.shortSha);
  return {
    ...summary,
    body: summary.byAgent ? 'Co-Authored-By: Claude <noreply@anthropic.com>' : '',
    parents: ['0000000'],
    signed: 'none',
    branches: GITHUB_COMMITS.main.some((c) => c.sha === summary.sha)
      ? ['main']
      : [summary.subject.toLowerCase().includes('auth') ? 'auth-retry' : summary.subject.toLowerCase().includes('rate') ? 'rate-limit' : 'main'],
    onDefaultBranch: GITHUB_COMMITS.main.some((c) => c.sha === summary.sha),
    files: [{ path: 'src/auth/retry.ts', additions: 12, deletions: 3 }],
    firstFileDiff: fileDiff('src/auth/retry.ts'),
    checkRuns: [{ name: 'unit tests', state: 'passed', durationMs: 18_000, jobId: 5101, runId: 9200, startedAt: T0 - 8 * MIN }],
    pullNumber: pull?.number,
  };
}
