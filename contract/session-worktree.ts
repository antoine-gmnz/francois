// contract/session-worktree.ts — session-worktree feature contract.
// Binding per PIPELINE.md: francois:session:<verb> -> invoke('session_<verb>') -> Promise<Result<T>>.

import type { Result, SessionId, SessionMeta, SessionWorktree } from './common';
import { isPathInside } from './projects';

// ---------- francois:session:worktreeProbe ----------
export interface WorktreeProbeRequest {
  cwd: string; // absolute; the candidate session cwd
  branch?: string; // when present, branchExists / branchCheckedOutAt are filled for it
}
export interface WorktreeProbeData {
  isRepo: boolean; // false => every other field is null/false; NOT an error
  repoRoot: string | null; // host dialect (FR-10)
  defaultBranch: string | null; // origin/HEAD -> else the repo's init.defaultBranch -> else 'main'
  currentBranch: string | null; // null on detached HEAD
  remote: string | null; // 'origin' when present, else the first remote, else null
  branchExists: boolean; // request.branch resolves to a local branch
  branchCheckedOutAt: string | null; // path of the worktree holding it (FR-5); null when free
  worktreePath: string | null; // FR-9 for request.branch; null when branch is absent
  /** attach-to-worktree FR-1/FR-2: linked worktrees of this repo, main checkout and bare entries
   *  excluded, git's own order (frontend does not re-sort). [] when isRepo is false or
   *  `git worktree list` failed — never absent, never an error (FR-4). */
  worktrees: WorktreeListEntry[];
}
// invoke('session_worktree_probe', req): Promise<Result<WorktreeProbeData>>
// errors: 'INVALID_INPUT' (cwd not absolute / not a directory) | 'GIT_ERROR' | 'INTERNAL'
// A non-repo cwd resolves ok:true with isRepo:false — never NOT_A_GIT_REPO.

/** attach-to-worktree FR-1/FR-3: one linked worktree of the probed repo, from
 *  `git worktree list --porcelain`. */
export interface WorktreeListEntry {
  path: string; // absolute, host dialect (FR-10)
  branch: string | null; // null on detached HEAD
  head: string | null; // full sha; null when git reports none (unborn HEAD)
  detached: boolean;
  locked: boolean;
  prunable: boolean; // the directory is gone; FR-11 disables the row
}

// ---------- extends francois:session:create ----------
/** Added to SessionCreateInput (contract/session-engine.ts) as `worktree?: WorktreeCreateOptions`. */
export interface WorktreeCreateOptions {
  branch: string; // non-empty after trim; must pass `git check-ref-format --branch` (FR-3)
  baseRef: string; // ignored when the branch already exists or adopt is true (FR-8)
  /** true => adopt the existing worktree at `cwd`; no prune, no fetch, no add (FR-5/FR-12). */
  adopt?: boolean;
}
// invoke('session_create', { ...SessionCreateInput, worktree }): Promise<Result<SessionMeta>>
//   resolved SessionMeta.worktree is present on success.
// attach-to-worktree FR-14: `branch`/`baseRef` stay REQUIRED on the wire and are IGNORED under
//   `adopt` — the frontend sends '' for both when attaching to a WorktreeListEntry.path as `cwd`;
//   the core fills provenance from `git worktree list`, including a detached HEAD (FR-15, no
//   longer an error — `branch` becomes the 7-char short sha, `detached: true`).
// added errors: 'NOT_A_GIT_REPO' | 'INVALID_INPUT' | 'WORKTREE_BRANCH_IN_USE' |
//               'WORKTREE_CREATE_FAILED' | 'GIT_ERROR' |
//               'WORKTREE_NOT_FOUND' (adopt only, FR-15: the directory no longer exists — which
//               subsumes a `prunable` entry, since git cannot list from a gone directory;
//               'INVALID_INPUT' covers the case where no `git worktree list` entry matches `cwd`)

// ---------- francois:session:worktreeStatus ----------
export interface WorktreeStatusRequest {
  sessionId: SessionId;
}
export interface WorktreeStatusData {
  dirty: boolean;
  dirtyCount: number; // changed + untracked entries (0 when clean)
  unpushed: boolean;
  unpushedCount: number; // commits ahead of upstream, or ahead of baseRef when no upstream (FR-18)
  // Sentinel: `unpushed: true` with `unpushedCount: 0` means push status could NOT be determined
  // (no upstream and no reliable baseRef). Removal still hard-blocks (FR-19), but every reason
  // string must say "push status unknown", never "0 commits".
  upstream: string | null; // e.g. 'origin/feat/x'; null when the branch has none
}
// invoke('session_worktree_status', req): Promise<Result<WorktreeStatusData>>
// errors: 'SESSION_NOT_FOUND' | 'WORKTREE_NOT_FOUND' (session has no worktree, or the path is gone)
//       | 'GIT_ERROR' | 'INTERNAL'

// ---------- francois:session:worktreeRemove ----------
export interface WorktreeRemoveRequest {
  sessionId: SessionId;
}
// invoke('session_worktree_remove', req): Promise<Result<null>>
//   Runs `git worktree remove <path>` then `git worktree prune`. NEVER --force, NEVER deletes the
//   branch. Re-checks FR-18 server-side and refuses with WORKTREE_DIRTY.
// errors: 'SESSION_NOT_FOUND' | 'WORKTREE_NOT_FOUND' | 'WORKTREE_DIRTY' | 'GIT_ERROR' | 'INTERNAL'

// ---------- pure frontend helpers (owned here, unit-tested) ----------

/** FR-9, frontend side — must match the core byte-for-byte (both are tested against the same table). */
export function worktreeSlug(branch: string): string {
  let slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 60) slug = slug.slice(0, 60).replace(/-+$/g, '');
  // A branch that is entirely outside [a-z0-9._-] (e.g. CJK) collapses to nothing; without a
  // placeholder the worktree would land on the parent directory itself instead of a child.
  return slug === '' ? WORKTREE_SLUG_FALLBACK : slug;
}

/** FR-9 placeholder for a branch whose slug collapses to the empty string. */
export const WORKTREE_SLUG_FALLBACK = 'branch';

/** FR-9 preview path. `repoRoot` in the host dialect; separator inferred from it. */
export function previewWorktreePath(repoRoot: string, branch: string): string {
  const sep = repoRoot.includes('\\') && !repoRoot.includes('/') ? '\\' : '/';
  const trimmed = repoRoot.endsWith(sep) ? repoRoot.slice(0, -1) : repoRoot;
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const dirname = lastSep >= 0 ? trimmed.slice(0, lastSep) : trimmed;
  const basename = lastSep >= 0 ? trimmed.slice(lastSep + 1) : trimmed;
  const slug = worktreeSlug(branch);
  return [dirname, '.francois-worktrees', basename, slug].join(sep);
}

/**
 * FR-15. Sessions whose `worktree.sourceRepoRoot` contains `session.cwd` — i.e. the worktree
 * sessions spawned from the repo this main-checkout session sits in. Returns [] when `session`
 * itself has a `worktree`. Uses projects' `isPathInside` for normalization.
 */
export function siblingWorktreeSessions(
  session: SessionMeta,
  all: SessionMeta[],
  caseInsensitive: boolean,
): SessionMeta[] {
  if (session.worktree) return [];
  return all.filter(
    (s) => s.worktree && isPathInside(session.cwd, s.worktree.sourceRepoRoot, caseInsensitive),
  );
}

/** localStorage key for FR-14 dismissals; value is a JSON array of SessionId. */
export const WORKTREE_NOTICE_STORAGE_KEY = 'francois.worktreeNoticeDismissed';
