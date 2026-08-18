// diff-navigator FR-20..FR-24: pure, dependency-free word-level intraline diffing.
// Runs entirely in the view layer against the existing DiffHunk/DiffLine payload —
// nothing here crosses IPC (spec §5).

import type { DiffLine } from '../../../contract/diff-view';

/** Char-offset span into a DiffLine.text. emphasis: false spans render plain. */
export interface IntralineSpan {
  start: number;
  end: number;
  emphasis: boolean;
}

const SIMILARITY_FLOOR = 0.5;

/** FR-20/FR-23: computes intraline spans for one hunk's lines, keyed by index into
 *  that same `lines` array. Lines with no entry render plain (unequal run length,
 *  below the similarity floor, or not part of any del/add pair). */
export function computeIntralineSpans(lines: readonly DiffLine[]): Map<number, IntralineSpan[]> {
  const result = new Map<number, IntralineSpan[]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== 'del') {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i]!.kind === 'del') i++;
    const delEnd = i;
    const addStart = i;
    while (i < lines.length && lines[i]!.kind === 'add') i++;
    const addEnd = i;
    const delLen = delEnd - delStart;
    const addLen = addEnd - addStart;
    // FR-20: only equal-length runs pair; unequal runs get no emphasis at all.
    if (delLen > 0 && delLen === addLen) {
      for (let k = 0; k < delLen; k++) {
        const delIdx = delStart + k;
        const addIdx = addStart + k;
        const pair = pairSpans(lines[delIdx]!.text, lines[addIdx]!.text);
        if (pair) {
          result.set(delIdx, pair.del);
          result.set(addIdx, pair.add);
        }
      }
    }
  }
  return result;
}

function pairSpans(delText: string, addText: string): { del: IntralineSpan[]; add: IntralineSpan[] } | null {
  const prefixLen = commonPrefixLen(delText, addText);
  const suffixLen = commonSuffixLen(delText, addText, prefixLen);
  const maxLen = Math.max(delText.length, addText.length);
  if (maxLen === 0) return null; // both lines empty — nothing to emphasize
  // FR-21: the similarity floor. Below it, two unrelated rewritten lines stay plain.
  if ((prefixLen + suffixLen) / maxLen < SIMILARITY_FLOOR) return null;

  const delMid = delText.slice(prefixLen, delText.length - suffixLen);
  const addMid = addText.slice(prefixLen, addText.length - suffixLen);
  if (delMid === '' && addMid === '') return null; // identical lines — no spans

  const delTokens = tokenize(delMid);
  const addTokens = tokenize(addMid);
  const { del: delKeep, add: addKeep } = lcsKeepMask(delTokens, addTokens);

  return {
    del: buildFullSpans(delText.length, prefixLen, suffixLen, tokenSpans(delTokens, delKeep, prefixLen)),
    add: buildFullSpans(addText.length, prefixLen, suffixLen, tokenSpans(addTokens, addKeep, prefixLen)),
  };
}

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a: string, b: string, prefixLen: number): number {
  const max = Math.min(a.length - prefixLen, b.length - prefixLen);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

// FR-22: maximal [A-Za-z0-9_]+ runs; every other character is its own token.
function tokenize(s: string): string[] {
  return s.match(/[A-Za-z0-9_]+|[^A-Za-z0-9_]/gs) ?? [];
}

// Longest-common-subsequence keep mask over two token sequences (FR-22).
function lcsKeepMask(a: string[], b: string[]): { del: boolean[]; add: boolean[] } {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const delKeep = new Array<boolean>(n).fill(false);
  const addKeep = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      delKeep[i] = true;
      addKeep[j] = true;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return { del: delKeep, add: addKeep };
}

function tokenSpans(tokens: string[], keep: boolean[], offset: number): IntralineSpan[] {
  const spans: IntralineSpan[] = [];
  let pos = offset;
  for (let idx = 0; idx < tokens.length; idx++) {
    const len = tokens[idx]!.length;
    const emphasis = !keep[idx];
    const start = pos;
    const end = pos + len;
    const last = spans[spans.length - 1];
    if (last && last.emphasis === emphasis && last.end === start) last.end = end;
    else spans.push({ start, end, emphasis });
    pos = end;
  }
  return spans;
}

// Prefix/suffix (FR-22: always unemphasized) + the middle's emphasis spans, with
// adjacent same-emphasis spans merged so consumers get a minimal contiguous list.
function buildFullSpans(len: number, prefixLen: number, suffixLen: number, mid: IntralineSpan[]): IntralineSpan[] {
  const raw: IntralineSpan[] = [];
  if (prefixLen > 0) raw.push({ start: 0, end: prefixLen, emphasis: false });
  raw.push(...mid);
  if (suffixLen > 0) raw.push({ start: len - suffixLen, end: len, emphasis: false });

  const merged: IntralineSpan[] = [];
  for (const span of raw) {
    if (span.start === span.end) continue;
    const last = merged[merged.length - 1];
    if (last && last.emphasis === span.emphasis && last.end === span.start) last.end = span.end;
    else merged.push({ ...span });
  }
  return merged;
}
