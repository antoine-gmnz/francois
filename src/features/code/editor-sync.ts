// Pure decisions for keeping a buffer honest against the disk (code-editor FR-11/12)
// and for reading a file's conventions (FR-10). Donated from the parked c21a3e6.

import type { FileVersion } from '../../../contract/code-editor';
import type { AppError } from '../../../contract/common';
import type { CodeTab } from './code-tabs';

export type ChangeDecision = 'ignore' | 'reload' | 'conflict';

/** What an `editor.changed` event means for an open tab. */
export function decideOnChange(tab: CodeTab, eventVersion: FileVersion): ChangeDecision {
  // The core promises no echo for its own write; the guard also covers a debounced
  // watcher event that lands after our save already advanced `version`.
  if (eventVersion === tab.version) return 'ignore';
  if (!tab.dirty) return 'reload';
  return tab.conflict?.version === eventVersion ? 'ignore' : 'conflict';
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * The single smallest edit that turns `from` into `to`. Applying a whole-document
 * replacement would collapse the cursor, selection and scroll; a minimal change lets
 * Monaco map them through it (FR-12: "keeping the cursor and scroll").
 */
export function minimalChange(from: string, to: string): TextChange | null {
  if (from === to) return null;
  const max = Math.min(from.length, to.length);
  let lead = 0;
  while (lead < max && from.charCodeAt(lead) === to.charCodeAt(lead)) lead++;
  let trail = 0;
  while (trail < max - lead && from.charCodeAt(from.length - 1 - trail) === to.charCodeAt(to.length - 1 - trail)) trail++;
  return { from: lead, to: from.length - trail, insert: to.slice(lead, to.length - trail) };
}

/** The indent unit a file already uses: a tab, or the dominant space step (default two spaces). */
export function detectIndent(text: string): string {
  let tabs = 0;
  const steps = new Map<number, number>();
  let prev = 0;
  let seen = 0;
  for (const line of text.split('\n', 2000)) {
    if (line.trim() === '') continue;
    seen++;
    if (line.startsWith('\t')) {
      tabs++;
      continue;
    }
    const n = line.length - line.trimStart().length;
    const delta = Math.abs(n - prev);
    if (n > 0 && delta > 0 && delta <= 8) steps.set(delta, (steps.get(delta) ?? 0) + 1);
    prev = n;
  }
  const spaces = [...steps.values()].reduce((a, b) => a + b, 0);
  if (seen > 0 && tabs > spaces) return '\t';
  let best = 2;
  let bestCount = 0;
  for (const [step, count] of steps) {
    if (count > bestCount) {
      best = step;
      bestCount = count;
    }
  }
  return ' '.repeat(best);
}

/** FR-10's status-bar indent field. */
export function indentLabel(unit: string): string {
  return unit === '	' ? 'Tabs' : `Spaces: ${unit.length}`;
}

/** FR-11: the disk version an EDITOR_STALE save reports, or null for any other failure. */
export function staleVersion(error: AppError): FileVersion | null {
  if (error.code !== 'EDITOR_STALE') return null;
  const v = (error.detail as { version?: unknown } | undefined)?.version;
  return typeof v === 'string' ? v : null;
}
