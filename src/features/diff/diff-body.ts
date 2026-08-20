// diff-review FR-18..FR-26, FR-28: pure body-row model. The body is one scroll
// container holding every file's header + diff rows (FR-18), header rows (32px)
// and diff rows (ROW_H=21px) mixed — so windowing needs a prefix-sum offset table
// per file block (FR-22) rather than the single-height division `diff-view` used.
// Nothing here crosses IPC (spec §5) or touches the DOM.

import type { DiffFileSummary, DiffHunk, DiffLine, FileDiff } from '../../../contract/diff-view';
import { computeIntralineSpans, type IntralineSpan } from './intraline';

// Row geometry is load-bearing (design brief "Notes"): 32px headers, 21px rows.
// No padding/border/margin/font-size change may alter these without breaking the
// offset table below.
export const HEADER_H = 32;
export const ROW_H = 21;

/** FR-23: a file whose diff exceeds this many rendered rows starts collapsed. */
export const BIG_FILE_ROW_THRESHOLD = 800;

/** FR-26: the `context` sent on a fold-row click — the contract's own clamp
 *  ceiling, wide enough that every gap in a single file disappears at once. */
export const EXPANDED_CONTEXT = 10000;

// ---------- per-file row model (FR-25/FR-26) ----------

export type BodyRowKind = DiffLine['kind'] | 'fold';

export interface BodyRow {
  kind: BodyRowKind;
  no: string;
  text: string;
  spans: IntralineSpan[];
  /** Only set for kind 'fold' — the unchanged-line count named in the label. */
  foldCount?: number;
}

/** Consecutive hunk headers, line arithmetic only (FR-26): the gap between hunk[i]
 *  and hunk[i+1], keyed by the index of the hunk it follows. Uses the new-file line
 *  numbers, which are what `git diff -U<n>` re-fetches against. A header this can't
 *  parse (defensive — core always emits git's own format) contributes no gap. */
export interface FoldGap {
  afterHunkIndex: number;
  count: number;
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(header: string): { newStart: number; newCount: number } | null {
  const m = HUNK_HEADER_RE.exec(header);
  if (!m) return null;
  const newStart = Number(m[1]);
  // git omits the count when it is exactly 1.
  const newCount = m[2] !== undefined ? Number(m[2]) : 1;
  return { newStart, newCount };
}

export function computeContextGaps(hunks: readonly Pick<DiffHunk, 'header'>[]): FoldGap[] {
  const gaps: FoldGap[] = [];
  for (let i = 0; i < hunks.length - 1; i++) {
    const cur = parseHunkHeader(hunks[i]!.header);
    const next = parseHunkHeader(hunks[i + 1]!.header);
    if (!cur || !next) continue;
    const count = next.newStart - (cur.newStart + cur.newCount);
    if (count > 0) gaps.push({ afterHunkIndex: i, count });
  }
  return gaps;
}

/** Flattens one file's hunks into the row list the body renders: a hunk-header row,
 *  its lines with intraline spans (diff-navigator FR-20..24, unchanged), and a
 *  `fold` row wherever computeContextGaps finds a gap (FR-26). Its length is the
 *  file's "rendered row count" for the big-file guard (FR-23). */
export function buildFileRows(diff: Pick<FileDiff, 'hunks'>): BodyRow[] {
  const out: BodyRow[] = [];
  const gapByHunk = new Map(computeContextGaps(diff.hunks).map((g) => [g.afterHunkIndex, g.count]));
  diff.hunks.forEach((hunk, hIdx) => {
    out.push({ kind: 'hunk', no: '', text: hunk.header, spans: [] });
    const spansByIndex = computeIntralineSpans(hunk.lines);
    hunk.lines.forEach((line, idx) => {
      out.push({
        kind: line.kind,
        no: line.kind === 'del' ? String(line.oldNo ?? '') : String(line.newNo ?? ''),
        text: line.text,
        spans: spansByIndex.get(idx) ?? [],
      });
    });
    const gap = gapByHunk.get(hIdx);
    if (gap) out.push({ kind: 'fold', no: '', text: `⋯ ${gap} unchanged lines`, spans: [], foldCount: gap });
  });
  return out;
}

// ---------- document-level prefix-sum offset table (FR-22) ----------

export interface BlockSpec {
  path: string;
  /** true when the file is collapsed to its header alone (FR-21/FR-23). */
  collapsed: boolean;
  rowCount: number;
}

export interface BlockOffset {
  path: string;
  /** px where this block's header starts. */
  top: number;
  /** px where this block's content rows start (top + HEADER_H). */
  contentTop: number;
  /** px where this block's content rows end — also the block's bottom. */
  contentBottom: number;
}

/** The prefix-sum offset table: one entry per file block, each block sized
 *  HEADER_H + (collapsed ? 0 : rowCount * ROW_H) — the two row heights the body
 *  mixes, in tree order (FR-24). */
export function computeBlockOffsets(blocks: readonly BlockSpec[]): BlockOffset[] {
  const out: BlockOffset[] = [];
  let cursor = 0;
  for (const b of blocks) {
    const top = cursor;
    const contentTop = top + HEADER_H;
    const contentBottom = contentTop + (b.collapsed ? 0 : b.rowCount * ROW_H);
    out.push({ path: b.path, top, contentTop, contentBottom });
    cursor = contentBottom;
  }
  return out;
}

export function totalDocumentHeight(offsets: readonly BlockOffset[]): number {
  return offsets.length === 0 ? 0 : offsets[offsets.length - 1]!.contentBottom;
}

/** FR-8: the body scrollTop that puts a file's header at the top of the container. */
export function offsetForPath(offsets: readonly BlockOffset[], path: string): number | null {
  const o = offsets.find((b) => b.path === path);
  return o ? o.top : null;
}

// ---------- cross-file window slice (FR-22) ----------

export interface RowWindow {
  /** Local row index (into that file's own BodyRow[]) to start rendering, inclusive. */
  startRow: number;
  /** Local row index to stop rendering, exclusive. */
  endRow: number;
}

/** The local [startRow, endRow) slice of ONE file's rows that overlaps the pixel
 *  window [loPx, hiPx) — {0,0} when the file's content is fully collapsed or
 *  entirely outside the window (still contributes its header, rendered
 *  unconditionally by the caller — only the expensive row list is windowed). */
export function windowForBlock(offset: BlockOffset, rowCount: number, loPx: number, hiPx: number): RowWindow {
  if (rowCount === 0) return { startRow: 0, endRow: 0 };
  if (offset.contentBottom <= loPx || offset.contentTop >= hiPx) return { startRow: 0, endRow: 0 };
  const startRow = Math.max(0, Math.floor((loPx - offset.contentTop) / ROW_H));
  const endRow = Math.min(rowCount, Math.ceil((hiPx - offset.contentTop) / ROW_H));
  return { startRow, endRow };
}

/** Cross-file window slice: for every block (in the SAME order as `offsets`),
 *  the local row range to actually mount, given the current scroll position. The
 *  window spans the whole stacked document (FR-22), not one file. */
export function computeVisibleWindows(
  offsets: readonly BlockOffset[],
  rowCounts: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscanPx = 600,
): RowWindow[] {
  const lo = Math.max(0, scrollTop - overscanPx);
  const hi = scrollTop + viewportHeight + overscanPx;
  return offsets.map((o, i) => windowForBlock(o, rowCounts[i] ?? 0, lo, hi));
}

// ---------- read-marking from a scroll offset (FR-28) ----------

/** FR-28: a file becomes read once its LAST row has scrolled above the top of the
 *  viewport — i.e. its block's bottom offset is at or above `scrollTop`. Marking is
 *  one-way; callers union the result into the read set rather than replacing it. */
export function filesReadAtScroll(offsets: readonly BlockOffset[], scrollTop: number): string[] {
  return offsets.filter((o) => o.contentBottom <= scrollTop).map((o) => o.path);
}

// ---------- misc pure helpers used by the body/rail ----------

/** FR-23: does this file's rendered row count exceed the big-file guard? */
export function isBigFile(rowCount: number): boolean {
  return rowCount > BIG_FILE_ROW_THRESHOLD;
}

export function fileBlockSpec(file: Pick<DiffFileSummary, 'path'>, rowCount: number, collapsed: boolean): BlockSpec {
  return { path: file.path, collapsed, rowCount };
}
