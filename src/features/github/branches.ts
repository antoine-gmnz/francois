// github-page — Branches & worktrees (FR-9..FR-11): pure filtering, tone and
// label helpers for BranchesTab.tsx. Kept framework-free so the filter/tone
// logic is covered without rendering anything.

import type { SessionMeta, SessionStatus } from '../../../contract/common';
import type { BranchInfo, PullSummary } from '../../../contract/github-page';
import { statusNeedsAttention, statusPulses } from '../../../contract/fleet-board';

// ---------- toolbar filter chips (FR-9) ----------

export type BranchFilter = 'all' | 'worktree' | 'merged' | 'stale';

export const BRANCH_FILTERS: { id: BranchFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'worktree', label: 'With a worktree' },
  { id: 'merged', label: 'Merged' },
  { id: 'stale', label: 'Stale' },
];

/** last commit older than 30 days. */
export const STALE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isStale(branch: BranchInfo, now: number): boolean {
  return now - branch.lastCommit.committedAt > STALE_DAYS * DAY_MS;
}

export function branchMatchesFilter(branch: BranchInfo, filter: BranchFilter, now: number): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'worktree':
      return branch.worktree !== undefined;
    case 'merged':
      return branch.merged;
    case 'stale':
      return isStale(branch, now);
  }
}

/** `query` matches the branch name, case-insensitively, substring anywhere. */
export function branchMatchesQuery(branch: BranchInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || branch.name.toLowerCase().includes(q);
}

export function filterBranches(branches: readonly BranchInfo[], filter: BranchFilter, query: string, now: number): BranchInfo[] {
  return branches.filter((b) => branchMatchesFilter(b, filter, now) && branchMatchesQuery(b, query));
}

// ---------- prune eligibility (FR-11) ----------

/** merged, not the default branch, not the current branch, and no session
 *  attached — the footer's "N branches ready to prune" / the prune modal's
 *  candidate list. Excluding the current branch mirrors the core's own
 *  `prune_one` guard (src-tauri/src/github/branches.rs), which never deletes
 *  it either — offering it up here would just earn a skip reason back. */
export function isReadyToPrune(branch: BranchInfo, sessionsForBranch: readonly SessionMeta[] | undefined): boolean {
  return (
    branch.merged &&
    !branch.isDefault &&
    !branch.isCurrent &&
    (sessionsForBranch === undefined || sessionsForBranch.length === 0)
  );
}

export function readyToPruneBranches(
  branches: readonly BranchInfo[],
  sessionsByBranch: ReadonlyMap<string, SessionMeta[]>,
): BranchInfo[] {
  return branches.filter((b) => isReadyToPrune(b, sessionsByBranch.get(b.name)));
}

// ---------- ahead / behind tone (FR-10) ----------

export type CountTone = 'zero' | 'ahead' | 'behind';

export function aheadTone(ahead: number): CountTone {
  return ahead > 0 ? 'ahead' : 'zero';
}

export function behindTone(behind: number): CountTone {
  return behind > 0 ? 'behind' : 'zero';
}

// ---------- session chip (FR-10) ----------

export type SessionChipTone = 'none' | 'neutral' | 'attention' | 'running';

export interface SessionChipInfo {
  tone: SessionChipTone;
  label: string;
}

/** One session's own tone: attention while parked on the user, running while
 *  a turn is in flight (including 'starting'), neutral otherwise. */
function soloSessionTone(status: SessionStatus): Exclude<SessionChipTone, 'none'> {
  if (statusNeedsAttention(status)) return 'attention';
  if (statusPulses(status)) return 'running';
  return 'neutral';
}

/**
 * FR-10: `—` for no session, the single session's own name tinted by its
 * state for exactly one, `n sessions` (neutral) for more than one — never
 * both a count and a name.
 */
export function sessionChip(sessions: readonly SessionMeta[] | undefined): SessionChipInfo {
  if (!sessions || sessions.length === 0) return { tone: 'none', label: '—' };
  if (sessions.length === 1) return { tone: soloSessionTone(sessions[0].status), label: sessions[0].name };
  return { tone: 'neutral', label: `${sessions.length} sessions` };
}

// ---------- last-commit relative time (FR-10's "Last commit" column) ----------

/**
 * 'yesterday' exactly on day 1, else '<n> h ago' within a day, '<n> days ago'
 * within a week, '<n> weeks ago' beyond — the Figma frame's own phrasing
 * (distinct from fleet-board's compact card format).
 */
export function lastCommitRelative(committedAt: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - committedAt);
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return hours <= 0 ? 'just now' : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
}

// ---------- PULL REQUEST column (FR-10) ----------
// BranchInfo carries no PR linkage (only listPulls does), so the join happens
// here — the frontend's own join, same spirit as linkage.ts's session join.

/** open/draft outrank merged/closed; ties break on the newest `updatedAt`. */
function pullRank(pull: PullSummary): 0 | 1 {
  return pull.state === 'open' || pull.state === 'draft' ? 1 : 0;
}

function betterPull(a: PullSummary, b: PullSummary): PullSummary {
  const ra = pullRank(a);
  const rb = pullRank(b);
  if (ra !== rb) return ra > rb ? a : b;
  return b.updatedAt > a.updatedAt ? b : a;
}

/** The PR for `branchName`, preferring an open/draft one over a merged/closed
 *  one, then the most recently updated. `undefined` when none has this head. */
export function pullForBranch(pulls: readonly PullSummary[], branchName: string): PullSummary | undefined {
  let best: PullSummary | undefined;
  for (const p of pulls) {
    if (p.head !== branchName) continue;
    best = best ? betterPull(best, p) : p;
  }
  return best;
}

/** Every branch's best-matching PR (see `pullForBranch`), keyed by head branch name. */
export function pullsByBranch(pulls: readonly PullSummary[]): Map<string, PullSummary> {
  const out = new Map<string, PullSummary>();
  for (const p of pulls) {
    const existing = out.get(p.head);
    out.set(p.head, existing ? betterPull(existing, p) : p);
  }
  return out;
}
