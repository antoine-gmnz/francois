// The Changes panel's pull-request card (SessionPullCard.tsx) — pure half.
// A session "has" a PR when an open or draft PR's head is the branch its cwd
// has checked out; the join is by branch name, like linkage.ts.

import type { PullDetail, PullSummary } from '../../../contract/github-page';
import type { Tone } from './pulls';

/** The open/draft PR whose head is `branch` — the most recently updated when several match. */
export function pullForBranch(pulls: readonly PullSummary[], branch: string | null | undefined): PullSummary | null {
  if (!branch) return null;
  let best: PullSummary | null = null;
  for (const p of pulls) {
    if (p.head !== branch || (p.state !== 'open' && p.state !== 'draft')) continue;
    if (!best || p.updatedAt > best.updatedAt) best = p;
  }
  return best;
}

/** The card's one-word mergeability line. */
export function mergeableSummary(mergeable: PullDetail['mergeable']): { text: string; tone: Tone } {
  switch (mergeable) {
    case 'clean':
      return { text: 'ready to merge', tone: 'success' };
    case 'blocked':
      return { text: 'merge blocked', tone: 'danger' };
    case 'conflicting':
      return { text: 'has conflicts', tone: 'danger' };
    case 'behind':
      return { text: 'behind base', tone: 'attention' };
    default:
      return { text: 'checking mergeability', tone: 'faint' };
  }
}
