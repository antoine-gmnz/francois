import { useEffect, useRef } from 'react';
import { dismissPalette, isPaletteOpen, togglePalette } from '../features/palette/palette';
import { clampPaneIndex, focusedSessionId, focusedTab, layoutRegime, paneCount } from '../lib/layoutStore';
import { useStore, type MainTab, type Pane } from '../lib/store';
import { buildShortcutActions } from './appShell';

export interface AppShortcutState {
  newSessionOpen: boolean;
  /** cloud-sessions FR-14: the adopt modal owns the keyboard while it is up. */
  adoptCloudOpen: boolean;
  newAgentOpen: boolean;
  permissionsOpen: boolean;
  projectsOpen: boolean;
  /** multi-account FR-34: the Accounts modal owns a/r/Del/Enter while it is up. */
  accountsOpen: boolean;
  /** session-rename FR-8: the rename modal suppresses the globals like every other modal. */
  renameOpen: boolean;
  /** self-update FR-10: the update modal suppresses the globals like every other modal. */
  updateModalOpen: boolean;
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
  const {
    newSessionOpen,
    adoptCloudOpen,
    newAgentOpen,
    permissionsOpen,
    projectsOpen,
    accountsOpen,
    renameOpen,
    updateModalOpen,
    setNewSessionOpen,
    setNewAgentOpen,
    setFocusedPane,
    setMainTab,
  } = state;

  // split-by-4 FR-14: ⌘1–⌘4 and ⌥⇥ must reach the shell from ANY focus — the
  // footer of an unfocused pane literally reads `⌘2 to focus and type`, and the
  // caret is very often inside the focused pane's composer or its terminal. So
  // they live on the capture listener beside ⌘K rather than on the bubble one,
  // which returns early on every modifier.
  const modalOpen =
    newSessionOpen || newAgentOpen || permissionsOpen || projectsOpen || accountsOpen || renameOpen || updateModalOpen;
  const modalOpenRef = useRef(modalOpen);
  modalOpenRef.current = modalOpen;

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
      } else if (modalOpenRef.current || isPaletteOpen()) {
        // FR-14: a modal owns the keyboard — nothing below fires under one.
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        const st = useStore.getState();
        const index = Number(e.key) - 1;
        // A pane that does not exist is a no-op, NOT a swallowed key.
        if (index < paneCount(st) && paneCount(st) > 1) {
          e.preventDefault();
          e.stopPropagation();
          st.setFocusedPaneIndex(index);
        }
      } else if (e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'Tab') {
        const st = useStore.getState();
        if (paneCount(st) > 1) {
          e.preventDefault();
          e.stopPropagation();
          st.focusNextWaitingPane();
        }
      }
    };
    window.addEventListener('keydown', onKeyCapture, true);
    return () => window.removeEventListener('keydown', onKeyCapture, true);
  }, []);

  // split-by-4 FR-13/FR-20: `d`/`t`/`o` retarget the FOCUSED pane. While split,
  // only the three PaneTab values are reachable — `o` (overview) becomes a real
  // no-op rather than being clamped into a surprise tab switch — and in the grid
  // chrome (FR-9) a pane has no tabs at all, so all three are no-ops there.
  const setFocusedPaneTab = (tab: MainTab) => {
    const st = useStore.getState();
    const count = paneCount(st);
    if (count === 1) {
      setMainTab(tab);
      return;
    }
    if (tab !== 'session' && tab !== 'diff' && tab !== 'shell') return;
    if (layoutRegime(count) === 'grid') return;
    st.setPaneTab(clampPaneIndex(st.focusedPaneIndex, count), tab);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      const inInput = !!activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
      const inTerminal = !!activeEl && activeEl.closest('.xterm') !== null;
      // multiple-shells FR-19: a modifier held means this keydown is one of the
      // SHELL tab's ⌘T/⌘W/⌃⇥/⌃⇧⇥ combos (or any other modified combo), never a
      // plain single-letter global — without this guard `t`'s toggleShellTab
      // would also fire on a bare Cmd+T and immediately leave the tab it just opened.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // permission-guardrails FR-29 / projects FR-37: an open editor suppresses the
      // single-letter globals too, exactly like the other modals.
      if (
        newSessionOpen ||
        adoptCloudOpen ||
        newAgentOpen ||
        permissionsOpen ||
        projectsOpen ||
        accountsOpen ||
        renameOpen ||
        updateModalOpen ||
        inInput ||
        inTerminal
      )
        return;
      const actions = buildShortcutActions({
        preventDefault: () => e.preventDefault(),
        // split-session FR-7: n/a/d/t/w/c act on the FOCUSED pane. Both getters
        // collapse to activeSessionId/mainTab whenever the app is not split.
        getActiveSessionId: () => focusedSessionId(useStore.getState()),
        getMainTab: () => focusedTab(useStore.getState()),
        getFocusedPane: () => useStore.getState().focusedPane,
        setFocusedPane,
        setMainTab: setFocusedPaneTab,
        setNewSessionOpen,
        setNewAgentOpen,
        closeAgentTab: (agentId) => useStore.getState().closeAgentTab(agentId),
        toggleLeftPane: () => useStore.getState().toggleLeftPane(),
      });
      const action = actions[e.key];
      if (action) action();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    newSessionOpen,
    adoptCloudOpen,
    newAgentOpen,
    permissionsOpen,
    projectsOpen,
    accountsOpen,
    renameOpen,
    updateModalOpen,
    setNewSessionOpen,
    setNewAgentOpen,
    setFocusedPane,
    setMainTab,
  ]);
}
