import type { DiffEvent } from '../../../contract/diff-view';

export type DiffEventAction = 'ignore' | 'consumeEcho' | 'queueRefresh' | 'refetch';

// Decides how DiffView's live subscription should react to a diff.changed broadcast,
// given the outstanding-echo counter and whether a summary fetch is already in
// flight. Pure extraction of the conditional chain in DiffView's hydrate effect:
// every successful getSummary broadcasts one echo of its own (FR-17), which must be
// swallowed rather than re-triggering a fetch; a burst of external diff.changed
// events that arrives while a fetch is in flight coalesces into a single trailing
// refetch instead of stacking fetches.
export function nextDiffEventAction(
  event: Pick<DiffEvent, 'type' | 'sessionId'>,
  sessionId: string,
  pendingEcho: number,
  summaryInFlight: boolean,
): DiffEventAction {
  if (event.type !== 'diff.changed' || event.sessionId !== sessionId) return 'ignore';
  if (pendingEcho > 0) return 'consumeEcho';
  if (summaryInFlight) return 'queueRefresh';
  return 'refetch';
}
