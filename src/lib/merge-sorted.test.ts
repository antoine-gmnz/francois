import { describe, expect, it } from 'vitest';
import { mergeSorted } from './merge-sorted';

interface Item {
  key: number;
  tag: string;
}
const item = (key: number, tag = ''): Item => ({ key, tag });
const keyOf = (i: Item) => i.key;

describe('mergeSorted', () => {
  it('appends an unknown key at the end', () => {
    const out = mergeSorted([item(1), item(2)], item(3), keyOf);
    expect(out.map(keyOf)).toEqual([1, 2, 3]);
  });

  it('prepends a key smaller than every existing element', () => {
    const out = mergeSorted([item(3), item(4)], item(1), keyOf);
    expect(out.map(keyOf)).toEqual([1, 3, 4]);
  });

  it('inserts an out-of-order key at its sorted middle position', () => {
    const out = mergeSorted([item(1), item(4)], item(2), keyOf);
    expect(out.map(keyOf)).toEqual([1, 2, 4]);
  });

  it('replaces an existing key in place without appending (the meta-fill case)', () => {
    const out = mergeSorted([item(1), item(2, 'open'), item(3)], item(2, 'filled'), keyOf);
    expect(out.map(keyOf)).toEqual([1, 2, 3]);
    expect(out[1].tag).toBe('filled');
  });

  it('replacing preserves every other element unchanged (same references)', () => {
    const a = item(1);
    const c = item(3);
    const out = mergeSorted([a, item(2, 'open'), c], item(2, 'filled'), keyOf);
    expect(out[0]).toBe(a);
    expect(out[2]).toBe(c);
  });

  it('does not mutate the input list', () => {
    const base = [item(1)];
    mergeSorted(base, item(2), keyOf);
    expect(base.map(keyOf)).toEqual([1]);
  });

  it('inserting into an empty list yields a single-element list', () => {
    expect(mergeSorted([], item(1), keyOf).map(keyOf)).toEqual([1]);
  });

  it('replacing the only element keeps a single-element list', () => {
    const out = mergeSorted([item(1, 'a')], item(1, 'b'), keyOf);
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe('b');
  });

  it('handles duplicate keys already present by replacing the first match', () => {
    // Not expected in practice (keys are unique per the two real call sites),
    // but the algorithm must still terminate and not corrupt the list.
    const out = mergeSorted([item(1, 'a'), item(1, 'b')], item(1, 'c'), keyOf);
    expect(out.map((i) => i.tag)).toEqual(['c', 'b']);
  });

  it('works with a non-identity key function (e.g. blockOrdinal-style derivation)', () => {
    const ord = (s: string) => Number(s.slice(s.lastIndexOf(':') + 1));
    const out = mergeSorted(['a1:1', 'a1:3'], 'a1:2', ord);
    expect(out).toEqual(['a1:1', 'a1:2', 'a1:3']);
  });
});
