import { describe, expect, it } from 'vitest';
import type { DiffFileSummary } from '../../../contract/diff-view';
import {
  buildDiffTree,
  firstFilePathInTreeOrder,
  buildParentMap,
  findNode,
  flattenVisibleRows,
  folderRollup,
  hiddenCheckedCount,
  moveCursor,
  resolveCursor,
  stepLeft,
  stepRight,
  type DiffTreeNode,
} from './diff-tree';

function file(path: string, extra: Partial<DiffFileSummary> = {}): DiffFileSummary {
  const slash = path.lastIndexOf('/');
  return {
    path,
    dir: slash === -1 ? '' : path.slice(0, slash),
    name: slash === -1 ? path : path.slice(slash + 1),
    additions: 1,
    deletions: 0,
    status: 'modified',
    ...extra,
  };
}

describe('buildDiffTree', () => {
  it('chain-collapses a single-child folder chain into one row (FR-1/FR-2)', () => {
    const files = [file('src/features/diff/a.tsx'), file('src/features/diff/b.tsx')];
    const tree = buildDiffTree(files);
    expect(tree).toHaveLength(1);
    const folder = tree[0]!;
    expect(folder.kind).toBe('folder');
    if (folder.kind !== 'folder') throw new Error('unreachable');
    expect(folder.label).toBe('src/features/diff');
    expect(folder.key).toBe('src/features/diff');
    expect(folder.children.map((c) => c.key)).toEqual(['src/features/diff/a.tsx', 'src/features/diff/b.tsx']);
  });

  it('does not collapse a folder that has files of its own alongside a subfolder', () => {
    const files = [file('src/a.tsx'), file('src/sub/b.tsx')];
    const tree = buildDiffTree(files);
    expect(tree).toHaveLength(1);
    const src = tree[0]!;
    if (src.kind !== 'folder') throw new Error('unreachable');
    expect(src.label).toBe('src'); // not merged with `sub` — `src` also has a.tsx
    expect(src.children.map((c) => c.key)).toEqual(['src/sub', 'src/a.tsx']); // subfolders before files
  });

  it('degenerates to a flat file list at repo root (no empty root row)', () => {
    const files = [file('b.ts'), file('a.ts')];
    const tree = buildDiffTree(files);
    expect(tree.every((n) => n.kind === 'file')).toBe(true);
    expect(tree.map((n) => n.key)).toEqual(['a.ts', 'b.ts']); // alphabetical within a folder
  });

  it('sorts subfolders before files, each alphabetically', () => {
    const files = [file('z.ts'), file('a.ts'), file('mid/x.ts'), file('aaa/y.ts')];
    const tree = buildDiffTree(files);
    expect(tree.map((n) => n.key)).toEqual(['aaa', 'mid', 'a.ts', 'z.ts']);
  });
});

describe('flattenVisibleRows', () => {
  const files = [file('src/a/x.ts'), file('src/a/y.ts'), file('src/b.ts')];
  const tree = buildDiffTree(files);

  it('renders every row expanded with no fold state', () => {
    const rows = flattenVisibleRows(tree, new Set(), '');
    expect(rows.map((r) => r.key)).toEqual(['src', 'src/a', 'src/a/x.ts', 'src/a/y.ts', 'src/b.ts']);
  });

  it('hides a folded folder’s descendants but keeps the folder row (FR-6)', () => {
    const rows = flattenVisibleRows(tree, new Set(['src/a']), '');
    expect(rows.map((r) => r.key)).toEqual(['src', 'src/a', 'src/b.ts']);
    expect(rows.find((r) => r.key === 'src/a')!.expanded).toBe(false);
  });

  it('filters to matching files and their ancestor folders, force-expanding folders (FR-8/FR-9)', () => {
    const rows = flattenVisibleRows(tree, new Set(['src/a']), 'x.ts');
    expect(rows.map((r) => r.key)).toEqual(['src', 'src/a', 'src/a/x.ts']);
    expect(rows.find((r) => r.key === 'src/a')!.expanded).toBe(true); // folded set ignored while filtering
  });

  it('is case-insensitive substring matching against the full path, keeping the ancestor folder row', () => {
    const rows = flattenVisibleRows(tree, new Set(), 'SRC/B');
    expect(rows.map((r) => r.key)).toEqual(['src', 'src/b.ts']);
  });

  it('produces no rows when nothing matches', () => {
    const rows = flattenVisibleRows(tree, new Set(), 'nope');
    expect(rows).toHaveLength(0);
  });
});

describe('folderRollup', () => {
  const files = [file('src/a.ts'), file('src/b.ts')];
  const tree = buildDiffTree(files);
  const folder = tree[0]!;

  it('reads checked when no descendant is deselected', () => {
    expect(folderRollup(folder, new Set())).toBe('checked');
  });

  it('reads none when every descendant is deselected', () => {
    expect(folderRollup(folder, new Set(['src/a.ts', 'src/b.ts']))).toBe('none');
  });

  it('reads mixed when some but not all descendants are deselected', () => {
    expect(folderRollup(folder, new Set(['src/a.ts']))).toBe('mixed');
  });
});

describe('hiddenCheckedCount', () => {
  const files = [file('a.ts'), file('b.ts'), file('c.ts')];

  it('is zero with no filter', () => {
    expect(hiddenCheckedCount(files, new Set(), '')).toBe(0);
  });

  it('counts checked files hidden by the filter, ignoring already-unchecked ones', () => {
    // filter matches only 'a.ts'; 'b.ts' and 'c.ts' are hidden, but 'c.ts' is
    // already unchecked so it should not count toward the warning.
    expect(hiddenCheckedCount(files, new Set(['c.ts']), 'a.ts')).toBe(1);
  });
});

describe('keyboard traversal', () => {
  const files = [file('src/a/x.ts'), file('src/a/y.ts'), file('src/b.ts')];
  const tree = buildDiffTree(files);
  const parentMap = buildParentMap(tree);

  it('moveCursor steps through visible rows and clamps at the edges', () => {
    const rows = flattenVisibleRows(tree, new Set(), '');
    const keys = rows.map((r) => r.key);
    expect(moveCursor(rows, keys[0]!, -1)).toBe(keys[0]);
    expect(moveCursor(rows, keys[0]!, 1)).toBe(keys[1]);
    expect(moveCursor(rows, keys[keys.length - 1]!, 1)).toBe(keys[keys.length - 1]);
  });

  it('stepRight expands a collapsed folder without moving the cursor', () => {
    const res = stepRight(tree, new Set(['src/a']), 'src/a');
    expect(res.folded.has('src/a')).toBe(false);
    expect(res.cursorKey).toBe('src/a');
  });

  it('stepRight on an expanded folder moves the cursor to its first child', () => {
    const res = stepRight(tree, new Set(), 'src/a');
    expect(res.cursorKey).toBe('src/a/x.ts');
  });

  it('stepRight on a file is a no-op', () => {
    const res = stepRight(tree, new Set(), 'src/b.ts');
    expect(res.cursorKey).toBe('src/b.ts');
    expect(res.folded).toEqual(new Set());
  });

  it('stepLeft collapses an expanded folder', () => {
    const res = stepLeft(tree, new Set(), 'src/a', parentMap);
    expect(res.folded.has('src/a')).toBe(true);
    expect(res.cursorKey).toBe('src/a');
  });

  it('stepLeft on a collapsed folder or a file hops to the parent', () => {
    const onCollapsed = stepLeft(tree, new Set(['src/a']), 'src/a', parentMap);
    expect(onCollapsed.cursorKey).toBe('src');
    const onFile = stepLeft(tree, new Set(), 'src/a/x.ts', parentMap);
    expect(onFile.cursorKey).toBe('src/a');
  });

  it('stepLeft at the root is a no-op', () => {
    const res = stepLeft(tree, new Set(['src']), 'src', parentMap);
    expect(res.cursorKey).toBe('src');
  });

  it('resolveCursor keeps a still-visible cursor untouched', () => {
    const rows = flattenVisibleRows(tree, new Set(), '');
    expect(resolveCursor(rows, 'src/a/x.ts', parentMap)).toBe('src/a/x.ts');
  });

  it('resolveCursor walks up to the nearest visible ancestor when the cursor folds away', () => {
    const rows = flattenVisibleRows(tree, new Set(['src/a']), '');
    expect(resolveCursor(rows, 'src/a/x.ts', parentMap)).toBe('src/a');
  });

  it('resolveCursor falls back to the first visible row when no ancestor is visible', () => {
    const twoRoots = buildDiffTree([file('foo/x.ts'), file('bar/y.ts')]);
    const twoRootsParentMap = buildParentMap(twoRoots);
    // filtering to 'bar' hides the whole `foo/` subtree, including its ancestor —
    // the cursor's entire chain is gone, so it falls back to the first visible row.
    const rows = flattenVisibleRows(twoRoots, new Set(), 'bar');
    expect(resolveCursor(rows, 'foo/x.ts', twoRootsParentMap)).toBe(rows[0]!.key);
  });
});

describe('findNode', () => {
  it('finds a nested node by key', () => {
    const files = [file('src/a/x.ts')];
    const tree = buildDiffTree(files);
    const node = findNode(tree, 'src/a/x.ts') as DiffTreeNode & { kind: 'file' };
    expect(node.kind).toBe('file');
    expect(node.file.path).toBe('src/a/x.ts');
  });

  it('returns null for an unknown key', () => {
    expect(findNode(buildDiffTree([file('a.ts')]), 'nope')).toBeNull();
  });
});

describe('firstFilePathInTreeOrder', () => {
  it('picks the first file in TREE order, not path order', () => {
    // subfolders render before same-level files, so `z/x.ts` is the first row
    expect(firstFilePathInTreeOrder([file('a.ts'), file('z/x.ts')])).toBe('z/x.ts');
  });

  it('descends through chain-collapsed folders', () => {
    expect(firstFilePathInTreeOrder([file('src/features/diff/b.ts'), file('r.ts')])).toBe('src/features/diff/b.ts');
  });

  it('falls back to the sole root file when there are no folders', () => {
    expect(firstFilePathInTreeOrder([file('b.ts'), file('a.ts')])).toBe('a.ts');
  });

  it('returns null for an empty changeset', () => {
    expect(firstFilePathInTreeOrder([])).toBeNull();
  });
});
