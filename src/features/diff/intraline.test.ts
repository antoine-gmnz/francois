import { describe, expect, it } from 'vitest';
import type { DiffLine } from '../../../contract/diff-view';
import { computeIntralineSpans, type IntralineSpan } from './intraline';

function del(text: string): DiffLine {
  return { kind: 'del', oldNo: 1, text };
}
function add(text: string): DiffLine {
  return { kind: 'add', newNo: 1, text };
}
function ctx(text: string): DiffLine {
  return { kind: 'ctx', oldNo: 1, newNo: 1, text };
}

function emphasized(text: string, spans: IntralineSpan[] | undefined): string[] {
  return (spans ?? []).filter((s) => s.emphasis).map((s) => text.slice(s.start, s.end));
}

describe('computeIntralineSpans', () => {
  it('pairs an equal-length del/add run and emphasizes only the changed word (FR-20/FR-22)', () => {
    const lines = [del('let foo = 1;'), add('let bar = 1;')];
    const result = computeIntralineSpans(lines);
    expect(emphasized(lines[0]!.text, result.get(0))).toEqual(['foo']);
    expect(emphasized(lines[1]!.text, result.get(1))).toEqual(['bar']);
  });

  it('leaves prefix and suffix unemphasized on a mid-word edit', () => {
    const lines = [del('the old value'), add('the new value')];
    const result = computeIntralineSpans(lines);
    expect(emphasized(lines[0]!.text, result.get(0))).toEqual(['old']);
    expect(emphasized(lines[1]!.text, result.get(1))).toEqual(['new']);
    // trimmed prefix/suffix spans are present and unemphasized
    const delSpans = result.get(0)!;
    expect(delSpans[0]).toEqual({ start: 0, end: 4, emphasis: false });
    expect(delSpans[delSpans.length - 1]).toEqual({ start: 7, end: 13, emphasis: false });
  });

  it('bails out with no emphasis when the del/add run lengths differ (FR-20)', () => {
    const lines = [del('one'), del('two'), add('only one line')];
    const result = computeIntralineSpans(lines);
    expect(result.has(0)).toBe(false);
    expect(result.has(1)).toBe(false);
    expect(result.has(2)).toBe(false);
  });

  it('produces no emphasis below the similarity floor (FR-21)', () => {
    const lines = [del('alpha bravo charlie'), add('xray yankee zulu')];
    const result = computeIntralineSpans(lines);
    expect(result.has(0)).toBe(false);
    expect(result.has(1)).toBe(false);
  });

  it('produces no emphasis for a whole-line rewrite with no shared prefix/suffix', () => {
    const lines = [del('completely different'), add('totally unrelated stuff')];
    const result = computeIntralineSpans(lines);
    expect(result.size).toBe(0);
  });

  it('produces no spans for a pair of identical lines', () => {
    const lines = [del('same line'), add('same line')];
    const result = computeIntralineSpans(lines);
    expect(result.has(0)).toBe(false);
    expect(result.has(1)).toBe(false);
  });

  it('handles empty lines without emphasis', () => {
    const lines = [del(''), add('')];
    const result = computeIntralineSpans(lines);
    expect(result.has(0)).toBe(false);
    expect(result.has(1)).toBe(false);
  });

  it('handles one empty line paired with a non-empty one without emphasis (below the floor)', () => {
    const lines = [del(''), add('x')];
    const result = computeIntralineSpans(lines);
    expect(result.has(0)).toBe(false);
    expect(result.has(1)).toBe(false);
  });

  it('emphasizes a pure whitespace-only change on the del side only', () => {
    const lines = [del('foo  bar'), add('foo bar')];
    const result = computeIntralineSpans(lines);
    expect(emphasized(lines[0]!.text, result.get(0))).toEqual([' ']);
    expect(emphasized(lines[1]!.text, result.get(1))).toEqual([]);
  });

  it('does not pair across a hunk boundary — runs are scanned per hunk call', () => {
    // The caller is responsible for invoking this per-hunk (spec §7); within one
    // call, a ctx line ends a run so a del before it never pairs with an add after.
    const lines = [del('foo'), ctx('---'), add('bar')];
    const result = computeIntralineSpans(lines);
    expect(result.size).toBe(0);
  });

  it('handles multiple equal-length runs independently within one hunk', () => {
    const lines = [del('let foo = 1;'), add('let bar = 1;'), ctx('unchanged'), del('let baz = 2;'), add('let qux = 2;')];
    const result = computeIntralineSpans(lines);
    expect(emphasized(lines[0]!.text, result.get(0))).toEqual(['foo']);
    expect(emphasized(lines[1]!.text, result.get(1))).toEqual(['bar']);
    expect(emphasized(lines[3]!.text, result.get(3))).toEqual(['baz']);
    expect(emphasized(lines[4]!.text, result.get(4))).toEqual(['qux']);
  });
});
