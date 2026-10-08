// The explorer tree (code-editor FR-4/FR-5, flow 3), built in the frontend from
// `editor_files`' flat path list. Directories are derived from the paths — so an
// empty dir never shows — and come before files, each group sorted case-insensitively.

import type { GitChange } from '../../../contract/code-editor';

export interface TreeNode {
  name: string;
  /** Root-relative, '/'-separated. */
  path: string;
  kind: 'dir' | 'file';
  children?: TreeNode[];
}

export interface TreeRow {
  path: string;
  name: string;
  depth: number;
  kind: 'dir' | 'file';
  /** Dirs only. */
  expanded: boolean;
  /** Files only: the porcelain letter. */
  change?: GitChange;
  /** Dirs only: some descendant changed (the info dot). */
  changed: boolean;
}

const byName = (a: TreeNode, b: TreeNode) => {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

export function buildTree(paths: readonly string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'dir', children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);
  for (const path of paths) {
    const parts = path.split('/');
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join('/');
      let dir = dirs.get(dirPath);
      if (!dir) {
        dir = { name: parts[i], path: dirPath, kind: 'dir', children: [] };
        dirs.set(dirPath, dir);
        parent.children!.push(dir);
      }
      parent = dir;
    }
    parent.children!.push({ name: parts[parts.length - 1], path, kind: 'file' });
  }
  for (const dir of dirs.values()) dir.children!.sort(byName);
  return root.children!;
}

/** The dirs to expand so that `path` is visible. */
export function ancestorDirs(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** FR-5: every dir with a changed descendant. */
export function changedDirs(changes: Record<string, GitChange>): Set<string> {
  const out = new Set<string>();
  for (const path of Object.keys(changes)) for (const dir of ancestorDirs(path)) out.add(dir);
  return out;
}

export function visibleRows(tree: readonly TreeNode[], expanded: ReadonlySet<string>, changes: Record<string, GitChange>): TreeRow[] {
  const dots = changedDirs(changes);
  const rows: TreeRow[] = [];
  const walk = (nodes: readonly TreeNode[], depth: number) => {
    for (const n of nodes) {
      const open = n.kind === 'dir' && expanded.has(n.path);
      rows.push({
        path: n.path,
        name: n.name,
        depth,
        kind: n.kind,
        expanded: open,
        change: n.kind === 'file' ? changes[n.path] : undefined,
        changed: n.kind === 'dir' && dots.has(n.path),
      });
      if (open) walk(n.children!, depth + 1);
    }
  };
  walk(tree, 0);
  return rows;
}

export type TreeKeyAction =
  | { kind: 'select'; path: string }
  | { kind: 'expand'; path: string }
  | { kind: 'collapse'; path: string }
  | { kind: 'open'; path: string };

/** Flow 3: what a key does on the explorer's selected row. */
export function treeKeyAction(rows: readonly TreeRow[], selected: string | null, key: string): TreeKeyAction | null {
  if (rows.length === 0) return null;
  const i = selected === null ? -1 : rows.findIndex((r) => r.path === selected);
  const row = i >= 0 ? rows[i] : null;
  switch (key) {
    case 'ArrowDown':
      return { kind: 'select', path: rows[Math.min(i + 1, rows.length - 1)].path };
    case 'ArrowUp':
      return { kind: 'select', path: rows[Math.max(i - 1, 0)].path };
    case 'ArrowRight':
      if (!row || row.kind !== 'dir') return null;
      if (!row.expanded) return { kind: 'expand', path: row.path };
      return rows[i + 1] && rows[i + 1].depth > row.depth ? { kind: 'select', path: rows[i + 1].path } : null;
    case 'ArrowLeft': {
      if (!row) return null;
      if (row.kind === 'dir' && row.expanded) return { kind: 'collapse', path: row.path };
      const parent = ancestorDirs(row.path).pop();
      return parent ? { kind: 'select', path: parent } : null;
    }
    case 'Enter':
      if (!row) return null;
      if (row.kind === 'file') return { kind: 'open', path: row.path };
      return { kind: row.expanded ? 'collapse' : 'expand', path: row.path };
    default:
      return null;
  }
}
