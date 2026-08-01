// app-shell layout store slice: focused pane, left/right column visibility, and
// the modal-open flags lifted to the store so the command palette can open them.
// Split out of the former monolithic store.ts — see store.ts for the
// composition root.

import type { StateCreator } from 'zustand';
import type { AppState } from './store';

export type Pane = 'sidebar' | 'main' | 'agents' | 'mcp' | 'skills' | 'workflows';

// collapse-right-column: the three right-column cards that can be individually
// folded to their header row (FR-1).
export type RightPane = 'agents' | 'mcp' | 'skills';
export type CollapsedPanes = Record<RightPane, boolean>;

// localStorage persistence for the column toggles — guarded so a restricted
// storage environment (or node test env) degrades to defaults silently.
function loadPane(key: string): boolean {
  try {
    return localStorage.getItem(key) !== '0'; // default visible
  } catch {
    return true;
  }
}
function persistPane(key: string, visible: boolean): void {
  try {
    localStorage.setItem(key, visible ? '1' : '0');
  } catch {
    /* ignore */
  }
}
const LEFT_KEY = 'francois.showLeftPane';
const RIGHT_KEY = 'francois.showRightPane';
// Every pane that lives in the right column, collapsible or not — 'workflows'
// isn't collapsible (out of scope for collapse-right-column) but still needs to
// reveal/hide the column like the other three.
const RIGHT_COLUMN_PANES: readonly Pane[] = ['agents', 'mcp', 'skills', 'workflows'];
function isRightColumnPane(p: Pane): boolean {
  return RIGHT_COLUMN_PANES.includes(p);
}

const RIGHT_PANES: readonly RightPane[] = ['agents', 'mcp', 'skills'];
/** Exported so app-shell's `c` shortcut (FR-10) can reuse this test without duplicating it. */
export function isRightPane(p: Pane): p is RightPane {
  return (RIGHT_PANES as readonly Pane[]).includes(p);
}

export const COLLAPSED_PANES_STORAGE_KEY = 'francois.collapsedPanes';
const DEFAULT_COLLAPSED_PANES: CollapsedPanes = { agents: false, mcp: false, skills: false };

/**
 * Pure, exported for tests: normalizes whatever came out of localStorage
 * (FR-4) — a malformed/non-object/partial value never throws: unknown keys
 * are dropped, missing keys default to false, non-boolean values default to
 * false.
 */
export function parseCollapsedPanes(raw: string | null): CollapsedPanes {
  if (raw === null) return { ...DEFAULT_COLLAPSED_PANES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_COLLAPSED_PANES };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_COLLAPSED_PANES };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    agents: obj.agents === true,
    mcp: obj.mcp === true,
    skills: obj.skills === true,
  };
}

function loadCollapsedPanes(): CollapsedPanes {
  try {
    return parseCollapsedPanes(localStorage.getItem(COLLAPSED_PANES_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_COLLAPSED_PANES };
  }
}
function persistCollapsedPanes(panes: CollapsedPanes): void {
  try {
    localStorage.setItem(COLLAPSED_PANES_STORAGE_KEY, JSON.stringify(panes));
  } catch {
    /* ignore */
  }
}

export interface LayoutSlice {
  // minimal app-shell state
  focusedPane: Pane;
  setFocusedPane: (p: Pane) => void;
  // layout: left (sessions) / right (agents+mcp+skills+workflows) column visibility.
  // Persisted to localStorage; hiding the column that owns focus hands focus to
  // 'main', and focusing a pane always reveals its column (setFocusedPane).
  showLeftPane: boolean;
  showRightPane: boolean;
  toggleLeftPane: () => void;
  toggleRightPane: () => void;
  newSessionOpen: boolean;
  setNewSessionOpen: (o: boolean) => void;
  newAgentOpen: boolean;
  setNewAgentOpen: (o: boolean) => void;
  // session-rename FR-12/FR-14: the session whose name is being edited, or null
  // when the rename modal is closed. Lifted here — like newSessionOpen — because
  // both the sidebar context menu and the ⌘K palette open the same modal.
  renameSessionId: string | null;
  setRenameSessionId: (sessionId: string | null) => void;
  // mcp-panel attach overlay — lifted to the store so the command palette can open it (FR-23)
  mcpAttachOpen: boolean;
  setMcpAttachOpen: (o: boolean) => void;
  // permission-guardrails FR-26: the rules editor modal, opened from the palette.
  permissionsOpen: boolean;
  setPermissionsOpen: (o: boolean) => void;
  // collapse-right-column: per-card collapse state for the right column, independent
  // of showRightPane (FR-1/FR-7). Persisted to localStorage as one JSON record.
  collapsedPanes: CollapsedPanes;
  toggleCollapsedPane: (pane: RightPane) => void;
  setCollapsedPane: (pane: RightPane, collapsed: boolean) => void;
}

export const createLayoutSlice: StateCreator<AppState, [], [], LayoutSlice> = (set) => ({
  focusedPane: 'sidebar',
  // Invariant: the focused pane's column is always visible — focusing a hidden
  // pane (key 1/3/4/5/6, palette commands, `a`) reveals its column first.
  setFocusedPane: (focusedPane) =>
    set((s) => {
      const patch: Partial<AppState> = { focusedPane };
      if (focusedPane === 'sidebar' && !s.showLeftPane) {
        patch.showLeftPane = true;
        persistPane(LEFT_KEY, true);
      }
      if (isRightColumnPane(focusedPane)) {
        if (!s.showRightPane) {
          patch.showRightPane = true;
          persistPane(RIGHT_KEY, true);
        }
        // FR-6: focusing a collapsed right pane always expands it too, so 3/4/5,
        // `a`, and every palette command that focuses a pane land on a readable card.
        // 'workflows' isn't collapsible, so it's excluded here (isRightPane narrows).
        if (isRightPane(focusedPane) && s.collapsedPanes[focusedPane]) {
          const collapsedPanes = { ...s.collapsedPanes, [focusedPane]: false };
          patch.collapsedPanes = collapsedPanes;
          persistCollapsedPanes(collapsedPanes);
        }
      }
      return patch;
    }),
  showLeftPane: loadPane(LEFT_KEY),
  showRightPane: loadPane(RIGHT_KEY),
  toggleLeftPane: () =>
    set((s) => {
      const show = !s.showLeftPane;
      persistPane(LEFT_KEY, show);
      // hiding the column that owns focus → hand focus to main
      const focusedPane = !show && s.focusedPane === 'sidebar' ? 'main' : s.focusedPane;
      return { showLeftPane: show, focusedPane };
    }),
  toggleRightPane: () =>
    set((s) => {
      const show = !s.showRightPane;
      persistPane(RIGHT_KEY, show);
      // FR-7: hiding/showing the column never touches collapsedPanes — the two
      // toggles are independent.
      const focusedPane = !show && isRightColumnPane(s.focusedPane) ? 'main' : s.focusedPane;
      return { showRightPane: show, focusedPane };
    }),
  newSessionOpen: false,
  setNewSessionOpen: (newSessionOpen) => set({ newSessionOpen }),
  newAgentOpen: false,
  setNewAgentOpen: (newAgentOpen) => set({ newAgentOpen }),
  renameSessionId: null,
  setRenameSessionId: (renameSessionId) => set({ renameSessionId }),
  mcpAttachOpen: false,
  setMcpAttachOpen: (mcpAttachOpen) => set({ mcpAttachOpen }),
  permissionsOpen: false,
  setPermissionsOpen: (permissionsOpen) => set({ permissionsOpen }),
  collapsedPanes: loadCollapsedPanes(),
  toggleCollapsedPane: (pane) =>
    set((s) => {
      const collapsed = !s.collapsedPanes[pane];
      const collapsedPanes = { ...s.collapsedPanes, [pane]: collapsed };
      persistCollapsedPanes(collapsedPanes);
      // FR-5: collapsing the currently focused pane hands focus to 'main' —
      // mirroring toggleRightPane; a collapsed pane never owns focus.
      const focusedPane = collapsed && s.focusedPane === pane ? 'main' : s.focusedPane;
      return { collapsedPanes, focusedPane };
    }),
  setCollapsedPane: (pane, collapsed) =>
    set((s) => {
      if (s.collapsedPanes[pane] === collapsed) return {};
      const collapsedPanes = { ...s.collapsedPanes, [pane]: collapsed };
      persistCollapsedPanes(collapsedPanes);
      const focusedPane = collapsed && s.focusedPane === pane ? 'main' : s.focusedPane;
      return { collapsedPanes, focusedPane };
    }),
});
