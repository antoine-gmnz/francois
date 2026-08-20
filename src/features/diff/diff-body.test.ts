import { describe, expect, it } from 'vitest';
import type { DiffHunk, DiffLine, FileDiff } from '../../../contract/diff-view';
import {
  BIG_FILE_ROW_THRESHOLD,
  HEADER_H,
  ROW_H,
  buildFileRows,
  computeBlockOffsets,
  computeContextGaps,
  computeVisibleWindows,
  fileBlockSpec,
  filesReadAtScroll,
  isBigFile,
  offsetForPath,
  totalDocumentHeight,
  windowForBlock,
  type BlockSpec,
} from './diff-body';

function line(kind: DiffLine['kind'], text: string, extra: Partial<DiffLine> = {}): DiffLine {
  return { kind, text, ...extra };
}

describe('computeContextGaps (FR-26 — fold-row count arithmetic)', () => {
  it('derives the unchanged-line count between two consecutive hunks from their headers', () => {
    const hunks: Pick<DiffHunk, 'header'>[] = [{ header: '@@ -1,8 +1,9 @@' }, { header: '@@ -34,11 +35,12 @@' }];
    // hunk 0 covers new lines 1..9 (start 1, count 9); hunk 1 starts at new line 35.
    // unchanged run = 35 - (1 + 9) = 25.
    expect(computeContextGaps(hunks)).toEqual([{ afterHunkIndex: 0, count: 25 }]);
  });

  it('treats an omitted count as 1, per git format', () => {
    const hunks: Pick<DiffHunk, 'header'>[] = [{ header: '@@ -5 +5 @@' }, { header: '@@ -10 +10 @@' }];
    expect(computeContextGaps(hunks)).toEqual([{ afterHunkIndex: 0, count: 4 }]);
  });

  it('produces no gap when hunks are adjacent (count would be zero or negative)', () => {
    const hunks: Pick<DiffHunk, 'header'>[] = [{ header: '@@ -1,5 +1,5 @@' }, { header: '@@ -6,5 +6,5 @@' }];
    expect(computeContextGaps(hunks)).toEqual([]);
  });

  it('is empty for zero or one hunk', () => {
    expect(computeContextGaps([])).toEqual([]);
    expect(computeContextGaps([{ header: '@@ -1,5 +1,5 @@' }])).toEqual([]);
  });

  it('ignores a header it cannot parse rather than throwing', () => {
    const hunks: Pick<DiffHunk, 'header'>[] = [{ header: 'not a hunk header' }, { header: '@@ -10 +10 @@' }];
    expect(computeContextGaps(hunks)).toEqual([]);
  });
});

describe('buildFileRows', () => {
  it('flattens hunk header + lines and inserts a fold row where a gap exists', () => {
    const diff: FileDiff = {
      binary: false,
      hunks: [
        { header: '@@ -1,2 +1,2 @@', lines: [line('ctx', 'a', { oldNo: 1, newNo: 1 }), line('ctx', 'b', { oldNo: 2, newNo: 2 })] },
        { header: '@@ -20,2 +20,2 @@', lines: [line('ctx', 'c', { oldNo: 20, newNo: 20 })] },
      ],
    };
    const rows = buildFileRows(diff);
    expect(rows.map((r) => r.kind)).toEqual(['hunk', 'ctx', 'ctx', 'fold', 'hunk', 'ctx']);
    const fold = rows.find((r) => r.kind === 'fold')!;
    expect(fold.foldCount).toBe(17); // 20 - (1 + 2)
    expect(fold.text).toBe('⋯ 17 unchanged lines');
  });

  it('produces no fold row for a single-hunk file', () => {
    const diff: FileDiff = { binary: false, hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [line('ctx', 'a', { oldNo: 1, newNo: 1 })] }] };
    expect(buildFileRows(diff).some((r) => r.kind === 'fold')).toBe(false);
  });
});

describe('computeBlockOffsets (FR-22 — prefix-sum offset table)', () => {
  it('sums HEADER_H + rowCount*ROW_H per block, in order', () => {
    const blocks: BlockSpec[] = [fileBlockSpec({ path: 'a.ts' }, 3, false), fileBlockSpec({ path: 'b.ts' }, 5, false)];
    const offsets = computeBlockOffsets(blocks);
    expect(offsets[0]).toEqual({ path: 'a.ts', top: 0, contentTop: HEADER_H, contentBottom: HEADER_H + 3 * ROW_H });
    expect(offsets[1]).toEqual({
      path: 'b.ts',
      top: HEADER_H + 3 * ROW_H,
      contentTop: HEADER_H + 3 * ROW_H + HEADER_H,
      contentBottom: HEADER_H + 3 * ROW_H + HEADER_H + 5 * ROW_H,
    });
    expect(totalDocumentHeight(offsets)).toBe(offsets[1]!.contentBottom);
  });

  it('a collapsed block contributes exactly its header (FR-23)', () => {
    const blocks: BlockSpec[] = [fileBlockSpec({ path: 'big.ts' }, 1200, true), fileBlockSpec({ path: 'b.ts' }, 2, false)];
    const offsets = computeBlockOffsets(blocks);
    expect(offsets[0]!.contentBottom).toBe(HEADER_H); // collapsed — no rows counted
    expect(offsets[1]!.top).toBe(HEADER_H);
  });

  it('offsetForPath resolves a block header position, or null when absent', () => {
    const blocks: BlockSpec[] = [fileBlockSpec({ path: 'a.ts' }, 3, false), fileBlockSpec({ path: 'b.ts' }, 5, false)];
    const offsets = computeBlockOffsets(blocks);
    expect(offsetForPath(offsets, 'b.ts')).toBe(HEADER_H + 3 * ROW_H);
    expect(offsetForPath(offsets, 'nope.ts')).toBeNull();
  });

  it('is empty for zero files', () => {
    expect(computeBlockOffsets([])).toEqual([]);
    expect(totalDocumentHeight([])).toBe(0);
  });
});

describe('windowForBlock / computeVisibleWindows (cross-file window slice, FR-22)', () => {
  const blocks: BlockSpec[] = [
    fileBlockSpec({ path: 'a.ts' }, 100, false), // rows 0..99, content [32, 32+2100)
    fileBlockSpec({ path: 'b.ts' }, 100, false), // rows 0..99, content [2164, 4264)
  ];
  const offsets = computeBlockOffsets(blocks);
  const rowCounts = [100, 100];

  it('windows only the block the viewport overlaps, leaving the other empty', () => {
    // scroll near the very top: viewport covers only file a.ts.
    const windows = computeVisibleWindows(offsets, rowCounts, 0, 200, 0);
    expect(windows[0]).not.toEqual({ startRow: 0, endRow: 0 });
    expect(windows[1]).toEqual({ startRow: 0, endRow: 0 }); // b.ts is far below, untouched
  });

  it('a block scrolled fully above the window renders nothing (its header stays pinned by the caller)', () => {
    const scrollTop = offsets[1]!.contentTop + 500; // deep inside b.ts
    const windows = computeVisibleWindows(offsets, rowCounts, scrollTop, 200, 0);
    expect(windows[0]).toEqual({ startRow: 0, endRow: 0 }); // a.ts long past
  });

  it('both blocks can be non-empty when the viewport straddles the boundary', () => {
    const scrollTop = offsets[0]!.contentBottom - ROW_H; // near the end of a.ts, into b.ts's header
    const windows = computeVisibleWindows(offsets, rowCounts, scrollTop, 100, 0);
    expect(windows[0]!.endRow).toBeGreaterThan(windows[0]!.startRow);
  });

  it('a collapsed (0 rowCount) block always windows to {0,0}', () => {
    const w = windowForBlock(offsets[0]!, 0, 0, 10_000);
    expect(w).toEqual({ startRow: 0, endRow: 0 });
  });

  it('overscan widens the window beyond the raw viewport', () => {
    const tight = computeVisibleWindows(offsets, rowCounts, 0, 50, 0);
    const overscanned = computeVisibleWindows(offsets, rowCounts, 0, 50, 1000);
    expect(overscanned[0]!.endRow).toBeGreaterThan(tight[0]!.endRow);
  });
});

describe('filesReadAtScroll (FR-28 — read-marking from a scroll offset)', () => {
  const blocks: BlockSpec[] = [fileBlockSpec({ path: 'a.ts' }, 10, false), fileBlockSpec({ path: 'b.ts' }, 10, false)];
  const offsets = computeBlockOffsets(blocks);

  it('marks no file read while scrolled above the first file\'s end', () => {
    expect(filesReadAtScroll(offsets, 0)).toEqual([]);
  });

  it('marks a file read once scrollTop reaches its block\'s bottom', () => {
    expect(filesReadAtScroll(offsets, offsets[0]!.contentBottom)).toEqual(['a.ts']);
  });

  it('marks both files read once scrolled past the whole document', () => {
    expect(filesReadAtScroll(offsets, offsets[1]!.contentBottom)).toEqual(['a.ts', 'b.ts']);
  });

  it('a collapsed file (0 rows) is read once its header alone scrolls past', () => {
    const collapsedBlocks: BlockSpec[] = [fileBlockSpec({ path: 'a.ts' }, 0, true)];
    const collapsedOffsets = computeBlockOffsets(collapsedBlocks);
    expect(filesReadAtScroll(collapsedOffsets, HEADER_H)).toEqual(['a.ts']);
  });
});

describe('isBigFile (FR-23)', () => {
  it('is false at and under the threshold', () => {
    expect(isBigFile(BIG_FILE_ROW_THRESHOLD)).toBe(false);
    expect(isBigFile(1)).toBe(false);
  });

  it('is true over the threshold', () => {
    expect(isBigFile(BIG_FILE_ROW_THRESHOLD + 1)).toBe(true);
  });
});
