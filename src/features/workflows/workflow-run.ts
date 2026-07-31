// workflow-run — pane [6]'s pure logic: card ordering, the phase-count label,
// the meta line's activity suffix, and the ArrowDown/ArrowUp/Enter key table.
// Kept framework-free so it is unit-testable without a component renderer
// (this project has none — see REFACTOR-CONVENTIONS.md).

import type { WorkflowRun } from '../../../contract/common';

/** Running runs float to the top; within a rank, first-seen order is kept. */
const rank = (status: string) => (status === 'running' ? 0 : 1);

export function orderedRuns(runs: Map<string, WorkflowRun>): WorkflowRun[] {
  return Array.from(runs.values())
    .map((run, i) => ({ run, i }))
    .sort((left, right) => rank(left.run.status) - rank(right.run.status) || left.i - right.i)
    .map(({ run }) => run);
}

/**
 * The card's phase-count chip, or null when the dispatch carried no script to
 * read phases from (a saved workflow by name). We never invent a count.
 */
export function phaseCountLabel(run: WorkflowRun): string | null {
  const n = run.phases.length;
  if (n === 0) return null;
  return n === 1 ? '1 phase' : `${n} phases`;
}

/**
 * The meta line's trailing text. `lastActivity` is the honest one-liner the core
 * derived from the stream (the ack, the completion notice, or the turn-end
 * backstop); a run that has had none yet reads as just dispatched.
 */
export function activityText(run: WorkflowRun): string {
  if (run.lastActivity && run.lastActivity !== '') return run.lastActivity;
  return run.status === 'running' ? 'dispatched' : run.status;
}

/**
 * What the panel can say about phase PROGRESS: nothing. The workflow's own
 * agents never surface in the parent session's stream, so the expanded card
 * lists the phases the script declared and says so, rather than implying a
 * phase is current or finished.
 */
export const PHASES_NOTE = 'declared phases · live progress is in the workflow log';

export const EMPTY_LABEL = 'no workflows yet';

// ---------- keyboard (pane [6]) ----------

export type WorkflowKeyAction = { kind: 'select'; id: string } | { kind: 'toggle'; id: string } | { kind: 'none' };

export interface WorkflowKeyContext {
  list: WorkflowRun[];
  selectedId: string | null;
}

/** Nothing selected (`cur < 0`) starts at the near edge, then clamps. */
function stepIndex(cur: number, delta: number, length: number): number {
  const base = cur < 0 ? 0 : cur + delta;
  return delta > 0 ? Math.min(base, length - 1) : Math.max(base, 0);
}

function moveAction(ctx: WorkflowKeyContext, delta: number): WorkflowKeyAction {
  const cur = ctx.list.findIndex((run) => run.id === ctx.selectedId);
  const run = ctx.list[stepIndex(cur, delta, ctx.list.length)];
  return run ? { kind: 'select', id: run.id } : { kind: 'none' };
}

const KEY_ACTIONS: Record<string, (ctx: WorkflowKeyContext) => WorkflowKeyAction> = {
  ArrowDown: (ctx) => moveAction(ctx, 1),
  ArrowUp: (ctx) => moveAction(ctx, -1),
  Enter: (ctx) => (ctx.selectedId ? { kind: 'toggle', id: ctx.selectedId } : { kind: 'none' }),
};

/** What pressing `key` should do, given the panel's current state. */
export function resolveWorkflowKeyAction(key: string, ctx: WorkflowKeyContext): WorkflowKeyAction {
  const handler = KEY_ACTIONS[key];
  return handler ? handler(ctx) : { kind: 'none' };
}

// ---------- live event application ----------

/**
 * Apply one `workflow.update` to the card map. Setting an existing key preserves
 * its insertion position, so a run never jumps around as it progresses.
 */
export function applyRunUpdate(prev: Map<string, WorkflowRun>, run: WorkflowRun): Map<string, WorkflowRun> {
  const next = new Map(prev);
  next.set(run.id, run);
  return next;
}

/** Seed the map from `workflows_list`, without clobbering anything a pre-hydration event already applied. */
export function seedRuns(prev: Map<string, WorkflowRun>, data: WorkflowRun[]): Map<string, WorkflowRun> {
  const next = new Map(prev);
  for (const run of data) if (!next.has(run.id)) next.set(run.id, run);
  return next;
}
