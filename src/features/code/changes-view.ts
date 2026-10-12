// The Source control sidebar's rows: one per changed path from `editor_files`'
// `changes`, modified before added, each group in path order.

import type { GitChange } from '../../../contract/code-editor';

export interface ChangeRow {
  path: string;
  name: string;
  /** The parent directory, '' at the root. */
  dir: string;
  change: GitChange;
}

export function changeRows(changes: Record<string, GitChange>): ChangeRow[] {
  return Object.entries(changes)
    .map(([path, change]) => {
      const cut = path.lastIndexOf('/');
      return { path, change, name: path.slice(cut + 1), dir: cut > 0 ? path.slice(0, cut) : '' };
    })
    .sort((a, b) => (a.change === b.change ? a.path.localeCompare(b.path) : a.change === 'M' ? -1 : 1));
}
