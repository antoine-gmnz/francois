// diff-review FR-5..FR-12: pure tree build + flatten + traversal + roll-up helpers,
// superseding diff-navigator FR-5 (display-only rollup) per FR-7. Frontend-internal
// types only (spec §5) — DiffTreeNode lives here, not in contract/diff-view.ts, since
// nothing here crosses IPC.

import type { DiffFileSummary } from '../../../contract/diff-view';

export type DiffTreeNode =
  | { kind: 'folder'; key: string; label: string; children: DiffTreeNode[] }
  | { kind: 'file'; key: string; file: DiffFileSummary };

interface RawFolder {
  folders: Map<string, RawFolder>;
  files: DiffFileSummary[];
}

/** FR-5: build the folder tree from DiffSummary.files (already path-sorted),
 *  chain-collapsing single-child folder runs into one row. Subfolders sort before
 *  files, each alphabetically, within a folder. */
export function buildDiffTree(files: DiffFileSummary[]): DiffTreeNode[] {
  const root: RawFolder = { folders: new Map(), files: [] };
  for (const file of files) {
    const segments = file.dir === '' ? [] : file.dir.split('/');
    let node = root;
    for (const seg of segments) {
      let child = node.folders.get(seg);
      if (!child) {
        child = { folders: new Map(), files: [] };
        node.folders.set(seg, child);
      }
      node = child;
    }
    node.files.push(file);
  }
  return toNodes(root, '');
}

function toNodes(folder: RawFolder, pathPrefix: string): DiffTreeNode[] {
  const folderNames = [...folder.folders.keys()].sort((a, b) => a.localeCompare(b));
  const folderNodes = folderNames.map((name) => collapseFolder(name, folder.folders.get(name)!, pathPrefix));
  const fileNodes: DiffTreeNode[] = folder.files
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((file) => ({ kind: 'file', key: file.path, file }) as const);
  return [...folderNodes, ...fileNodes];
}

/** The path of the first FILE in tree order — which is not `files[0]`, because
 *  subfolders sort before same-level files (`['a.ts', 'z/x.ts']` renders `z/x.ts`
 *  first). Used to seed the rail's initial keyboard cursor. */
export function firstFilePathInTreeOrder(files: DiffFileSummary[]): string | null {
  const all = treeOrderFiles(files);
  return all.length > 0 ? all[0]!.path : null;
}

/** FR-24: the body's order is the tree's — a DFS walk of the FULL tree, ignoring
 *  fold state and the filter (those are rail-only navigation, spec §"body"). */
export function treeOrderFiles(files: DiffFileSummary[]): DiffFileSummary[] {
  const out: DiffFileSummary[] = [];
  const walk = (nodes: DiffTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'file') out.push(node.file);
      else walk(node.children);
    }
  };
  walk(buildDiffTree(files));
  return out;
}

function collapseFolder(name: string, folder: RawFolder, pathPrefix: string): DiffTreeNode {
  let label = name;
  let key = pathPrefix ? `${pathPrefix}/${name}` : name;
  let cur = folder;
  // FR-5: a folder whose only child is a folder (no files of its own) merges with
  // that child, applied transitively for an arbitrarily deep chain.
  while (cur.files.length === 0 && cur.folders.size === 1) {
    const [childName, child] = [...cur.folders.entries()][0]!;
    label = `${label}/${childName}`;
    key = `${key}/${childName}`;
    cur = child;
  }
  return { kind: 'folder', key, label, children: toNodes(cur, key) };
}

/** Full-tree parent lookup (independent of fold/filter visibility), used by keyboard
 *  traversal to hop from a row to its parent folder row (FR-40). */
export function buildParentMap(tree: DiffTreeNode[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const walk = (nodes: DiffTreeNode[], parent: string | null) => {
    for (const node of nodes) {
      map.set(node.key, parent);
      if (node.kind === 'folder') walk(node.children, node.key);
    }
  };
  walk(tree, null);
  return map;
}

export function findNode(nodes: DiffTreeNode[], key: string): DiffTreeNode | null {
  for (const node of nodes) {
    if (node.key === key) return node;
    if (node.kind === 'folder') {
      const found = findNode(node.children, key);
      if (found) return found;
    }
  }
  return null;
}

/** FR-7: every file path under a node — the write set for a directory checkbox. */
export function descendantFilePaths(node: DiffTreeNode): string[] {
  if (node.kind === 'file') return [node.file.path];
  const out: string[] = [];
  const walk = (n: DiffTreeNode) => {
    if (n.kind === 'file') out.push(n.file.path);
    else n.children.forEach(walk);
  };
  node.children.forEach(walk);
  return out;
}

/** FR-6: a directory row's count is its descendant FILE count — never a +/- sum. */
export function descendantFileCount(node: DiffTreeNode): number {
  return descendantFilePaths(node).length;
}

export interface VisibleRow {
  key: string;
  depth: number;
  node: DiffTreeNode;
  /** Only meaningful for folder rows. */
  expanded: boolean;
}

/** FR-8/FR-10/FR-12: single source for both rendering and keyboard traversal —
 *  folder fold state x filter text flattened into the visible row order. While the
 *  filter is non-empty, fold state is ignored and every visible folder renders
 *  expanded. */
export function flattenVisibleRows(tree: DiffTreeNode[], folded: ReadonlySet<string>, filter: string): VisibleRow[] {
  const query = filter.trim().toLowerCase();
  const filtering = query.length > 0;
  const rows: VisibleRow[] = [];

  const matches = (node: DiffTreeNode): boolean =>
    node.kind === 'file' ? node.file.path.toLowerCase().includes(query) : node.children.some(matches);

  const walk = (nodes: DiffTreeNode[], depth: number) => {
    for (const node of nodes) {
      if (filtering && !matches(node)) continue;
      if (node.kind === 'file') {
        rows.push({ key: node.key, depth, node, expanded: false });
      } else {
        const expanded = filtering ? true : !folded.has(node.key);
        rows.push({ key: node.key, depth, node, expanded });
        if (expanded) walk(node.children, depth + 1);
      }
    }
  };
  walk(tree, 0);
  return rows;
}

/** FR-9: flat mode — diff-navigator's list without folders, same file rows, in
 *  path order, filtered the same way as the tree. */
export function flattenFlatRows(files: DiffFileSummary[], filter: string): VisibleRow[] {
  const query = filter.trim().toLowerCase();
  const filtered = query === '' ? files : files.filter((f) => f.path.toLowerCase().includes(query));
  return filtered.map((file) => ({ key: file.path, depth: 0, node: { kind: 'file', key: file.path, file }, expanded: false }));
}

export type RollupState = 'checked' | 'mixed' | 'none';

/** FR-7: tri-state roll-up mark for a directory row, from its descendant files'
 *  `inCommit` membership (checked = path IS in the set). */
export function folderRollup(node: DiffTreeNode, inCommit: ReadonlySet<string>): RollupState {
  let anyChecked = false;
  let anyUnchecked = false;
  const walk = (n: DiffTreeNode) => {
    if (n.kind === 'file') {
      if (inCommit.has(n.file.path)) anyChecked = true;
      else anyUnchecked = true;
    } else {
      n.children.forEach(walk);
    }
  };
  walk(node);
  if (anyChecked && anyUnchecked) return 'mixed';
  if (anyChecked) return 'checked';
  return 'none';
}

/** diff-navigator FR-25/FR-26 (carried over, spec §7 "Filter hides checked files"):
 *  checked files hidden by an active filter, for the commit form's note. */
export function hiddenCheckedCount(files: DiffFileSummary[], inCommit: ReadonlySet<string>, filter: string): number {
  const query = filter.trim().toLowerCase();
  if (!query) return 0;
  let hidden = 0;
  for (const file of files) {
    if (!inCommit.has(file.path)) continue;
    if (!file.path.toLowerCase().includes(query)) hidden++;
  }
  return hidden;
}

/** FR-40: up/down move the cursor one visible row; clamped at the edges (no wrap). */
export function moveCursor(rows: VisibleRow[], cursorKey: string | null, dir: 1 | -1): string | null {
  if (rows.length === 0) return null;
  const idx = rows.findIndex((row) => row.key === cursorKey);
  if (idx === -1) return rows[0]!.key;
  const next = idx + dir;
  if (next < 0 || next >= rows.length) return cursorKey;
  return rows[next]!.key;
}

export interface StepResult {
  folded: ReadonlySet<string>;
  cursorKey: string | null;
}

/** FR-40: right expands a collapsed folder; on an expanded folder moves to its
 *  first child; on a file, no-op. */
export function stepRight(tree: DiffTreeNode[], folded: ReadonlySet<string>, cursorKey: string | null): StepResult {
  if (!cursorKey) return { folded, cursorKey };
  const node = findNode(tree, cursorKey);
  if (!node || node.kind === 'file') return { folded, cursorKey };
  if (folded.has(node.key)) {
    const next = new Set(folded);
    next.delete(node.key);
    return { folded: next, cursorKey };
  }
  if (node.children.length > 0) return { folded, cursorKey: node.children[0]!.key };
  return { folded, cursorKey };
}

/** FR-40: left collapses an expanded folder; on a collapsed folder or a file, hops
 *  the cursor to its parent folder row (no-op at the root). */
export function stepLeft(
  tree: DiffTreeNode[],
  folded: ReadonlySet<string>,
  cursorKey: string | null,
  parentMap: ReadonlyMap<string, string | null>,
): StepResult {
  if (!cursorKey) return { folded, cursorKey };
  const node = findNode(tree, cursorKey);
  if (node && node.kind === 'folder' && !folded.has(node.key)) {
    const next = new Set(folded);
    next.add(node.key);
    return { folded: next, cursorKey };
  }
  const parent = parentMap.get(cursorKey) ?? null;
  return { folded, cursorKey: parent ?? cursorKey };
}

/** Edge case (spec §7): a cursor row that becomes invisible (its folder collapsed,
 *  or hidden by a filter) moves to the nearest still-visible ancestor, or to the
 *  first visible row if there is none. */
export function resolveCursor(
  rows: VisibleRow[],
  cursorKey: string | null,
  parentMap: ReadonlyMap<string, string | null>,
): string | null {
  if (rows.length === 0) return null;
  if (cursorKey !== null && rows.some((row) => row.key === cursorKey)) return cursorKey;
  let key = cursorKey !== null ? (parentMap.get(cursorKey) ?? null) : null;
  while (key !== null) {
    if (rows.some((row) => row.key === key)) return key;
    key = parentMap.get(key) ?? null;
  }
  return rows[0]!.key;
}
