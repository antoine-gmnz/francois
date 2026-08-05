// app-shell layout store slice: focused pane, left/right column visibility, and
// the modal-open flags lifted to the store so the command palette can open them.
// Split out of the former monolithic store.ts — see store.ts for the
// composition root.

import type { StateCreator } from 'zustand';
import type { SessionId, SessionMeta } from '../../contract/common';
import type { MainTab } from './agentTabStore';
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
// The tab strip's right-aligned session meta cluster. It never shrinks (the
// tab strip scrolls instead), so on a narrow window a long agent-tab run gets
// clipped — folding the cluster is what actually hands that width back.
export const SESSION_META_KEY = 'francois.showSessionMeta';
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

// ── split-session (specs/split-session.md §5) ────────────────────────────────
// Two live sessions side by side. `activeSessionId` + `mainTab` keep their exact
// current meaning — THE LEFT PANE — so no existing consumer changes semantics;
// everything new hangs off the three fields below, persisted as one record.

/** The three tabs a split pane can show. A strict subset of MainTab. */
export type PaneTab = 'session' | 'diff' | 'shell';
export type SplitSide = 'left' | 'right';

export interface SplitState {
  /** null ⇒ not split. The RIGHT pane's session. */
  splitSessionId: SessionId | null;
  /** The RIGHT pane's tab; default 'session'. */
  splitTab: PaneTab;
  /** Which pane owns the keyboard; default 'left'. */
  focusedSide: SplitSide;
}

/** FR-16 */
export const SPLIT_STORAGE_KEY = 'francois.split';

const NOT_SPLIT: SplitState = { splitSessionId: null, splitTab: 'session', focusedSide: 'left' };

/**
 * FR-13: MainTab → the PaneTab a split pane can show. `overview` and the
 * dynamic `agent:<id>`/`workflow:<id>` tabs clamp to 'session'.
 *
 * Declared by §5 under `src/app/appShell.ts`, which re-exports it — it lives
 * here beside `PaneTab` because the store slice below needs it inside `set()`,
 * and importing it the other way would make the two modules cyclic.
 */
export function clampToPaneTab(tab: MainTab): PaneTab {
  return tab === 'diff' || tab === 'shell' ? tab : 'session';
}

/**
 * FR-10: which session `▯▯` opens on the right — the most recently active in
 * scope other than `exclude`, by `lastActivityAt` desc. null ⇒ `▯▯` is
 * disabled (FR-9). Re-exported by `src/app/appShell.ts` per §5.
 */
export function splitCandidate(sessions: readonly SessionMeta[], exclude: SessionId | null): SessionMeta | null {
  let best: SessionMeta | null = null;
  for (const s of sessions) {
    if (s.id === exclude) continue;
    if (best === null || s.lastActivityAt > best.lastActivityAt) best = s;
  }
  return best;
}

/**
 * Pure, exported for tests (FR-16): normalizes whatever came out of
 * localStorage. A malformed, non-object, array or partially-typed value returns
 * the not-split default rather than throwing — and a record with no usable
 * `splitSessionId` degrades wholesale, since the other two fields only mean
 * anything while split.
 */
export function parseSplitState(raw: string | null): SplitState {
  if (raw === null) return { ...NOT_SPLIT };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...NOT_SPLIT };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...NOT_SPLIT };
  const obj = parsed as Record<string, unknown>;
  const id = obj.splitSessionId;
  if (typeof id !== 'string' || id.length === 0) return { ...NOT_SPLIT };
  const tab = obj.splitTab;
  return {
    splitSessionId: id,
    splitTab: tab === 'diff' || tab === 'shell' ? tab : 'session',
    focusedSide: obj.focusedSide === 'right' ? 'right' : 'left',
  };
}

function loadSplitState(): SplitState {
  try {
    return parseSplitState(localStorage.getItem(SPLIT_STORAGE_KEY));
  } catch {
    return { ...NOT_SPLIT };
  }
}

/** FR-16: written on every change. Exported so sessionsStore's FR-20 removal
 *  path can record leaving split without duplicating the key. */
export function persistSplitState(state: SplitState): void {
  try {
    localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

/**
 * FR-3: the user's persisted right-column preference — what LEAVING split
 * restores, since entering it folded the column to the rail without persisting.
 * Exported so sessionsStore's FR-20 removal path restores it identically.
 */
export function persistedRightPane(): boolean {
  return loadPane(RIGHT_KEY);
}

/**
 * FR-7: the session the user is looking at — what the titlebar quota, the right
 * column, the status bar, the palette's session-scoped commands and the
 * single-letter globals read. Derived, never stored. When not split it equals
 * `activeSessionId`, so every existing consumer is behaviour-identical outside
 * split.
 */
export function focusedSessionId(
  s: Pick<AppState, 'splitSessionId' | 'focusedSide' | 'activeSessionId'>,
): SessionId | null {
  return s.splitSessionId !== null && s.focusedSide === 'right' ? s.splitSessionId : s.activeSessionId;
}

/** The tab the FOCUSED pane shows — `focusedSessionId`'s sibling, for `d`/`t`/`o`. */
export function focusedTab(s: Pick<AppState, 'splitSessionId' | 'focusedSide' | 'mainTab' | 'splitTab'>): MainTab {
  return s.splitSessionId !== null && s.focusedSide === 'right' ? s.splitTab : s.mainTab;
}

/**
 * FR-19: every session currently on screen — one when not split, both panes'
 * otherwise. The notification gate suppresses `turnDone` for all of them, not
 * just the focused one.
 */
export function visibleSessionIds(s: Pick<AppState, 'activeSessionId' | 'splitSessionId'>): SessionId[] {
  const ids: SessionId[] = [];
  if (s.activeSessionId !== null) ids.push(s.activeSessionId);
  if (s.splitSessionId !== null && s.splitSessionId !== s.activeSessionId) ids.push(s.splitSessionId);
  return ids;
}

/**
 * FR-18: is `sessionId`'s SHELL tab on screen? Tests BOTH panes, so a session's
 * PTY stays "displayed" while either side is on SHELL — the global
 * `activeSessionId`/`mainTab` pair is no longer the whole answer.
 */
export function isShellVisible(
  s: Pick<AppState, 'activeSessionId' | 'mainTab' | 'splitSessionId' | 'splitTab'>,
  sessionId: SessionId,
): boolean {
  if (s.activeSessionId === sessionId && s.mainTab === 'shell') return true;
  return s.splitSessionId === sessionId && s.splitTab === 'shell';
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
  // The SESSION meta cluster in the tab strip (model, permission mode, branch,
  // context, elapsed). Folded to its chevron, the tab strip gets the full width.
  // Persisted like the column toggles; independent of every other layout flag.
  showSessionMeta: boolean;
  toggleSessionMeta: () => void;
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

  // split-session §5 — the RIGHT pane. `activeSessionId`/`mainTab` stay the LEFT
  // pane's, so the left pane never remounts when focus moves.
  splitSessionId: SessionId | null;
  splitTab: PaneTab;
  focusedSide: SplitSide;
  /**
   * FR-10/FR-11: open `sessionId` in the right pane (focusedSide → 'right').
   * Swaps if it is already the left pane's session (FR-8). Also applies FR-3
   * (fold the right column WITHOUT persisting) and FR-13 (clamp the left pane's
   * tab, close every dynamic tab).
   */
  openInRightPane: (sessionId: SessionId) => void;
  /**
   * FR-10/FR-12: leave split, keeping `side`'s session + tab as the single
   * active pane. Defaults to the focused side. No-op when not split.
   */
  unsplit: (side?: SplitSide) => void;
  setSplitTab: (tab: PaneTab) => void;
  /** FR-5. Also sets focusedPane = 'main'. */
  setFocusedSide: (side: SplitSide) => void;
}

const INITIAL_SPLIT = loadSplitState();

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
  showSessionMeta: loadPane(SESSION_META_KEY),
  toggleSessionMeta: () =>
    set((s) => {
      const show = !s.showSessionMeta;
      persistPane(SESSION_META_KEY, show);
      // No focus consequence: the cluster is a readout, never a focusable pane.
      return { showSessionMeta: show };
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

  // ---------- split-session ----------
  splitSessionId: INITIAL_SPLIT.splitSessionId,
  splitTab: INITIAL_SPLIT.splitTab,
  focusedSide: INITIAL_SPLIT.focusedSide,

  openInRightPane: (sessionId) =>
    set((s) => {
      // FR-8: the target is already the LEFT pane's session — swap the two panes
      // rather than showing the same session twice. Nothing to swap with when
      // not split, so that is a no-op.
      if (sessionId === s.activeSessionId) {
        if (s.splitSessionId === null) return {};
        const next: SplitState = { splitSessionId: sessionId, splitTab: clampToPaneTab(s.mainTab), focusedSide: 'right' };
        persistSplitState(next);
        return {
          ...next,
          activeSessionId: s.splitSessionId,
          mainTab: s.splitTab,
          focusedPane: 'main',
        };
      }

      // Already the RIGHT pane's session (its roster row, its context menu, the
      // palette): this is a FOCUS, not an assignment — the pane keeps whichever
      // tab it is on. The left-pane equivalent (setActiveSessionId with the id
      // already active) is a no-op too, and resetting to 'session' here would
      // silently discard a Diff/Shell the user is reading (FR-4: each pane's
      // strip switches independently).
      if (sessionId === s.splitSessionId) {
        if (s.focusedSide === 'right') return s.focusedPane === 'main' ? {} : { focusedPane: 'main' };
        persistSplitState({ splitSessionId: s.splitSessionId, splitTab: s.splitTab, focusedSide: 'right' });
        return { focusedSide: 'right', focusedPane: 'main' };
      }

      const wasSplit = s.splitSessionId !== null;
      // FR-10: a session landing in the right pane opens on SESSION.
      const next: SplitState = { splitSessionId: sessionId, splitTab: 'session', focusedSide: 'right' };
      persistSplitState(next);
      const patch: Partial<AppState> = { ...next, focusedPane: 'main' };
      if (!wasSplit) {
        // FR-13: the left pane clamps out of overview / agent: / workflow:, and
        // every dynamic tab closes (clearAgentTabs' effect, inlined so entering
        // split is one atomic set).
        patch.mainTab = clampToPaneTab(s.mainTab);
        patch.agentTabs = [];
        // FR-3: fold the right column to the rail WITHOUT persisting, so leaving
        // split restores whatever the user had before.
        patch.showRightPane = false;
      }
      return patch;
    }),

  unsplit: (side) =>
    set((s) => {
      if (s.splitSessionId === null) return {};
      const target = side ?? s.focusedSide;
      persistSplitState({ ...NOT_SPLIT });
      const patch: Partial<AppState> = {
        ...NOT_SPLIT,
        // FR-3: back to whatever the user had before the split folded it.
        showRightPane: persistedRightPane(),
      };
      // FR-12: promoting the right pane makes its session + tab the single one.
      if (target === 'right') {
        patch.activeSessionId = s.splitSessionId;
        patch.mainTab = s.splitTab;
      }
      return patch;
    }),

  setSplitTab: (splitTab) =>
    set((s) => {
      persistSplitState({ splitSessionId: s.splitSessionId, splitTab, focusedSide: s.focusedSide });
      return { splitTab };
    }),

  setFocusedSide: (focusedSide) =>
    set((s) => {
      // Called on EVERY click inside a pane (FR-5), so the no-op path must not
      // touch localStorage — a transcript click is not a layout change.
      if (s.focusedSide === focusedSide) return s.focusedPane === 'main' ? {} : { focusedPane: 'main' };
      persistSplitState({ splitSessionId: s.splitSessionId, splitTab: s.splitTab, focusedSide });
      return { focusedSide, focusedPane: 'main' };
    }),
});
