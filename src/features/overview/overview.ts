// overview — presentation helpers local to the OVERVIEW dashboard. Everything
// aggregational lives in contract/overview.ts; what is here is purely how the
// aggregate is WORDED. Both files are unit-tested in overview.test.ts.

import type { FleetTotals, OverviewGroup } from '../../../contract/overview';

/**
 * A monotonically increasing id for an activity entry. `Date.now()` alone is not
 * enough — several events routinely land in the same millisecond and React would
 * see duplicate keys — so a process-local counter is appended.
 */
let activitySeq = 0;
export function mintActivityId(at: number): string {
  activitySeq += 1;
  return `${at}-${activitySeq}`;
}

/** One segment of the totals strip. `tone` selects the token at render. */
export interface TotalsSegment {
  label: string;
  value: number;
  tone: 'active' | 'ready' | 'done' | 'error' | 'neutral' | 'accent';
}

/**
 * The totals strip, ZERO-VALUED SEGMENTS REMOVED — a dashboard that always reads
 * "0 error" trains the eye to ignore the word, which is exactly the word that must
 * still register at a glance when it is not zero.
 */
export function totalsSegments(t: FleetTotals): TotalsSegment[] {
  const all: TotalsSegment[] = [
    { label: 'active', value: t.counts.running, tone: 'active' },
    { label: 'ready', value: t.counts.idle, tone: 'ready' },
    { label: 'done', value: t.counts.done, tone: 'done' },
    { label: 'error', value: t.counts.error, tone: 'error' },
    { label: 'files', value: t.changedFiles, tone: 'neutral' },
    { label: 'agents', value: t.runningAgents, tone: 'accent' },
  ];
  return all.filter((s) => s.value > 0);
}

/**
 * A group header's second line: the session count, then only the statuses worth
 * calling out. `idle` is the resting state — naming it adds nothing, so a group
 * where everything is merely ready reads as just its count.
 */
export function formatGroupSubtitle(g: OverviewGroup): string {
  const n = g.sessions.length;
  if (n === 0) return 'no sessions';
  const parts = [`${n} session${n === 1 ? '' : 's'}`];
  if (g.counts.running > 0) parts.push(`${g.counts.running} active`);
  if (g.counts.error > 0) parts.push(`${g.counts.error} error`);
  if (g.counts.done > 0) parts.push(`${g.counts.done} done`);
  return parts.join(' · ');
}
