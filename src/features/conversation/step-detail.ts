// command-inspect (spec §4 "Panel (frontend)"): pure formatting + fold logic for
// the unfolded step record (StepDetailPanel.tsx). Kept framework-free so the
// header's omit-when-absent rules (FR-15) and the output fold/`show all`/
// dropped-lines rules (FR-17) are unit-tested directly — the panel itself is
// DOM assembly only (this project's vitest has no DOM/component renderer, see
// vite.config.ts).

import type { ClaudeRuntime } from '../../../contract/common';
import type { StepDetail, StepOutput } from '../../../contract/command-inspect';
import { formatFileSize } from './attachments';

/** `12:06:41` — local wall clock with seconds (the transcript's own formatClock
 *  (transcript-turns.ts) stops at minutes; a step is commonly sub-minute). */
export function formatStepClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * `4.2s` under a minute (one decimal — a step is commonly faster than a whole
 * turn, where transcript-turns' formatTurnDuration rounds to the second), `1m
 * 52s` at or above it — same "largest two units, drop a zero remainder" shape.
 */
export function formatStepDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return `${(clamped / 1000).toFixed(1)}s`;
  const total = Math.floor(clamped / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  if (h > 0) return m === 0 ? `${h}h` : `${h}h ${m}m`;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** FR-15: `wsl · Ubuntu-22.04` (distro present), `wsl` (wsl without a resolved
 *  distro), or null on `native` — no runtime segment at all. */
export function stepRuntimeLabel(runtime: ClaudeRuntime, distro?: string): string | null {
  if (runtime !== 'wsl') return null;
  return distro ? `wsl · ${distro}` : 'wsl';
}

/** FR-15/FR-4: `exit N` when the runtime stated one, `failed` when errored
 *  without one, or null on a clean success — nothing renders for it. */
export function stepOutcome(detail: Pick<StepDetail, 'isError' | 'exitCode'>): string | null {
  if (detail.exitCode !== undefined) {
    // A clean exit 0 is a success — no outcome segment (design brief: absent on success).
    if (detail.exitCode === 0 && !detail.isError) return null;
    return `exit ${detail.exitCode}`;
  }
  if (detail.isError) return 'failed';
  return null;
}

/** One `·`-joined header segment, tagged with which tone it renders in
 *  (design brief §8: tool is tinted, an outcome present is always non-clean
 *  so it carries the failure tint; everything else is the header's plain tone). */
export interface StepHeaderSegment {
  text: string;
  tone: 'tool' | 'plain' | 'outcome';
}

export interface StepHeaderGroups {
  /** tool, cwd, runtime+distro — left-aligned. */
  left: StepHeaderSegment[];
  /** wall clock, duration, outcome — grouped right (`margin-left: auto`). */
  right: StepHeaderSegment[];
}

/**
 * FR-15: the header's segments split into the left group (tool lowercased,
 * cwd, runtime+distro) and the right group (wall clock, duration, outcome),
 * each omitted outright when its field is absent rather than rendered as a
 * placeholder.
 */
export function stepHeaderGroups(detail: StepDetail): StepHeaderGroups {
  const left: StepHeaderSegment[] = [
    { text: detail.tool.toLowerCase(), tone: 'tool' },
    { text: detail.cwd, tone: 'plain' },
  ];
  const runtime = stepRuntimeLabel(detail.runtime, detail.distro);
  if (runtime) left.push({ text: runtime, tone: 'plain' });

  const right: StepHeaderSegment[] = [{ text: formatStepClock(detail.startedAt), tone: 'plain' }];
  if (detail.endedAt !== undefined) {
    right.push({ text: formatStepDuration(detail.endedAt - detail.startedAt), tone: 'plain' });
  }
  const outcome = stepOutcome(detail);
  if (outcome) right.push({ text: outcome, tone: 'outcome' });

  return { left, right };
}

/** FR-17: `output · {totalLines} lines · {totalBytes}`, plus `{n} on stderr`
 *  only when the runtime separated the streams and the count is non-zero. */
export function stepOutputTotals(output: StepOutput): string {
  const base = `output · ${output.totalLines} lines · ${formatFileSize(output.totalBytes)}`;
  return output.stderrLines !== undefined && output.stderrLines > 0 ? `${base} · ${output.stderrLines} on stderr` : base;
}

/** '' ⇒ no lines at all — distinct from a single empty trailing line. */
export function splitOutputLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

export const STEP_OUTPUT_TAIL_LINES = 15;

/** FR-17: the last {STEP_OUTPUT_TAIL_LINES} lines, or the whole slice once
 *  `showAll` has revealed it (one-way — the caller never toggles it back). */
export function visibleStepOutputLines(output: StepOutput, showAll: boolean): string[] {
  const lines = splitOutputLines(output.text);
  return showAll || lines.length <= STEP_OUTPUT_TAIL_LINES ? lines : lines.slice(-STEP_OUTPUT_TAIL_LINES);
}

export interface StepOutputFooter {
  kind: 'folded' | 'dropped';
  count: number;
  /** Whether `show all` still has something local left to reveal. */
  showAllLink: boolean;
}

/**
 * FR-17: `droppedLines > 0` always wins — capture itself cut lines before
 * they ever reached the frontend, so "the panel never presents a capped slice
 * as complete" holds even once `show all` has revealed the rest of `text`
 * (`showAllLink` just drops off once there is nothing further to reveal
 * locally). Absent that, a `folded` footer appears only while more of `text`
 * itself is hidden behind the {STEP_OUTPUT_TAIL_LINES}-line tail, and
 * disappears outright once `show all` has revealed it — nothing is folded
 * anymore, so there is nothing left to say.
 */
export function stepOutputFooter(output: StepOutput, showAll: boolean): StepOutputFooter | null {
  const lines = splitOutputLines(output.text);
  const hasMoreLocally = !showAll && lines.length > STEP_OUTPUT_TAIL_LINES;
  if (output.droppedLines > 0) {
    return { kind: 'dropped', count: output.droppedLines, showAllLink: hasMoreLocally };
  }
  if (hasMoreLocally) {
    return { kind: 'folded', count: lines.length - STEP_OUTPUT_TAIL_LINES, showAllLink: true };
  }
  return null;
}
