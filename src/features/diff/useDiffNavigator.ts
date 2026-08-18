import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { DiffFileSummary } from '../../../contract/diff-view';
import {
  buildDiffTree,
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
  type RollupState,
  type VisibleRow,
} from './diff-tree';

export interface DiffNavigator {
  visibleRows: VisibleRow[];
  filter: string;
  setFilter: (v: string) => void;
  filterInputRef: RefObject<HTMLInputElement>;
  cursorKey: string | null;
  toggleFold: (key: string) => void;
  rollup: (node: DiffTreeNode) => RollupState;
  hiddenChecked: number;
  onCursorUp: () => void;
  onCursorDown: () => void;
  onCursorRight: () => void;
  onCursorLeft: () => void;
  onCursorEnter: () => void;
}

/**
 * diff-navigator FR-4/5/9: folder fold state, filter query and the keyboard cursor
 * for the DIFF tab's tree. All frontend-only, in memory —
 * held per session because DiffView itself is keyed by sessionId in App, so this
 * hook's state is naturally reset by remount on session switch (spec §7).
 */
export function useDiffNavigator(params: {
  files: DiffFileSummary[];
  deselected: Set<string>;
  selectedPath: string | null;
  setSelectedPath: (path: string) => void;
}): DiffNavigator {
  const { files, deselected, selectedPath, setSelectedPath } = params;

  const tree = useMemo(() => buildDiffTree(files), [files]);
  const parentMap = useMemo(() => buildParentMap(tree), [tree]);

  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const visibleRows = useMemo(() => flattenVisibleRows(tree, folded, filter), [tree, folded, filter]);

  // Keep the cursor on a visible row: pick an initial one, and hop to the nearest
  // still-visible ancestor (or the first row) when a fold/filter change hides it
  // (spec §7 edge case).
  useEffect(() => {
    setCursorKey((prev) => {
      if (visibleRows.length === 0) return null;
      if (prev !== null) return resolveCursor(visibleRows, prev, parentMap);
      return selectedPath && visibleRows.some((row) => row.key === selectedPath) ? selectedPath : visibleRows[0]!.key;
    });
  }, [visibleRows, parentMap, selectedPath]);

  const toggleFold = useCallback((key: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const rollup = useCallback((node: DiffTreeNode) => folderRollup(node, deselected), [deselected]);
  const hiddenChecked = useMemo(() => hiddenCheckedCount(files, deselected, filter), [files, deselected, filter]);

  const onCursorUp = useCallback(() => {
    const next = moveCursor(visibleRows, cursorKey, -1);
    if (next !== cursorKey) setCursorKey(next);
  }, [visibleRows, cursorKey]);

  const onCursorDown = useCallback(() => {
    const next = moveCursor(visibleRows, cursorKey, 1);
    if (next !== cursorKey) setCursorKey(next);
  }, [visibleRows, cursorKey]);

  const onCursorRight = useCallback(() => {
    const res = stepRight(tree, folded, cursorKey);
    // res.folded is already a fresh Set instance whenever it differs from the input.
    if (res.folded !== folded) setFolded(res.folded as Set<string>);
    if (res.cursorKey !== cursorKey) setCursorKey(res.cursorKey);
  }, [tree, folded, cursorKey]);

  const onCursorLeft = useCallback(() => {
    const res = stepLeft(tree, folded, cursorKey, parentMap);
    if (res.folded !== folded) setFolded(res.folded as Set<string>);
    if (res.cursorKey !== cursorKey) setCursorKey(res.cursorKey);
  }, [tree, folded, cursorKey, parentMap]);

  const onCursorEnter = useCallback(() => {
    if (!cursorKey) return;
    const node = findNode(tree, cursorKey);
    if (!node) return;
    if (node.kind === 'file') setSelectedPath(node.file.path);
    else toggleFold(node.key);
  }, [tree, cursorKey, setSelectedPath, toggleFold]);

  return {
    visibleRows,
    filter,
    setFilter,
    filterInputRef,
    cursorKey,
    toggleFold,
    rollup,
    hiddenChecked,
    onCursorUp,
    onCursorDown,
    onCursorRight,
    onCursorLeft,
    onCursorEnter,
  };
}
