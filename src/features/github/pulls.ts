// github-page — Pull requests tab (specs/github-page.md FR-4..FR-6). Pure
// logic only: row/detail derivations, filtering, relative time. Components
// (PullsTab.tsx / PullDetail.tsx) own layout and wiring.

import type {
  CheckRollup,
  GhStatus,
  MergeMethod,
  MergeOutcome,
  PullDetail,
  PullState,
  PullSummary,
} from '../../../contract/github-page';
import type { IconName } from '../../ui/icons';

// ---------- FR-4: row state icon ----------

/** The glyph that opens a PR row / the detail header's state chip. */
export function pullStateIcon(state: PullState): IconName {
  switch (state) {
    case 'open':
      return 'flow';
    case 'draft':
      return 'dots';
    case 'merged':
      return 'check';
    case 'closed':
      return 'x';
    default:
      return 'flow';
  }
}

export type Tone = 'danger' | 'success' | 'attention' | 'info' | 'faint';

/** The detail header's "Open/Draft/Merged/Closed" chip. */
export function pullStateChip(state: PullState): { label: string; tone: Tone } {
  switch (state) {
    case 'open':
      return { label: 'Open', tone: 'info' };
    case 'draft':
      return { label: 'Draft', tone: 'faint' };
    case 'merged':
      return { label: 'Merged', tone: 'success' };
    case 'closed':
      return { label: 'Closed', tone: 'danger' };
    default:
      return { label: state, tone: 'faint' };
  }
}

// ---------- FR-4: check rollup chip ----------

/** `n check(s) failing` danger · `checks passed` success · pending neutral · null when no checks. */
export function checkRollupChip(checks: CheckRollup): { label: string; tone: Tone } | null {
  if (checks.total === 0) return null;
  if (checks.failed > 0) return { label: `${checks.failed} check${checks.failed === 1 ? '' : 's'} failing`, tone: 'danger' };
  if (checks.pending > 0) return { label: 'checks pending', tone: 'faint' };
  return { label: 'checks passed', tone: 'success' };
}

/** Detail header's "1 of 4 checks failing" / "checks passed" / "checks pending" wording. */
export function checkRollupHeadline(checks: CheckRollup): { label: string; tone: Tone } | null {
  if (checks.total === 0) return null;
  if (checks.failed > 0) return { label: `${checks.failed} of ${checks.total} checks failing`, tone: 'danger' };
  if (checks.pending > 0) return { label: 'checks pending', tone: 'faint' };
  return { label: 'checks passed', tone: 'success' };
}

// ---------- FR-4: review text ----------

/** `n change(s) requested` attention · `approved · ready to merge` success · `draft` faint ·
 *  `merged by you|<login>` faint · '' (hidden) otherwise. */
export function pullReviewText(pull: PullSummary): { text: string; tone: Tone } | null {
  if (pull.state === 'merged') {
    const who = pull.mergedByViewer ? 'you' : (pull.mergedBy ?? 'someone');
    return { text: `merged by ${who}`, tone: 'faint' };
  }
  if (pull.state === 'draft') return { text: 'draft', tone: 'faint' };
  if (pull.changesRequested > 0) {
    return { text: `${pull.changesRequested} change${pull.changesRequested === 1 ? '' : 's'} requested`, tone: 'attention' };
  }
  if (pull.review === 'approved') return { text: 'approved · ready to merge', tone: 'success' };
  return null;
}

// ---------- FR-4: filtering ----------

/** Title / #number / head, case-insensitive substring. Empty query matches everything. */
export function filterMatchesPull(pull: PullSummary, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (q === '') return true;
  if (pull.title.toLowerCase().includes(q)) return true;
  if (`#${pull.number}`.includes(q)) return true;
  if (String(pull.number).includes(q)) return true;
  if (pull.head.toLowerCase().includes(q)) return true;
  return false;
}

// ---------- relative time (PR-list wording: "2 h ago" / "yesterday" / "N days ago") ----------

const MS_PER_DAY = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayDiff(ts: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ts)) / MS_PER_DAY);
}

/** "just now" / "Nm ago" / "N h ago" / "yesterday" / "N days ago". */
export function pullRelativeTime(at: number, now: number = Date.now()): string {
  const diff = dayDiff(at, now);
  if (diff <= 0) {
    const ms = Math.max(0, now - at);
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours} h ago`;
  }
  if (diff === 1) return 'yesterday';
  return `${diff} days ago`;
}

// ---------- FR-5: detail ----------

/** Mergeable label's tone — only `blocked` is called out as danger by the spec. */
export function mergeableTone(mergeable: PullDetail['mergeable']): Tone {
  if (mergeable === 'blocked' || mergeable === 'conflicting') return 'danger';
  if (mergeable === 'behind') return 'attention';
  if (mergeable === 'clean') return 'success';
  return 'faint';
}

/** FR-5: Update branch from main is enabled only when behind or blocked. */
export function canUpdateBranch(mergeable: PullDetail['mergeable']): boolean {
  return mergeable === 'behind' || mergeable === 'blocked';
}

/** FR-5: the Merge label warns when the PR isn't clean. */
export function mergeButtonLabel(mergeable: PullDetail['mergeable']): string {
  return mergeable === 'clean' ? 'Merge' : 'Merge · blocked by checks';
}

/** FR-5a: an open, clean PR merges in-app; anything else opens it on GitHub. */
export function canMergeInApp(detail: Pick<PullDetail, 'state' | 'mergeable'>): boolean {
  return detail.state === 'open' && detail.mergeable === 'clean';
}

/** FR-5a: GitHub's own wording for each method. */
export function mergeMethodLabel(method: MergeMethod): string {
  switch (method) {
    case 'squash':
      return 'Squash and merge';
    case 'merge':
      return 'Create a merge commit';
    case 'rebase':
      return 'Rebase and merge';
  }
}

/** FR-5a: the method preselected in the confirm — the core already sends them in preference order. */
export function defaultMergeMethod(methods: MergeMethod[]): MergeMethod {
  return methods[0] ?? 'squash';
}

/** FR-5a: the line shown after a merge, or null when there is nothing to add. */
export function mergeOutcomeNote(outcome: MergeOutcome, head: string, deleteRequested: boolean): string | null {
  if (outcome.branchDeleted) return `Merged. ${head} was deleted on GitHub.`;
  if (deleteRequested) return `Merged, but ${head} was not deleted: ${outcome.branchDeleteError ?? 'unknown error'}`;
  return null;
}

/** Top 4 files shown; the rest folded into "N more files". */
export function visiblePullFiles<T>(files: T[], limit = 4): { shown: T[]; moreCount: number } {
  return { shown: files.slice(0, limit), moreCount: Math.max(0, files.length - limit) };
}

/** "opened 2 h ago by you|<login>". */
export function pullOpenedBy(pull: PullSummary): string {
  return pull.authorIsViewer ? 'you' : pull.author;
}

// ---------- FR-2: gh unavailability copy ----------

export function ghUnavailableMessage(status: GhStatus): string {
  switch (status) {
    case 'missing':
      return 'Install the GitHub CLI (gh) to see pull requests.';
    case 'unauthenticated':
      return 'Run `gh auth login` to see pull requests.';
    case 'not-github':
      return "This repository's remote isn't on GitHub.";
    default:
      return '';
  }
}

/**
 * The PR description as the Description card shows it: PR-template HTML
 * comments stripped (the markdown renderer would print them raw), CRLF
 * normalised, trimmed. `null` when nothing is left — the card then reads
 * "No description provided." Stripping repeats to a fixpoint, because removing
 * one comment can splice its neighbours into a new one (`<!<!-- x -->-- y -->`).
 */
export function pullDescription(body: string): string | null {
  let stripped = body;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(/<!--[\s\S]*?-->/g, '');
  } while (stripped !== previous);
  const text = stripped.replace(/\r\n?/g, '\n').trim();
  return text === '' ? null : text;
}
