import { useEffect } from 'react';
import { dismissPalette, isPaletteOpen, togglePalette } from '../features/palette/palette';
import { useStore, type MainTab, type Pane } from '../lib/store';
import { buildShortcutActions } from './appShell';

export interface AppShortcutState {
  newSessionOpen: boolean;
  newAgentOpen: boolean;
  permissionsOpen: boolean;
  projectsOpen: boolean;
  setNewSessionOpen: (open: boolean) => void;
  setNewAgentOpen: (open: boolean) => void;
  setFocusedPane: (pane: Pane) => void;
  setMainTab: (tab: MainTab) => void;
}

/**
 * app-shell's two global keydown listeners:
 *
 * - a capture-phase listener owning ⌘K/Ctrl+K (togglePalette) and
 *   Escape-while-open (dismiss), so they fire from any focus, including the
 *   terminal (command-palette FR-1/FR-3). No competing listener lives in
 *   command-palette.
 * - a bubble-phase listener for the minimal app-shell global keys: n (new
 *   session), a (new agent), 1-5 (pane focus), d/t/o (toggle diff/shell/
 *   overview ↔ session), w (close the active agent tab), [ / ] (toggle the
 *   side columns) — suppressed while a modal or a text/terminal input is
 *   focused (permission-guardrails FR-29 / projects FR-37).
 */
export function useAppShortcuts(state: AppShortcutState): void {
  const { newSessionOpen, newAgentOpen, permissionsOpen, projectsOpen, setNewSessionOpen, setNewAgentOpen, setFocusedPane, setMainTab } =
    state;

  useEffect(() => {
    const onKeyCapture = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        e.stopPropagation();
        togglePalette();
      } else if (e.key === 'Escape' && isPaletteOpen()) {
        e.preventDefault();
        e.stopPropagation();
        dismissPalette();
      }
    };
    window.addEventListener('keydown', onKeyCapture, true);
    return () => window.removeEventListener('keydown', onKeyCapture, true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      const inInput = !!activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
      const inTerminal = !!activeEl && activeEl.closest('.xterm') !== null;
      // permission-guardrails FR-29 / projects FR-37: an open editor suppresses the
      // single-letter globals too, exactly like the other modals.
      if (newSessionOpen || newAgentOpen || permissionsOpen || projectsOpen || inInput || inTerminal) return;
      const actions = buildShortcutActions({
        preventDefault: () => e.preventDefault(),
        getActiveSessionId: () => useStore.getState().activeSessionId,
        getMainTab: () => useStore.getState().mainTab,
        setFocusedPane,
        setMainTab,
        setNewSessionOpen,
        setNewAgentOpen,
        closeAgentTab: (agentId) => useStore.getState().closeAgentTab(agentId),
        toggleLeftPane: () => useStore.getState().toggleLeftPane(),
        toggleRightPane: () => useStore.getState().toggleRightPane(),
      });
      const action = actions[e.key];
      if (action) action();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newSessionOpen, newAgentOpen, permissionsOpen, projectsOpen, setNewSessionOpen, setNewAgentOpen, setFocusedPane, setMainTab]);
}
