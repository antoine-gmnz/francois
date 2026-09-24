// github-ci-logs — pure logic for the CheckRunList accordion: row ordering,
// the header count line, step/log derivations and the re-run eligibility
// check. No IO here — CheckRunList.tsx and actions.ts own the fetching.

import type { CheckJob, CheckRun, CheckState, JobStep, LogLine, StepLog } from '../../../contract/github-page';

// ---------- FR-2: header count line ----------

/** `3 passed · 1 failed · 1 running` — zero terms omitted, this fixed order. */
export function checkCountLine(checks: CheckRun[]): string {
  const passed = checks.filter((c) => c.state === 'passed').length;
  const failed = checks.filter((c) => c.state === 'failed').length;
  const running = checks.filter((c) => c.state === 'pending').length;
  const skipped = checks.filter((c) => c.state === 'skipped').length;
  const parts: string[] = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (running > 0) parts.push(`${running} running`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(' · ');
}

// ---------- FR-2: row order ----------

function groupIndex(state: CheckState): number {
  switch (state) {
    case 'failed':
      return 0;
    case 'pending':
      return 1;
    case 'passed':
      return 2;
    case 'skipped':
      return 3;
    default:
      return 4;
  }
}

/** failed -> running/pending -> passed -> skipped; name order within a group. */
export function checkRowOrder(checks: CheckRun[]): CheckRun[] {
  return [...checks].sort((a, b) => {
    const g = groupIndex(a.state) - groupIndex(b.state);
    if (g !== 0) return g;
    return a.name.localeCompare(b.name);
  });
}

/** Stable identity for expansion/state tracking across a poll refresh
 *  (FR-13): a job by its jobId, everything else by name. */
export function checkKey(check: Pick<CheckRun, 'jobId' | 'name'>): string {
  return check.jobId !== undefined ? `job:${check.jobId}` : `name:${check.name}`;
}

// ---------- FR-4: the collapsed running row's current step ----------

/** The first `running` step, else the first `queued` one, else undefined. */
export function currentStep(job: Pick<CheckJob, 'steps'>): JobStep | undefined {
  return job.steps.find((s) => s.state === 'running') ?? job.steps.find((s) => s.state === 'queued');
}

/** The step FR-5/FR-13 open automatically once a job is known to have failed. */
export function firstFailedStep(job: Pick<CheckJob, 'steps'>): JobStep | undefined {
  return job.steps.find((s) => s.state === 'failed');
}

// ---------- FR-8: which steps are clickable ----------

/** A step opens its log only once the job is done and the step actually ran. */
export function canOpenStep(job: Pick<CheckJob, 'completed'>, step: Pick<JobStep, 'state'>): boolean {
  return job.completed && step.state !== 'skipped' && step.state !== 'queued';
}

// ---------- FR-10: group folding ----------

export interface FoldedLine {
  kind: 'line';
  line: LogLine;
}

export interface FoldedGroup {
  kind: 'group';
  title: string;
  startN: number;
  endN: number;
  lines: LogLine[]; // inner lines, markers excluded, debug lines already dropped
  collapsedByDefault: boolean;
}

export type FoldedItem = FoldedLine | FoldedGroup;

/** Folds `groupStart…groupEnd` spans into one collapsible row, dropping
 *  `debug` lines entirely. A group opens by default only when it holds
 *  `firstErrorLine`. */
export function foldGroups(lines: LogLine[], firstErrorLine?: number): FoldedItem[] {
  const visible = lines.filter((l) => l.kind !== 'debug');
  const items: FoldedItem[] = [];
  let i = 0;
  while (i < visible.length) {
    const line = visible[i];
    if (line.kind === 'groupStart') {
      const inner: LogLine[] = [];
      let j = i + 1;
      while (j < visible.length && visible[j].kind !== 'groupEnd') {
        inner.push(visible[j]);
        j++;
      }
      const hasEnd = j < visible.length;
      const endN = hasEnd ? visible[j].n : (inner.length > 0 ? inner[inner.length - 1].n : line.n);
      const containsError = firstErrorLine !== undefined && inner.some((l) => l.n === firstErrorLine);
      items.push({ kind: 'group', title: line.text, startN: line.n, endN, lines: inner, collapsedByDefault: !containsError });
      i = hasEnd ? j + 1 : j;
    } else if (line.kind === 'groupEnd') {
      // stray end marker with no matching start — ignore it.
      i++;
    } else {
      items.push({ kind: 'line', line });
      i++;
    }
  }
  return items;
}

// ---------- FR-15: failure excerpt for "Fix in a new session" ----------

/** 60 lines ending 10 lines after `firstErrorLine`, or the last `maxLines`
 *  lines when there is none. Plain text, newline-joined. */
export function failureExcerpt(log: Pick<StepLog, 'lines' | 'firstErrorLine'>, maxLines = 60): string {
  if (log.lines.length === 0) return '';
  if (log.firstErrorLine !== undefined) {
    const endN = log.firstErrorLine + 10;
    const upTo = log.lines.filter((l) => l.n <= endN);
    return upTo.slice(-maxLines).map((l) => l.text).join('\n');
  }
  return log.lines.slice(-maxLines).map((l) => l.text).join('\n');
}

// ---------- FR-16: re-run eligibility ----------

export interface RerunTarget {
  runId: number;
  /** Names of the failed checks sharing this run — used as the confirm's
   *  workflow-name list (the check list carries no separate workflow name). */
  names: string[];
}

/** One `RerunTarget` per `runId` that has >= 1 failed check and every check
 *  sharing that `runId` is non-pending (FR-16). */
export function rerunTargets(checks: CheckRun[]): RerunTarget[] {
  const byRun = new Map<number, CheckRun[]>();
  for (const c of checks) {
    if (c.runId === undefined) continue;
    const list = byRun.get(c.runId);
    if (list) list.push(c);
    else byRun.set(c.runId, [c]);
  }
  const targets: RerunTarget[] = [];
  for (const [runId, group] of byRun) {
    const failedNames = group.filter((c) => c.state === 'failed').map((c) => c.name);
    const allNonPending = group.every((c) => c.state !== 'pending');
    if (failedNames.length > 0 && allNonPending) targets.push({ runId, names: failedNames });
  }
  return targets;
}

// ---------- FR-13/FR-14: liveness ----------

/** True while there's something to poll for and the view is actually
 *  visible — the one gate FR-13 (list) and FR-7 (job) share. */
export function pollingActive(hasPending: boolean, visible: boolean): boolean {
  return hasPending && visible;
}

/** FR-13/edge-case: back off to 60s after two consecutive poll failures,
 *  reset to `baseMs` on the next success. */
export function nextPollDelayMs(baseMs: number, consecutiveFailures: number): number {
  return consecutiveFailures >= 2 ? 60_000 : baseMs;
}
