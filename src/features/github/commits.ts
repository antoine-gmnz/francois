// github-page — Commits tab (specs/github-page.md FR-7..FR-8). Pure logic
// only: day grouping, relative time, origin chip derivation, check glyph.
// Components (CommitsTab.tsx / CommitDetail.tsx) own layout and wiring.

import type { CheckRun, CommitSummary } from '../../../contract/github-page';
import type { SessionMeta } from '../../../contract/common';
import type { IconName } from '../../ui/icons';

// ---------- FR-7: day grouping ----------

const MS_PER_DAY = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayDiff(ts: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ts)) / MS_PER_DAY);
}

/** 'TODAY' / 'YESTERDAY' / a short date, e.g. 'Mar 3' ('Mar 3, 2025' across years). */
export function dayGroupLabel(ts: number, now: number = Date.now()): string {
  const diff = dayDiff(ts, now);
  if (diff === 0) return 'TODAY';
  if (diff === 1) return 'YESTERDAY';
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Date(ts).toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface CommitDayGroup<T> {
  label: string;
  commits: T[];
}

/** Groups (already newest-first) commits by `dayGroupLabel`, preserving order. */
export function groupCommitsByDay<T extends { committedAt: number }>(
  commits: readonly T[],
  now: number = Date.now(),
): CommitDayGroup<T>[] {
  const groups: CommitDayGroup<T>[] = [];
  for (const commit of commits) {
    const label = dayGroupLabel(commit.committedAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.commits.push(commit);
    else groups.push({ label, commits: [commit] });
  }
  return groups;
}

// ---------- FR-7: row time label ----------

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "2 h ago" today, "yesterday HH:MM" yesterday, a date older. */
export function commitTimeLabel(ts: number, now: number = Date.now()): string {
  const diff = dayDiff(ts, now);
  if (diff <= 0) {
    const ms = Math.max(0, now - ts);
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours} h ago`;
  }
  if (diff === 1) return `yesterday ${hhmm(ts)}`;
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Date(ts).toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------- FR-7: "From sessions" filter ----------

export function filterCommits<T extends { byAgent: boolean }>(commits: readonly T[], fromSessionsOnly: boolean): T[] {
  return fromSessionsOnly ? commits.filter((c) => c.byAgent) : [...commits];
}

// ---------- FR-7: origin chip ----------

export type CommitOrigin =
  | { kind: 'session'; sessionName: string }
  | { kind: 'agent' }
  | { kind: 'hand' };

/**
 * Session chip when the browsed ref is a session's branch AND the commit is
 * agent-written; 'agent' (neutral) for an agent commit with no linked session;
 * 'by hand' for anything not agent-written. `linkedSession` is the session
 * bound to the currently browsed ref (src/features/github/linkage.ts), not
 * per-commit — CommitSummary carries no branch.
 */
export function commitOrigin(commit: CommitSummary, linkedSession: SessionMeta | undefined): CommitOrigin {
  if (commit.byAgent && linkedSession) return { kind: 'session', sessionName: linkedSession.name };
  if (commit.byAgent) return { kind: 'agent' };
  return { kind: 'hand' };
}

// ---------- FR-8: check glyph (only known for the fetched/selected commit) ----------

/** null when checks are unknown (gh unavailable, or not yet fetched) or genuinely pending/mixed. */
export function commitChecksIcon(checkRuns: readonly CheckRun[] | undefined): IconName | null {
  if (!checkRuns || checkRuns.length === 0) return null;
  if (checkRuns.some((r) => r.state === 'failed')) return 'x';
  if (checkRuns.every((r) => r.state === 'passed' || r.state === 'skipped')) return 'check';
  return null;
}

export type Tone = 'danger' | 'success' | 'attention' | 'info' | 'faint';

/** Detail header's checks chip: "checks failing" / "checks passed" / "checks pending" / null. */
export function commitChecksChip(checkRuns: readonly CheckRun[] | undefined): { label: string; tone: Tone } | null {
  if (!checkRuns || checkRuns.length === 0) return null;
  if (checkRuns.some((r) => r.state === 'failed')) return { label: 'checks failing', tone: 'danger' };
  if (checkRuns.some((r) => r.state === 'pending')) return { label: 'checks pending', tone: 'faint' };
  return { label: 'checks passed', tone: 'success' };
}

// ---------- FR-8: misc detail helpers ----------

export function commitAuthorLabel(commit: CommitSummary): string {
  return commit.authorIsViewer ? 'you' : commit.author;
}

/** Top file shown in the Diff card; the rest folded into the "other files" strip. */
export function otherCommitFiles<T extends { path: string }>(files: readonly T[]): T[] {
  return files.slice(1);
}
