import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { MainTab, Pane } from '../../lib/store';

export interface UseDiffKeyboardOptions {
  mainTab: MainTab;
  focusedPane: Pane;
  commitOpen: boolean;
  doCommit: () => void;
  closeCommit: () => void;
  stageAll: () => void;
  openCommit: () => void;
  setFilter: (v: string) => void;
  filterInputRef: RefObject<HTMLInputElement>;
  onCursorUp: () => void;
  onCursorDown: () => void;
  onCursorRight: () => void;
  onCursorLeft: () => void;
  onCursorEnter: () => void;
}

/** Keyboard handling for the DIFF tab (FR-10/17/18/19). Active only while the DIFF
 *  tab is visible. `s`, `c`, `Esc`, `Enter`-in-commit semantics are unchanged; the
 *  flat `←`/`→` file cycle is replaced by tree traversal (FR-17). */
export function useDiffKeyboard(options: UseDiffKeyboardOptions): void {
  const {
    mainTab,
    focusedPane,
    commitOpen,
    doCommit,
    closeCommit,
    stageAll,
    openCommit,
    setFilter,
    filterInputRef,
    onCursorUp,
    onCursorDown,
    onCursorRight,
    onCursorLeft,
    onCursorEnter,
  } = options;

  useEffect(() => {
    if (mainTab !== 'diff') return;
    const onKey = (e: KeyboardEvent) => {
      if (commitOpen) {
        if (e.key === 'Enter') {
          e.preventDefault();
          doCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeCommit();
        }
        return; // let all other keys type into the commit input
      }

      const activeEl = document.activeElement as HTMLElement | null;
      const inFilter = activeEl === filterInputRef.current;
      const inOtherInput = !!activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') && !inFilter;
      if (inOtherInput) return; // FR-10: `/` and everything else is inert in another text input

      if (inFilter) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setFilter(''); // FR-10: clear and return focus to the tree
          filterInputRef.current?.blur();
        }
        return; // let every other key type into the filter
      }

      if (e.key === 's' || e.key === 'S') {
        stageAll();
        return;
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
    stageAll,
    openCommit,
    setFilter,
    filterInputRef,
    onCursorUp,
    onCursorDown,
    onCursorRight,
    onCursorLeft,
    onCursorEnter,
  ]);
}
