import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { MainTab, Pane } from '../../lib/store';

export interface UseDiffKeyboardOptions {
  mainTab: MainTab;
  focusedPane: Pane;
  commitOpen: boolean;
  doCommit: () => void;
  closeCommit: () => void;
  openCommit: () => void;
  setFilter: (v: string) => void;
  filterInputRef: RefObject<HTMLInputElement>;
  onCursorUp: () => void;
  onCursorDown: () => void;
  onCursorRight: () => void;
  onCursorLeft: () => void;
  onCursorEnter: () => void;
  /** Space on the cursor row — toggles its checkbox (FR-40). */
  onCursorSpace: () => void;
}

/** Keyboard handling for the DIFF tab (FR-40/FR-41), active only while the tab is
 *  visible. `s`/stage-all is gone for good (FR-41/FR-45) — this is `diff-navigator`'s
 *  traversal plus `c`/`/`/`Esc` and the new `Space` checkbox toggle. `⌘⏎` for the
 *  commit form itself lives in the form (a plain `Enter` must still type a
 *  newline in the description textarea). */
export function useDiffKeyboard(options: UseDiffKeyboardOptions): void {
  const {
    mainTab,
    focusedPane,
    commitOpen,
    doCommit,
    closeCommit,
    openCommit,
    setFilter,
    filterInputRef,
    onCursorUp,
    onCursorDown,
    onCursorRight,
    onCursorLeft,
    onCursorEnter,
    onCursorSpace,
  } = options;

  useEffect(() => {
    if (mainTab !== 'diff') return;
    const onKey = (e: KeyboardEvent) => {
      if (commitOpen) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          doCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeCommit();
        }
        return; // let every other key type into the form's fields
      }

      const activeEl = document.activeElement as HTMLElement | null;
      const inFilter = activeEl === filterInputRef.current;
      const inOtherInput = !!activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') && !inFilter;
      if (inOtherInput) return; // FR-41/FR-42: inert while any other text input has focus

      if (inFilter) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setFilter(''); // FR-41: clear and return focus to the tree
          filterInputRef.current?.blur();
        }
        return; // let every other key type into the filter
      }

      if (e.key === 'c' || e.key === 'C') {
        openCommit();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        requestAnimationFrame(() => filterInputRef.current?.focus());
        return;
      }
      if (focusedPane !== 'main') return;
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          onCursorUp();
          break;
        case 'ArrowDown':
          e.preventDefault();
          onCursorDown();
          break;
        case 'ArrowRight':
          e.preventDefault();
          onCursorRight();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          onCursorLeft();
          break;
        case 'Enter':
          e.preventDefault();
          onCursorEnter();
          break;
        case ' ':
          e.preventDefault();
          onCursorSpace();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    mainTab,
    focusedPane,
    commitOpen,
    doCommit,
    closeCommit,
    openCommit,
    setFilter,
    filterInputRef,
    onCursorUp,
    onCursorDown,
    onCursorRight,
    onCursorLeft,
    onCursorEnter,
    onCursorSpace,
  ]);
}
