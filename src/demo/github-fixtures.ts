// Demo fixtures for github-page, split out of fixtures.ts (file-size cap).
// Same rule as fixtures.ts: only src/demo/ imports this, so it tree-shakes out
// of real builds — keep every export a literal or a function, never a
// module-scope call (scripts/capture/no-demo.test.mjs).

import type { BranchInfo, CommitDetail, CommitSummary, GithubRepoInfo, PullDetail, PullSummary } from '../../contract/github-page';
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
      { name: 'unit tests', state: 'passed', durationMs: 41_000 },
      { name: 'lint', state: 'failed', durationMs: 8_000, summary: '1 error', detailsUrl: 'https://github.com/antoine-gmnz/orbit/actions/runs/128' },
      { name: 'typecheck', state: 'pending' },
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
    checkRuns: [{ name: 'unit tests', state: 'passed', durationMs: 18_000 }],
    pullNumber: pull?.number,
  };
}
