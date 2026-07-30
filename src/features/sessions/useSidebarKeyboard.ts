import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { SessionMeta } from '../../../contract/common';
import type { Pane } from '../../lib/store';

export interface UseSidebarKeyboardOptions {
  focusedPane: Pane;
  visible: SessionMeta[];
  rowCursor: number;
  setRowCursor: Dispatch<SetStateAction<number>>;
  sidebarFilter: string | null;
  setSidebarFilter: (f: string | null) => void;
  filterRef: RefObject<HTMLInputElement>;
  newSessionOpen: boolean;
  projectsOpen: boolean;
  /** True while the row context menu is open. */
  menuOpen: boolean;
  selectSession: (id: string) => void;
  setFocusedPane: (p: Pane) => void;
}

/** Keyboard handling for pane [1] and its filter input (FR-16/17/20). */
export function useSidebarKeyboard(options: UseSidebarKeyboardOptions): void {
  const {
    focusedPane,
    visible,
    rowCursor,
    setRowCursor,
    sidebarFilter,
    setSidebarFilter,
    filterRef,
    newSessionOpen,
    projectsOpen,
    menuOpen,
    selectSession,
    setFocusedPane,
  } = options;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (newSessionOpen || projectsOpen || menuOpen) return;
      const activeEl = document.activeElement as HTMLElement | null;
      const inFilter = activeEl === filterRef.current;
      const inOtherInput = !!activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') && !inFilter;
      if (inOtherInput) return;
      if (focusedPane !== 'sidebar' && !inFilter) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setRowCursor((c) => Math.min(c + 1, Math.max(0, visible.length - 1)));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setRowCursor((c) => Math.max(c - 1, 0));
          break;
        case 'Enter':
          if (visible.length > 0 && visible[rowCursor]) {
            e.preventDefault();
            selectSession(visible[rowCursor].id);
            setFocusedPane('main'); // FR-17: commit AND jump into the conversation
          }
          break;
        case '/':
          if (!inFilter) {
            e.preventDefault();
            setSidebarFilter('');
            requestAnimationFrame(() => filterRef.current?.focus());
          }
          break;
        case 'Escape':
          if (inFilter) {
            e.preventDefault();
            setSidebarFilter(null);
            filterRef.current?.blur();
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    focusedPane,
    visible,
    rowCursor,
    sidebarFilter,
    newSessionOpen,
    projectsOpen,
    menuOpen,
    setRowCursor,
    setSidebarFilter,
    setFocusedPane,
    selectSession,
    filterRef,
  ]);
}
