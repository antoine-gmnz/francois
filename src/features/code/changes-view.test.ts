import { describe, expect, it } from 'vitest';
import { changeRows } from './changes-view';

describe('changeRows', () => {
  it('lists modified paths before added ones, each in path order', () => {
    const rows = changeRows({ 'b.ts': 'A', 'src/z.ts': 'M', 'a.ts': 'A', 'src/a.ts': 'M' });
    expect(rows.map((r) => r.path)).toEqual(['src/a.ts', 'src/z.ts', 'a.ts', 'b.ts']);
  });

  it('splits the name from its directory', () => {
    expect(changeRows({ 'services/auth/callback.ts': 'M', 'README.md': 'A' })).toEqual([
      { path: 'services/auth/callback.ts', name: 'callback.ts', dir: 'services/auth', change: 'M' },
      { path: 'README.md', name: 'README.md', dir: '', change: 'A' },
    ]);
  });

  it('is empty for a clean tree', () => {
    expect(changeRows({})).toEqual([]);
  });
});
