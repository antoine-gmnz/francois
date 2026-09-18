import type { DiffEvent } from '../../../contract/diff-view';

export type DiffEventAction = 'ignore' | 'queueRefresh' | 'refetch';

// Decides how DiffView's live subscription should react to a diff.changed broadcast,
// given whether a summary fetch is already in flight. Pure extraction of the
// conditional chain in DiffView's hydrate effect: a burst of diff.changed events
// that arrives while a fetch is in flight coalesces into a single trailing refetch
// instead of stacking fetches.
//
// There is no longer an echo to swallow: `diff_get_summary` does not broadcast
// (FR-17 amended) — a read is not a change — so every event that reaches here came
// from the watcher, a tool.done, or a commit.
export function nextDiffEventAction(
  event: Pick<DiffEvent, 'type' | 'sessionId'>,
  sessionId: string,
  summaryInFlight: boolean,
): DiffEventAction {
  if (event.type !== 'diff.changed' || event.sessionId !== sessionId) return 'ignore';
  if (summaryInFlight) return 'queueRefresh';
  return 'refetch';
}
