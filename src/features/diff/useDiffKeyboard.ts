import { useEffect } from 'react';
import type { MainTab, Pane } from '../../lib/store';

export interface UseDiffKeyboardOptions {
  mainTab: MainTab;
  focusedPane: Pane;
  commitOpen: boolean;
  doCommit: () => void;
  closeCommit: () => void;
  stageAll: () => void;
  openCommit: () => void;
  cycle: (dir: 1 | -1) => void;
}

/** Keyboard handling for the DIFF tab (FR-21/22/23/24). Active only while the DIFF
 *  tab is visible; a moved-verbatim copy of DiffView's own key handler. */
export function useDiffKeyboard(options: UseDiffKeyboardOptions): void {
  const { mainTab, focusedPane, commitOpen, doCommit, closeCommit, stageAll, openCommit, cycle } = options;

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
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return; // FR-22/23 text-input guard
      if (e.key === 's' || e.key === 'S') {
        stageAll();
      } else if (e.key === 'c' || e.key === 'C') {
        openCommit();
      } else if (focusedPane === 'main' && e.key === 'ArrowRight') {
        e.preventDefault();
        cycle(1);
      } else if (focusedPane === 'main' && e.key === 'ArrowLeft') {
        e.preventDefault();
        cycle(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mainTab, focusedPane, commitOpen, doCommit, closeCommit, stageAll, openCommit, cycle]);
}
