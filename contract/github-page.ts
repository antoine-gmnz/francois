// contract/github-page.ts — github-page (app-bar "GitHub" view: Pull requests ·
// Commits · Branches & worktrees). Authored from specs/github-page.md and the
// Figma frames 29 `160:15836`, 30 `161:15989`, 31 `162:16108`.
// Imports shared vocabulary from common.ts; never redefines it.
//
// Physical Tauri binding: `francois:github:<verb>` → command `github_<snake_verb>`.
// No event stream: every tab is request/response, refreshed by the frontend.
//
// Data sources (core): local git via `diff::git::git_routed` (WSL-aware), and the
// GitHub CLI `gh` (same host routing) for pull requests, reviews and checks.
// `gh` is optional — every git-only call works without it, and `gh`-backed calls
// fail with `GH_UNAVAILABLE` (not installed / not authenticated / not a GitHub
// remote) so the UI can render an explanation instead of an error.
//
// Session linkage (which session wrote a branch / commit) is NOT computed here:
// the frontend joins on `SessionMeta.worktree.branch` (src/features/github/linkage.ts).

import type { FileDiff } from './diff-view';
import type { Result } from './common';

// ---------- shared ----------

/** Every call is scoped by a directory inside the repo (project root or a session cwd). */
export interface GithubScope {
  cwd: string;
}

/** Why the `gh`-backed half is unavailable. `ok` ⇒ PR data can be fetched. */
export type GhStatus = 'ok' | 'missing' | 'unauthenticated' | 'not-github';

export interface AheadBehind {
  ahead: number;
  behind: number;
}

// ---------- francois:github:repoInfo → github_repo_info ----------

export interface GithubRepoInfo {
  root: string; // absolute repo root (main worktree), host dialect
  /** `owner` / `name` parsed from the remote URL; `name` falls back to basename(root). */
  owner?: string;
  name: string;
  remoteName?: string; // 'origin' preferred; absent when the repo has no remote
  remoteHost?: string; // e.g. 'github.com'
  /** https URL of the repo on the web, when the remote is a GitHub host. */
  webUrl?: string;
  defaultBranch: string; // e.g. 'main'
  currentBranch?: string; // absent on a detached HEAD
  /** current branch vs its upstream; null when it has no upstream. */
  upstream: AheadBehind | null;
  lastFetchedAt?: number; // epoch ms — mtime of FETCH_HEAD; absent if never fetched
  gh: GhStatus;
}
export type GithubRepoInfoResponse = Result<GithubRepoInfo>;

// ---------- francois:github:fetch → github_fetch ----------
// `git fetch --prune <remote>` with a timeout. Resolves to the refreshed repo info.
export type GithubFetchResponse = Result<GithubRepoInfo>;

// ---------- checks ----------

export type CheckState = 'passed' | 'failed' | 'pending' | 'skipped';

export interface CheckRun {
  name: string; // e.g. 'unit tests'
  state: CheckState;
  durationMs?: number; // completedAt − startedAt when both are known
  /** short failure summary when GitHub gives one (e.g. '3 tests failed'). */
  summary?: string;
  detailsUrl?: string;
}

export interface CheckRollup {
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

// ---------- francois:github:listPulls → github_list_pulls ----------

export type PullState = 'open' | 'draft' | 'merged' | 'closed';
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | 'none';

export interface PullSummary {
  number: number;
  title: string;
  head: string; // head branch name
  base: string; // base branch name
  state: PullState;
  author: string; // login
  authorIsViewer: boolean;
  createdAt: number;
  updatedAt: number;
  mergedAt?: number;
  mergedBy?: string; // login
  mergedByViewer?: boolean;
  checks: CheckRollup;
  review: ReviewDecision;
  /** reviews whose latest state is CHANGES_REQUESTED. */
  changesRequested: number;
  url: string;
}

export interface GithubListPullsRequest extends GithubScope {
  /** default 30; the core clamps to 1..100. Open + recently merged/closed, newest first. */
  limit?: number;
}
export type GithubListPullsResponse = Result<PullSummary[]>;

// ---------- francois:github:getPull → github_get_pull ----------

export interface PullFile {
  path: string;
  additions: number;
  deletions: number;
  /** unresolved review comments anchored on this file. */
  comments: number;
}

export interface ReviewComment {
  author: string;
  path?: string; // absent for a top-level review body
  line?: number;
  body: string; // plain markdown text
  createdAt: number;
  url: string;
}

export interface PullDetail extends PullSummary {
  additions: number;
  deletions: number;
  files: PullFile[]; // sorted by (additions + deletions) desc
  checkRuns: CheckRun[];
  /** unresolved inline review comments + CHANGES_REQUESTED review bodies, newest first. */
  comments: ReviewComment[];
  reviewers: string[]; // logins; the viewer is reported as 'you'
  labels: string[];
  milestone?: string;
  headSha: string; // 7-char short sha
  /** GitHub's mergeability, flattened. */
  mergeable: 'clean' | 'blocked' | 'conflicting' | 'behind' | 'unknown';
  /** the repo's allowed merge methods, in preference order (squash · merge · rebase).
   *  Falls back to all three when the repo settings can't be read. */
  mergeMethods: MergeMethod[];
  /** head lives in a fork — its branch can't be deleted from this repo. */
  crossRepository: boolean;
}

export interface GithubGetPullRequest extends GithubScope {
  number: number;
}
export type GithubGetPullResponse = Result<PullDetail>;

// ---------- francois:github:updatePullBranch → github_update_pull_branch ----------
// `gh pr update-branch <number>` — merges the base into the head on GitHub.
export type GithubUpdatePullBranchRequest = GithubGetPullRequest;
export type GithubUpdatePullBranchResponse = Result<null>;

// ---------- francois:github:mergePull → github_merge_pull ----------
// `gh pr merge <number> --<method>` — the one irreversible action on the page,
// behind an in-app confirm (FR-5a). Only the remote head branch is ever deleted,
// and only on request, never for a fork's head or the base branch; local
// branches and worktrees are left to the Branches tab's prune.

export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface GithubMergePullRequest extends GithubGetPullRequest {
  method: MergeMethod;
  /** delete the head branch on GitHub once the merge lands. */
  deleteBranch: boolean;
}

export interface MergeOutcome {
  branchDeleted: boolean;
  /** set when the merge landed but the branch delete did not. */
  branchDeleteError?: string;
}
export type GithubMergePullResponse = Result<MergeOutcome>;

// ---------- francois:github:listCommits → github_list_commits ----------

export interface CommitSummary {
  sha: string; // full 40-char
  shortSha: string; // 7-char
  subject: string;
  author: string; // author name
  authorIsViewer: boolean; // author email == `git config user.email`
  committedAt: number; // committer date, epoch ms
  /** a `Co-Authored-By:` trailer names Claude — i.e. an agent wrote it. */
  byAgent: boolean;
}

export interface GithubListCommitsRequest extends GithubScope {
  /** branch / ref to walk; default = repo default branch. */
  ref?: string;
  /** default 50; the core clamps to 1..200. */
  limit?: number;
}

export interface CommitPage {
  ref: string;
  /** `git rev-list --count <ref>` */
  totalCount: number;
  commits: CommitSummary[]; // newest first
}
export type GithubListCommitsResponse = Result<CommitPage>;

// ---------- francois:github:getCommit → github_get_commit ----------

export interface CommitFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface CommitDetail extends CommitSummary {
  body: string; // message body after the subject, trailers included
  parents: string[]; // 7-char short shas
  signed: 'verified' | 'unverified' | 'none'; // from `%G?`
  /** local branches containing the commit (`git branch --contains`), default branch first. */
  branches: string[];
  onDefaultBranch: boolean;
  files: CommitFile[];
  /** parsed diff of `files[0]` (largest change first) — the card shows one file. */
  firstFileDiff?: FileDiff;
  /** GitHub check runs on this sha; absent when gh is unavailable. */
  checkRuns?: CheckRun[];
  /** number of the PR whose head contains this commit, when gh knows one. */
  pullNumber?: number;
}

export interface GithubGetCommitRequest extends GithubScope {
  sha: string;
}
export type GithubGetCommitResponse = Result<CommitDetail>;

// ---------- francois:github:listBranches → github_list_branches ----------

export interface BranchWorktree {
  path: string; // absolute, host dialect
  /** path relative to the main worktree's parent when shorter, e.g. '../orbit-auth-retry';
   *  '~/…' for the main worktree under $HOME. Display-only. */
  displayPath: string;
  isMain: boolean;
  dirty: boolean;
}

export interface BranchInfo {
  name: string;
  isDefault: boolean;
  isCurrent: boolean; // checked out in the main worktree
  /** vs the default branch (`rev-list --left-right --count default...name`). */
  vsDefault: AheadBehind;
  /** merged into the default branch (and not the default branch itself). */
  merged: boolean;
  worktree?: BranchWorktree;
  lastCommit: { shortSha: string; subject: string; committedAt: number };
}

export type GithubListBranchesResponse = Result<BranchInfo[]>; // default first, then committedAt desc

// ---------- francois:github:worktreeDiskUsage → github_worktree_disk_usage ----------
// Bounded walk over every linked + main worktree (2 s budget). null ⇒ budget exceeded.
export type GithubWorktreeDiskUsageResponse = Result<{ bytes: number | null; worktrees: number }>;

// ---------- francois:github:createWorktree → github_create_worktree ----------
// Checks the existing local `branch` out into `<parent-of-root>/<repo-name>-<branch-slug>`.
export interface GithubCreateWorktreeRequest extends GithubScope {
  branch: string;
}
export type GithubCreateWorktreeResponse = Result<BranchWorktree>;

// ---------- francois:github:prune → github_prune ----------
// For each branch: must be merged into default and not the default/current branch.
// Removes its linked worktree (refused when dirty → reported, not forced), then
// `git branch -d`. Never force-deletes, never touches remotes.
export interface GithubPruneRequest extends GithubScope {
  branches: string[];
}
export interface PruneOutcome {
  branch: string;
  removed: boolean;
  reason?: string; // why it was skipped
}
export type GithubPruneResponse = Result<PruneOutcome[]>;

// ---------- francois:github:openUrl → github_open_url ----------
// Opens an https URL in the system browser. The core refuses anything that is not
// `https://` on the repo's remote host (github.com or the GHE host) → INVALID_INPUT.
export interface GithubOpenUrlRequest extends GithubScope {
  url: string;
}
export type GithubOpenUrlResponse = Result<null>;
