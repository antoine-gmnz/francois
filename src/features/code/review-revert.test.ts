// code-editor-agents FR-11/FR-12 — reverting one diff hunk back to HEAD.

import { describe, expect, it } from 'vitest';
import { hunkAt, revertHunk, type LineChange } from './review-revert';

const HEAD = 'a\nb\nc\nd\n';

const change = (oS: number, oE: number, mS: number, mE: number): LineChange => ({
  originalStartLineNumber: oS,
  originalEndLineNumber: oE,
  modifiedStartLineNumber: mS,
  modifiedEndLineNumber: mE,
});

describe('revertHunk', () => {
  it('puts the HEAD lines back over a modified hunk and reports its pre-revert range', () => {
    const buf = 'a\nB1\nB2\nd\n';
    expect(revertHunk(buf, HEAD, change(2, 3, 2, 3))).toEqual({ text: HEAD, startLine: 2, endLine: 3 });
  });

  it('removes an inserted hunk (no original lines)', () => {
    const buf = 'a\nb\nNEW\nc\nd\n';
    expect(revertHunk(buf, HEAD, change(2, 0, 3, 3))).toEqual({ text: HEAD, startLine: 3, endLine: 3 });
  });

  it('restores a deleted hunk after its anchor line', () => {
    const buf = 'a\nd\n';
    expect(revertHunk(buf, HEAD, change(2, 3, 1, 0))).toEqual({ text: HEAD, startLine: 1, endLine: 1 });
  });

  it('restores lines deleted from the very top', () => {
    expect(revertHunk('c\nd\n', HEAD, change(1, 2, 0, 0))).toEqual({ text: HEAD, startLine: 1, endLine: 1 });
  });

  it('leaves the other hunks alone', () => {
    const buf = 'A\nb\nc\nD\n';
    expect(revertHunk(buf, HEAD, change(4, 4, 4, 4)).text).toBe('A\nb\nc\nd\n');
  });
});

describe('hunkAt', () => {
  const changes = [change(1, 1, 1, 1), change(3, 4, 2, 0), change(5, 0, 6, 8)];
  it('finds the hunk covering a modified line, or the deletion anchored on it', () => {
    expect(hunkAt(changes, 1)).toBe(changes[0]);
    expect(hunkAt(changes, 2)).toBe(changes[1]);
    expect(hunkAt(changes, 7)).toBe(changes[2]);
    expect(hunkAt(changes, 4)).toBeNull();
  });
});
