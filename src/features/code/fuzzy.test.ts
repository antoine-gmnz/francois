import { describe, expect, it } from 'vitest';
import { fuzzyMatch, rankPaths } from './fuzzy';

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

describe('rankPaths (flow 5)', () => {
  const paths = ['src/a.ts', 'src/callback.ts', 'lib/call.ts', 'README.md'];
  it('lists recent files first on an empty query, then the rest in order', () => {
    const r = rankPaths(paths, '', ['README.md', 'gone.ts'], 10);
    expect(r.recent).toEqual(['README.md']);
    expect(r.items.map((i) => i.path)).toEqual(['README.md', 'src/a.ts', 'src/callback.ts', 'lib/call.ts']);
  });
  it('ranks by score and floats recent files up on near-ties', () => {
    expect(rankPaths(paths, 'call', [], 10).items[0].path).toBe('lib/call.ts');
    const r = rankPaths(paths, 'call', ['src/callback.ts'], 10);
    expect(r.items[0].path).toBe('src/callback.ts');
    expect(r.items.map((i) => i.path)).toContain('src/callback.ts');
    expect(r.items.every((i) => i.indices.length === 4)).toBe(true);
  });
  it('honours the limit', () => {
    expect(rankPaths(paths, '', [], 2).items).toHaveLength(2);
  });
});
