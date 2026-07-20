import { describe, it, expect } from 'vitest';
import { filterRank, subsequenceMatchPos } from './palette';

describe('subsequenceMatchPos', () => {
  it('returns the index where the first query char is greedily consumed', () => {
    expect(subsequenceMatchPos('diff', 'view diff')).toBe(5); // 'd' at index 5
    expect(subsequenceMatchPos('vd', 'view diff')).toBe(0); // 'v' at 0
    expect(subsequenceMatchPos('sm', 'switch model')).toBe(0);
  });
  it('returns -1 when the query is not an ordered subsequence', () => {
    expect(subsequenceMatchPos('zzz', 'view diff')).toBe(-1);
    expect(subsequenceMatchPos('ffd', 'view diff')).toBe(-1); // order matters
  });
});

describe('filterRank', () => {
  const items = [{ name: 'New session' }, { name: 'Switch model' }, { name: 'View diff' }, { name: 'New agent' }];
  const key = (x: { name: string }) => x.name;

  it('returns input order for an empty query', () => {
    expect(filterRank(items, '', key).map(key)).toEqual(items.map(key));
  });
  it('ranks by match position, breaking ties alphabetically (code-point order)', () => {
    // "new" matches "New session" and "New agent" both at position 0 → alpha: agent < session
    expect(filterRank(items, 'new', key).map(key)).toEqual(['New agent', 'New session']);
  });
  it('matches non-contiguous subsequences', () => {
    expect(filterRank(items, 'diff', key).map(key)).toEqual(['View diff']);
  });
  it('is case-insensitive and returns [] when nothing matches', () => {
    expect(filterRank(items, 'SWITCH', key).map(key)).toEqual(['Switch model']);
    expect(filterRank(items, 'zzz', key)).toEqual([]);
  });
});
