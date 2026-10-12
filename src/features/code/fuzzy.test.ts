import { describe, expect, it } from 'vitest';
import { fuzzyMatch } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches a subsequence, case-insensitively, returning the matched indices', () => {
    expect(fuzzyMatch('cb', 'src/callback.ts')?.indices).toEqual([4, 8]);
    expect(fuzzyMatch('CB', 'src/callback.ts')).not.toBeNull();
  });
  it('rejects a non-subsequence', () => {
    expect(fuzzyMatch('zz', 'src/callback.ts')).toBeNull();
  });
  it('prefers a basename hit over a directory hit', () => {
    const inName = fuzzyMatch('auth', 'src/auth.ts')!.score;
    const inDir = fuzzyMatch('auth', 'auth/src/index.ts')!.score;
    expect(inName).toBeGreaterThan(inDir);
  });
  it('prefers consecutive characters', () => {
    expect(fuzzyMatch('call', 'src/callback.ts')!.score).toBeGreaterThan(fuzzyMatch('call', 'src/c_a_l_l.ts')!.score);
  });
});
