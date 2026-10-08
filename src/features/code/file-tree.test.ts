import { describe, expect, it } from 'vitest';
import { ancestorDirs, buildTree, changedDirs, treeKeyAction, visibleRows } from './file-tree';

const PATHS = ['src/b.ts', 'README.md', 'src/lib/x.ts', 'a.txt', 'Src2/z.ts', 'src/A.ts'];

describe('buildTree (FR-4)', () => {
  it('derives dirs from paths, dirs first, each group sorted case-insensitively', () => {
    const tree = buildTree(PATHS);
    expect(tree.map((n) => n.name)).toEqual(['src', 'Src2', 'a.txt', 'README.md']);
    const src = tree[0];
    expect(src.kind).toBe('dir');
    expect(src.children!.map((n) => n.name)).toEqual(['lib', 'A.ts', 'b.ts']);
    expect(src.children![0].children![0].path).toBe('src/lib/x.ts');
  });

  it('shows no empty dirs (nothing to derive them from)', () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe('changedDirs (FR-5)', () => {
  it('marks every ancestor of a changed path', () => {
    expect([...changedDirs({ 'src/lib/x.ts': 'M', 'a.txt': 'A' })].sort()).toEqual(['src', 'src/lib']);
  });
});

describe('visibleRows', () => {
  it('lists only the expanded subtrees, with depth, status letters and folder dots', () => {
    const rows = visibleRows(buildTree(PATHS), new Set(['src']), { 'src/lib/x.ts': 'M', 'src/A.ts': 'A' });
    expect(rows.map((r) => [r.path, r.depth])).toEqual([
      ['src', 0],
      ['src/lib', 1],
      ['src/A.ts', 1],
      ['src/b.ts', 1],
      ['Src2', 0],
      ['a.txt', 0],
      ['README.md', 0],
    ]);
    expect(rows.find((r) => r.path === 'src')).toMatchObject({ expanded: true, changed: true });
    expect(rows.find((r) => r.path === 'src/lib')).toMatchObject({ expanded: false, changed: true });
    expect(rows.find((r) => r.path === 'src/A.ts')?.change).toBe('A');
    expect(rows.find((r) => r.path === 'Src2')?.changed).toBe(false);
  });
});

describe('ancestorDirs', () => {
  it('lists the dirs to expand to reveal a path', () => {
    expect(ancestorDirs('src/lib/x.ts')).toEqual(['src', 'src/lib']);
    expect(ancestorDirs('a.txt')).toEqual([]);
  });
});

describe('treeKeyAction (flow 3)', () => {
  const tree = buildTree(PATHS);
  const rows = visibleRows(tree, new Set(['src']), {});

  it('moves the selection with ↑/↓ and clamps at the ends', () => {
    expect(treeKeyAction(rows, 'src', 'ArrowDown')).toEqual({ kind: 'select', path: 'src/lib' });
    expect(treeKeyAction(rows, 'src', 'ArrowUp')).toEqual({ kind: 'select', path: 'src' });
    expect(treeKeyAction(rows, null, 'ArrowDown')).toEqual({ kind: 'select', path: 'src' });
  });

  it('→ expands a collapsed dir, then steps into it', () => {
    expect(treeKeyAction(rows, 'src/lib', 'ArrowRight')).toEqual({ kind: 'expand', path: 'src/lib' });
    expect(treeKeyAction(rows, 'src', 'ArrowRight')).toEqual({ kind: 'select', path: 'src/lib' });
  });

  it('← collapses an expanded dir, else selects the parent', () => {
    expect(treeKeyAction(rows, 'src', 'ArrowLeft')).toEqual({ kind: 'collapse', path: 'src' });
    expect(treeKeyAction(rows, 'src/b.ts', 'ArrowLeft')).toEqual({ kind: 'select', path: 'src' });
  });

  it('⏎ opens a file and toggles a dir', () => {
    expect(treeKeyAction(rows, 'src/b.ts', 'Enter')).toEqual({ kind: 'open', path: 'src/b.ts' });
    expect(treeKeyAction(rows, 'src', 'Enter')).toEqual({ kind: 'collapse', path: 'src' });
    expect(treeKeyAction(rows, 'Src2', 'Enter')).toEqual({ kind: 'expand', path: 'Src2' });
  });

  it('ignores other keys', () => {
    expect(treeKeyAction(rows, 'src', 'x')).toBeNull();
  });
});
