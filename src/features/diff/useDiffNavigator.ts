import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Dispatch, RefObject } from 'react';
import type { DiffFileSummary } from '../../../contract/diff-view';
import type { DiffUiAction } from './diff-state';
import {
  buildDiffTree,
  buildParentMap,
  descendantFilePaths,
  findNode,
  flattenFlatRows,
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
  filterInputRef: RefObject<HTMLInputElement>;
  rollup: (node: DiffTreeNode) => RollupState;
  hiddenChecked: number;
  onCursorUp: () => void;
  onCursorDown: () => void;
  onCursorRight: () => void;
  onCursorLeft: () => void;
  onCursorEnter: () => void;
  onCursorSpace: () => void;
}

/**
 * diff-review FR-5..FR-12, FR-40: the rail's tree/flat rows, filter, fold state and
 * keyboard cursor. Selection state (folded/filter/cursorKey/railMode) lives in the
 * DiffUiState reducer (diff-state.ts) — this hook only derives the visible rows and
 * wires the traversal callbacks, dispatching actions rather than holding state
 * itself (spec §6: one state, two views).
 */
export function useDiffNavigator(params: {
  files: DiffFileSummary[];
  inCommit: Set<string>;
  folded: Set<string>;
  filter: string;
  railMode: 'tree' | 'flat';
  cursorKey: string | null;
  dispatch: Dispatch<DiffUiAction>;
  /** FR-8: clicking/entering a file row jumps the body to it — never a selection. */
  onJumpToFile: (path: string) => void;
}): DiffNavigator {
  const { files, inCommit, folded, filter, railMode, cursorKey, dispatch, onJumpToFile } = params;

  const tree = useMemo(() => buildDiffTree(files), [files]);
  const parentMap = useMemo(() => buildParentMap(tree), [tree]);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const visibleRows = useMemo(
    () => (railMode === 'tree' ? flattenVisibleRows(tree, folded, filter) : flattenFlatRows(files, filter)),
    [railMode, tree, folded, filter, files],
  );

  // Keep the cursor on a visible row: hop to the nearest still-visible ancestor (tree
  // mode) or fall back to the first row, whenever a fold/filter/mode change hides it.
  useEffect(() => {
    if (visibleRows.length === 0) {
      if (cursorKey !== null) dispatch({ type: 'setCursor', key: null });
      return;
    }
    const next = railMode === 'tree' ? resolveCursor(visibleRows, cursorKey, parentMap) : (visibleRows.find((r) => r.key === cursorKey)?.key ?? visibleRows[0]!.key);
    if (next !== cursorKey) dispatch({ type: 'setCursor', key: next });
  }, [visibleRows, parentMap, cursorKey, railMode, dispatch]);

  const rollup = useCallback((node: DiffTreeNode) => folderRollup(node, inCommit), [inCommit]);
  const hiddenChecked = useMemo(() => hiddenCheckedCount(files, inCommit, filter), [files, inCommit, filter]);

  const onCursorUp = useCallback(() => {
    const next = moveCursor(visibleRows, cursorKey, -1);
    if (next !== cursorKey) dispatch({ type: 'setCursor', key: next });
  }, [visibleRows, cursorKey, dispatch]);

  const onCursorDown = useCallback(() => {
    const next = moveCursor(visibleRows, cursorKey, 1);
    if (next !== cursorKey) dispatch({ type: 'setCursor', key: next });
  }, [visibleRows, cursorKey, dispatch]);

  // stepRight/stepLeft only ever flip the CURSOR's own folder key (never another
  // row's), so `toggleFold` reproduces exactly what each returns.
  const onCursorRight = useCallback(() => {
    if (railMode !== 'tree') return; // no folders to expand in flat mode
    const res = stepRight(tree, folded, cursorKey);
    if (res.folded !== folded) dispatch({ type: 'toggleFold', key: cursorKey! });
    if (res.cursorKey !== cursorKey) dispatch({ type: 'setCursor', key: res.cursorKey });
  }, [railMode, tree, folded, cursorKey, dispatch]);

  const onCursorLeft = useCallback(() => {
    if (railMode !== 'tree') return;
    const res = stepLeft(tree, folded, cursorKey, parentMap);
    if (res.folded !== folded) dispatch({ type: 'toggleFold', key: cursorKey! });
    if (res.cursorKey !== cursorKey) dispatch({ type: 'setCursor', key: res.cursorKey });
  }, [railMode, tree, folded, cursorKey, parentMap, dispatch]);

  const onCursorEnter = useCallback(() => {
    if (!cursorKey) return;
    if (railMode === 'flat') {
      onJumpToFile(cursorKey); // flat rows are keyed by path
      return;
    }
    const node = findNode(tree, cursorKey);
    if (!node) return;
    if (node.kind === 'file') onJumpToFile(node.file.path);
    else dispatch({ type: 'toggleFold', key: node.key });
  }, [railMode, tree, cursorKey, dispatch, onJumpToFile]);

  const onCursorSpace = useCallback(() => {
    if (!cursorKey) return;
    const node = railMode === 'tree' ? findNode(tree, cursorKey) : ({ kind: 'file', key: cursorKey, file: files.find((f) => f.path === cursorKey)! } as DiffTreeNode);
    if (!node) return;
    if (node.kind === 'file') {
      dispatch({ type: 'toggleInCommit', path: node.file.path });
    } else {
      const paths = descendantFilePaths(node);
      const checked = folderRollup(node, inCommit) === 'checked';
      dispatch({ type: 'setInCommit', paths, checked: !checked });
    }
  }, [railMode, tree, cursorKey, files, inCommit, dispatch]);

  return {
    visibleRows,
    filterInputRef,
    rollup,
    hiddenChecked,
    onCursorUp,
    onCursorDown,
    onCursorRight,
    onCursorLeft,
    onCursorEnter,
    onCursorSpace,
  };
}
