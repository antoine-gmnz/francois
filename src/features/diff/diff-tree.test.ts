import { describe, expect, it } from 'vitest';
import type { DiffFileSummary } from '../../../contract/diff-view';
import {
  buildDiffTree,
  buildParentMap,
  descendantFileCount,
  descendantFilePaths,
  findNode,
  firstFilePathInTreeOrder,
  flattenFlatRows,
  flattenVisibleRows,
  folderRollup,
  hiddenCheckedCount,
  moveCursor,
  resolveCursor,
  stepLeft,
  stepRight,
  treeOrderFiles,
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
  it('chain-collapses a single-child folder chain into one row (FR-5)', () => {
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

describe('descendantFilePaths / descendantFileCount (FR-6/FR-7)', () => {
  const files = [file('src/features/diff/a.tsx'), file('src/features/diff/b.tsx'), file('src/features/diff/c.tsx')];
  const tree = buildDiffTree(files);
  const folder = tree[0]!;

  it('lists every descendant file path, never a +/- sum', () => {
    expect(descendantFilePaths(folder)).toEqual(['src/features/diff/a.tsx', 'src/features/diff/b.tsx', 'src/features/diff/c.tsx']);
  });

  it('counts descendant files', () => {
    expect(descendantFileCount(folder)).toBe(3);
  });

  it('a file node reports itself as its own single-element descendant set', () => {
    const fileNode = findNode(tree, 'src/features/diff/a.tsx')!;
    expect(descendantFilePaths(fileNode)).toEqual(['src/features/diff/a.tsx']);
  });
});

describe('flattenVisibleRows', () => {
  const files = [file('src/a/x.ts'), file('src/a/y.ts'), file('src/b.ts')];
  const tree = buildDiffTree(files);

  it('renders every row expanded with no fold state', () => {
    const rows = flattenVisibleRows(tree, new Set(), '');
    expect(rows.map((r) => r.key)).toEqual(['src', 'src/a', 'src/a/x.ts', 'src/a/y.ts', 'src/b.ts']);
  });

  it('hides a folded folder’s descendants but keeps the folder row (FR-10)', () => {
    const rows = flattenVisibleRows(tree, new Set(['src/a']), '');
    expect(rows.map((r) => r.key)).toEqual(['src', 'src/a', 'src/b.ts']);
    expect(rows.find((r) => r.key === 'src/a')!.expanded).toBe(false);
  });

  it('filters to matching files and their ancestor folders, force-expanding folders (FR-12)', () => {
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

describe('flattenFlatRows (FR-9)', () => {
  const files = [file('src/a/x.ts'), file('src/a/y.ts'), file('src/b.ts')];

  it('lists every file with no folder rows, in path order', () => {
    const rows = flattenFlatRows(files, '');
    expect(rows.map((r) => r.key)).toEqual(['src/a/x.ts', 'src/a/y.ts', 'src/b.ts']);
    expect(rows.every((r) => r.node.kind === 'file')).toBe(true);
  });

  it('filters the same way as the tree — case-insensitive substring on the full path', () => {
    const rows = flattenFlatRows(files, 'Y.TS');
    expect(rows.map((r) => r.key)).toEqual(['src/a/y.ts']);
  });
});

describe('folderRollup (FR-7 — checked = path IS in inCommit)', () => {
  const files = [file('src/a.ts'), file('src/b.ts')];
  const tree = buildDiffTree(files);
  const folder = tree[0]!;

  it('reads checked when every descendant is in inCommit', () => {
    expect(folderRollup(folder, new Set(['src/a.ts', 'src/b.ts']))).toBe('checked');
  });

  it('reads none when no descendant is in inCommit', () => {
    expect(folderRollup(folder, new Set())).toBe('none');
  });

  it('reads mixed when some but not all descendants are in inCommit', () => {
    expect(folderRollup(folder, new Set(['src/a.ts']))).toBe('mixed');
  });
});

describe('hiddenCheckedCount', () => {
  const files = [file('a.ts'), file('b.ts'), file('c.ts')];

  it('is zero with no filter', () => {
    expect(hiddenCheckedCount(files, new Set(['a.ts', 'b.ts', 'c.ts']), '')).toBe(0);
  });

  it('counts checked files hidden by the filter, ignoring already-unchecked ones', () => {
    // filter matches only 'a.ts'; 'b.ts' and 'c.ts' are hidden, but 'c.ts' is not
    // checked so it should not count toward the note.
    expect(hiddenCheckedCount(files, new Set(['a.ts', 'b.ts']), 'a.ts')).toBe(1);
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

describe('treeOrderFiles / firstFilePathInTreeOrder (FR-24)', () => {
  it('lists every file in DFS tree order, subfolders before same-level files', () => {
    expect(treeOrderFiles([file('a.ts'), file('z/x.ts')]).map((f) => f.path)).toEqual(['z/x.ts', 'a.ts']);
  });

  it('descends through chain-collapsed folders', () => {
    expect(treeOrderFiles([file('src/features/diff/b.ts'), file('r.ts')]).map((f) => f.path)).toEqual(['src/features/diff/b.ts', 'r.ts']);
  });

  it('firstFilePathInTreeOrder picks the first file in TREE order, not path order', () => {
    expect(firstFilePathInTreeOrder([file('a.ts'), file('z/x.ts')])).toBe('z/x.ts');
  });

  it('firstFilePathInTreeOrder falls back to the sole root file when there are no folders', () => {
    expect(firstFilePathInTreeOrder([file('b.ts'), file('a.ts')])).toBe('a.ts');
  });

  it('firstFilePathInTreeOrder returns null for an empty changeset', () => {
    expect(firstFilePathInTreeOrder([])).toBeNull();
  });
});
