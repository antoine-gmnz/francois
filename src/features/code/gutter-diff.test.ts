import { describe, expect, it } from 'vitest';
import { gutterMarks } from './gutter-diff';

describe('gutterMarks (FR-9)', () => {
  it('has no marks for identical text', () => {
    expect(gutterMarks('a\nb\n', 'a\nb\n')).toEqual({ added: [], modified: [], deleted: [] });
  });
  it('marks a changed line as modified', () => {
    expect(gutterMarks('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ added: [], modified: [2], deleted: [] });
  });
  it('marks inserted lines as added', () => {
    expect(gutterMarks('a\nc\n', 'a\nb\nx\nc\n')).toEqual({ added: [2, 3], modified: [], deleted: [] });
  });
  it('puts a notch on the line after a deletion', () => {
    expect(gutterMarks('a\nb\nc\n', 'a\nc\n')).toEqual({ added: [], modified: [], deleted: [2] });
  });
  it('treats a longer replacement as modified plus added', () => {
    expect(gutterMarks('a\nb\nz\n', 'a\nB1\nB2\nz\n')).toEqual({ added: [3], modified: [2], deleted: [] });
  });
  it('clamps a deletion at the end of the file to the last line', () => {
    expect(gutterMarks('a\nb\nc\n', 'a\nb\n')).toEqual({ added: [], modified: [], deleted: [2] });
  });
  it('handles an empty buffer and an empty head', () => {
    expect(gutterMarks('', 'a\n').added).toEqual([1]);
    expect(gutterMarks('a\n', '').deleted).toEqual([1]); // the emptied doc's one blank line carries the notch
  });
  it('is insensitive to the trailing newline alone', () => {
    expect(gutterMarks('a\nb', 'a\nb\n')).toEqual({ added: [], modified: [], deleted: [] });
  });
  it('finds scattered edits through the middle', () => {
    const head = ['1', '2', '3', '4', '5', '6'].join('\n');
    const text = ['1', 'two', '3', '5', '6', '7'].join('\n');
    expect(gutterMarks(head, text)).toEqual({ added: [6], modified: [2], deleted: [4] });
  });
});
