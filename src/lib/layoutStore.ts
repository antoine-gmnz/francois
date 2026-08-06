// app-shell layout store slice: focused pane, left/right column visibility, and
// the modal-open flags lifted to the store so the command palette can open them.
// Split out of the former monolithic store.ts — see store.ts for the
// composition root.

import type { StateCreator } from 'zustand';
import type { SessionId, SessionMeta } from '../../contract/common';
import { statusNeedsAttention } from '../../contract/fleet-board';
import { filterSessionsByProject } from '../../contract/projects';
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

// ── split-by-4 (specs/split-by-4.md §5) ──────────────────────────────────────
// Up to four live sessions at once. `activeSessionId` + `mainTab` keep their
// exact current meaning — THEY ARE PANE 0 — so no existing consumer changes
// semantics; panes 1..3 hang off `extraPanes`, persisted with the focused index
// as one record. (This generalizes split-session's left/right pair: two panes is
// simply `extraPanes.length === 1`.)

/** The three tabs a pane can show. A strict subset of MainTab. */
export type PaneTab = 'session' | 'diff' | 'shell';

/**
 * FR-3: the pane count's LAYOUT consequence, and the only thing anything
 * branches on — 'single' is today's shell, 'split' is turn 5b, 'grid' is turn
 * 5d (no per-pane tab strip, folded roster, no right column).
 */
export type LayoutRegime = 'single' | 'split' | 'grid';

/** FR-1 */
export const MAX_PANES = 4;

/** Any pane count, normalized into 1..MAX_PANES. */
function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, Math.trunc(n)), MAX_PANES);
}

/**
 * One pane AFTER pane 0. `sessionId: null` is an EMPTY pane — what splitting a
 * project that holds a single session gives you (FR-15). It is a real pane: it
 * takes focus, it persists, and the next session you pick or create lands in it.
 * Pane 0 has always been able to hold nothing (`activeSessionId: null`), so this
 * only makes the extras agree with it.
 */
export interface PaneSlot {
  sessionId: SessionId | null;
  tab: PaneTab;
}

export interface SplitState {
  /** Panes 1..MAX_PANES-1. Empty ⇒ not split. */
  extraPanes: PaneSlot[];
  /** Which pane owns the keyboard, 0-based; default 0. */
  focusedPaneIndex: number;
}

/** FR-23 */
export const SPLIT_STORAGE_KEY = 'francois.split';

const NOT_SPLIT: SplitState = { extraPanes: [], focusedPaneIndex: 0 };

/** FR-3 */
export function layoutRegime(count: number): LayoutRegime {
  return count <= 1 ? 'single' : count === 2 ? 'split' : 'grid';
}

/** FR-15: how one segmented-control button reads and behaves. */
export interface LayoutModeState {
  /** Lit — this button names the layout currently on screen. */
  on: boolean;
  /** Greyed and inert. */
  disabled: boolean;
  /** Does clicking change anything? */
  actionable: boolean;
}

/**
 * FR-15: `▯` / `▯▯` / `⊞` at `panes` panes.
 *
 * `on` is PRESENTATION ONLY. `⊞` lights up across the whole grid range — three
 * panes AND four — because both are the grid chrome, so it must never double as
 * "clicking does nothing": at three panes `⊞` is lit and still has a fourth pane
 * to add. What makes a click a no-op is the TARGET matching the current count,
 * nothing else.
 *
 * `canSplit` (a project in scope holding at least one session) gates only
 * ENTERING a split. Once split, every button stays live — otherwise a layout
 * you are already in can strand you in it.
 */
export function layoutModeState(target: number, panes: number, canSplit: boolean): LayoutModeState {
  const on = target === 1 ? panes === 1 : target === 2 ? panes === 2 : panes >= 3;
  const disabled = target > 1 && panes === 1 && !canSplit;
  return { on, disabled, actionable: !disabled && clampCount(target) !== panes };
}

/** FR-12: every read and write of a pane index goes through this. */
export function clampPaneIndex(i: number, count: number): number {
  if (!Number.isInteger(i) || i < 0) return 0;
  return Math.min(i, Math.max(0, count - 1));
}

/**
 * FR-20: MainTab → the PaneTab a pane can show. `overview` and the dynamic
 * `agent:<id>`/`workflow:<id>` tabs clamp to 'session'.
 *
 * Declared by §5 under `src/app/appShell.ts`, which re-exports it — it lives
 * here beside `PaneTab` because the store slice below needs it inside `set()`,
 * and importing it the other way would make the two modules cyclic.
 */
export function clampToPaneTab(tab: MainTab): PaneTab {
  return tab === 'diff' || tab === 'shell' ? tab : 'session';
}

// ---------- pure pane readers ----------

type PaneReadable = Pick<AppState, 'activeSessionId' | 'mainTab' | 'extraPanes'>;

/** FR-1 */
export function paneCount(s: Pick<AppState, 'extraPanes'>): number {
  return 1 + s.extraPanes.length;
}

/** Pane `i`'s session, or null (pane 0 with no session / an out-of-range index). */
export function paneSessionIdAt(s: PaneReadable, i: number): SessionId | null {
  if (i === 0) return s.activeSessionId;
  return s.extraPanes[i - 1]?.sessionId ?? null;
}

/** Pane `i`'s tab. Pane 0's is `mainTab`, clamped — it may sit on OVERVIEW. */
export function paneTabAt(s: PaneReadable, i: number): PaneTab {
  if (i === 0) return clampToPaneTab(s.mainTab);
  return s.extraPanes[i - 1]?.tab ?? 'session';
}

/** FR-19/FR-22: which pane shows `sessionId`, or null. */
export function paneIndexOf(s: PaneReadable, sessionId: SessionId): number | null {
  if (s.activeSessionId === sessionId) return 0;
  const i = s.extraPanes.findIndex((p) => p.sessionId === sessionId);
  return i === -1 ? null : i + 1;
}

/**
 * FR-13: the session the user is looking at — what the titlebar quota, the right
 * column, the status bar, the palette's session-scoped commands and the
 * single-letter globals read. Derived, never stored. At one pane it equals
 * `activeSessionId`, so every existing consumer is behaviour-identical outside
 * split.
 */
export function focusedSessionId(s: PaneReadable & Pick<AppState, 'focusedPaneIndex'>): SessionId | null {
  return paneSessionIdAt(s, clampPaneIndex(s.focusedPaneIndex, paneCount(s)));
}

/**
 * The tab the FOCUSED pane shows — `focusedSessionId`'s sibling, for `d`/`t`/`o`.
 * Pane 0 answers with the RAW `mainTab` so `o` still toggles OVERVIEW when the
 * app is not split.
 */
export function focusedTab(s: PaneReadable & Pick<AppState, 'focusedPaneIndex'>): MainTab {
  const i = clampPaneIndex(s.focusedPaneIndex, paneCount(s));
  return i === 0 ? s.mainTab : paneTabAt(s, i);
}

/**
 * FR-26: every session currently on screen — one when not split, one per pane
 * otherwise. The notification gate suppresses `turnDone` for all of them, not
 * just the focused one.
 */
export function visibleSessionIds(s: PaneReadable): SessionId[] {
  const ids: SessionId[] = [];
  for (let i = 0; i < paneCount(s); i++) {
    const id = paneSessionIdAt(s, i);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * FR-25: is `sessionId`'s SHELL tab on screen? Tests EVERY pane, so a session's
 * PTY stays "displayed" wherever it sits — the global `activeSessionId`/
 * `mainTab` pair is no longer the whole answer.
 */
export function isShellVisible(s: PaneReadable, sessionId: SessionId): boolean {
  // FR-9: the grid chrome renders transcripts only, so a pane's remembered
  // `shell` tab is NOT on screen there — reporting it displayed would swallow
  // the unread mark on output the user cannot see.
  if (layoutRegime(paneCount(s)) === 'grid') return false;
  for (let i = 0; i < paneCount(s); i++) {
    if (paneSessionIdAt(s, i) === sessionId && paneTabAt(s, i) === 'shell') return true;
  }
  return false;
}

/**
 * FR-15: the `n` most recently active sessions in scope that no pane already
 * holds, by `lastActivityAt` desc. Re-exported by `src/app/appShell.ts` per §5.
 */
export function splitCandidates(
  sessions: readonly SessionMeta[],
  taken: readonly SessionId[],
  n: number,
): SessionMeta[] {
  if (n <= 0) return [];
  return sessions
    .filter((s) => !taken.includes(s.id))
    .slice()
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, n);
}

/** FR-15: the single candidate `▯▯` opens. null ⇒ `▯▯` is disabled. */
export function splitCandidate(sessions: readonly SessionMeta[], exclude: SessionId | null): SessionMeta | null {
  return splitCandidates(sessions, exclude === null ? [] : [exclude], 1)[0] ?? null;
}

// ---------- persistence ----------

function readPaneSlot(raw: unknown): PaneSlot | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const id = obj.sessionId;
  // An EMPTY pane round-trips: the split is the user's layout choice, and it
  // survives a reload whether or not a session has landed in it yet.
  const sessionId = typeof id === 'string' && id.length > 0 ? id : null;
  if (id !== null && sessionId === null) return null; // anything else is garbage
  const tab = obj.tab;
  return { sessionId, tab: tab === 'diff' || tab === 'shell' ? tab : 'session' };
}

/**
 * Pure, exported for tests (FR-23): normalizes whatever came out of
 * localStorage. A malformed, non-object, array or partially-typed value returns
 * the not-split default rather than throwing, and a LEGACY split-session record
 * (`{ splitSessionId, splitTab, focusedSide }`) loads as one extra pane — an
 * upgrade must not silently drop the user's second pane.
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

  // legacy split-session record
  if (!Array.isArray(obj.extraPanes) && typeof obj.splitSessionId === 'string' && obj.splitSessionId.length > 0) {
    const tab = obj.splitTab;
    return {
      extraPanes: [{ sessionId: obj.splitSessionId, tab: tab === 'diff' || tab === 'shell' ? tab : 'session' }],
      focusedPaneIndex: obj.focusedSide === 'right' ? 1 : 0,
    };
  }

  if (!Array.isArray(obj.extraPanes)) return { ...NOT_SPLIT };
  const extraPanes: PaneSlot[] = [];
  for (const entry of obj.extraPanes) {
    const slot = readPaneSlot(entry);
    if (!slot) continue;
    // A duplicate would show the same session twice (FR-19) — drop it. Empty
    // panes are exempt: several of them is a legitimate layout.
    if (slot.sessionId !== null && extraPanes.some((p) => p.sessionId === slot.sessionId)) continue;
    extraPanes.push(slot);
    if (extraPanes.length === MAX_PANES - 1) break;
  }
  if (extraPanes.length === 0) return { ...NOT_SPLIT };
  const idx = obj.focusedPaneIndex;
  return {
    extraPanes,
    focusedPaneIndex: clampPaneIndex(typeof idx === 'number' ? idx : 0, extraPanes.length + 1),
  };
}

function loadSplitState(): SplitState {
  try {
    return parseSplitState(localStorage.getItem(SPLIT_STORAGE_KEY));
  } catch {
    return { ...NOT_SPLIT };
  }
}

/** FR-23: written on every change. Exported so sessionsStore's FR-27 removal
 *  path can record the compacted grid without duplicating the key. */
export function persistSplitState(state: SplitState): void {
  try {
    localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

// ── split divider ───────────────────────────────────────────────────────────
// How the two panes share the main cell. Kept in its OWN storage key rather
// than inside the split record: it is a lasting layout preference, and the
// record is wiped on every unsplit — the next split would forget the width.

export const SPLIT_RATIO_STORAGE_KEY = 'francois.splitRatio';
/** The LEFT pane's share of the main cell. */
export const DEFAULT_SPLIT_RATIO = 0.5;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;
/**
 * A pane narrower than this stops being readable — the composer, the diff
 * gutter and an 80-column shell all give up at once. On a narrow window the
 * ratio bounds alone are not enough (20% of 900px is 180px), so the drag also
 * clamps in pixels.
 */
export const MIN_SPLIT_PANE_PX = 260;

/** Pure: any value → a usable ratio. 0.1% granularity ≈ 1px, so a drag that
 *  moves less than a pixel settles on the same number and re-renders nothing. */
export function clampSplitRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SPLIT_RATIO;
  const clamped = Math.min(Math.max(value, MIN_SPLIT_RATIO), MAX_SPLIT_RATIO);
  return Math.round(clamped * 1000) / 1000;
}

/** Pure, exported for tests: a malformed/absent persisted value reads as the default. */
export function parseSplitRatio(raw: string | null): number {
  // `Number('')` is 0, not NaN — an empty entry is an ABSENT preference, and
  // clamping it to the minimum would hand the user a 20% pane out of nowhere.
  if (raw === null || raw.trim() === '') return DEFAULT_SPLIT_RATIO;
  return clampSplitRatio(Number(raw));
}

/**
 * Pure: the pointer's x against the split grid's box → the left pane's share.
 * Clamped by BOTH the ratio bounds and `MIN_SPLIT_PANE_PX`, so neither pane can
 * be dragged down to an unreadable sliver. A window too narrow to give both
 * panes their minimum degrades to an even split rather than fighting itself.
 */
export function splitRatioFromDrag(clientX: number, left: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0) return DEFAULT_SPLIT_RATIO;
  const pxBound = MIN_SPLIT_PANE_PX / width;
  const lo = Math.max(MIN_SPLIT_RATIO, Math.min(pxBound, DEFAULT_SPLIT_RATIO));
  const hi = Math.min(MAX_SPLIT_RATIO, Math.max(1 - pxBound, DEFAULT_SPLIT_RATIO));
  return clampSplitRatio(Math.min(Math.max((clientX - left) / width, lo), hi));
}

function loadSplitRatio(): number {
  try {
    return parseSplitRatio(localStorage.getItem(SPLIT_RATIO_STORAGE_KEY));
  } catch {
    return DEFAULT_SPLIT_RATIO;
  }
}
function persistSplitRatio(ratio: number): void {
  try {
    localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(ratio));
  } catch {
    /* ignore */
  }
}

/**
 * FR-5: the user's persisted column preferences — what SHRINKING the pane count
 * restores, since growing it folded the columns without persisting. Exported so
 * sessionsStore's removal path restores them identically.
 */
export function persistedRightPane(): boolean {
  return loadPane(RIGHT_KEY);
}
export function persistedLeftPane(): boolean {
  return loadPane(LEFT_KEY);
}

/** FR-27: `extraPanes` with every pane on `sessionId` removed. */
export function panesWithout(extraPanes: readonly PaneSlot[], sessionId: SessionId): PaneSlot[] {
  return extraPanes.filter((p) => p.sessionId !== sessionId);
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

  // split-by-4 §5 — panes 1..3. `activeSessionId`/`mainTab` stay PANE 0's, so
  // pane 0 never remounts when focus moves.
  extraPanes: PaneSlot[];
  focusedPaneIndex: number;
  /**
   * FR-18: append a pane holding `sessionId` and focus it. A session already on
   * screen is FOCUSED instead of duplicated; a full grid is a no-op. Also
   * applies FR-5 (fold the columns WITHOUT persisting) and FR-20 (clamp pane
   * 0's tab, close every dynamic tab).
   */
  openInNewPane: (sessionId: SessionId) => void;
  /**
   * FR-19: put `sessionId` in the FOCUSED pane, swapping when it already sits
   * in another one. No-op at pane 0 — that path is `setActiveSessionId`, which
   * owns the agent-tab reset.
   */
  assignToFocusedPane: (sessionId: SessionId) => void;
  /** FR-15: the titlebar control — grow to / shrink to `n` panes (1..MAX_PANES). */
  setPaneCount: (n: number) => void;
  /**
   * FR-16: leave split, keeping pane `index`'s session and tab as the single
   * pane. Defaults to the focused pane; `tab` overrides the pane's own (Review
   * diff). No-op when not split.
   */
  unsplit: (index?: number, tab?: PaneTab) => void;
  /** FR-17: drop pane `index`; the grid compacts. No-op at one pane. */
  closePane: (index: number) => void;
  setPaneTab: (index: number, tab: PaneTab) => void;
  /** FR-12. Also sets focusedPane = 'main'. */
  setFocusedPaneIndex: (index: number) => void;
  /** FR-14: `⌥⇥` — the next pane parked on an approval or a question. */
  focusNextWaitingPane: () => void;
  /**
   * Pane 0's share of the main cell's WIDTH, dragged from the divider between
   * the two columns. Clamped + persisted on its own key, so it survives leaving
   * and re-entering split. Only the two-pane `split` regime reads it today.
   */
  splitRatio: number;
  setSplitRatio: (ratio: number) => void;
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

  // ---------- split-by-4 ----------
  extraPanes: INITIAL_SPLIT.extraPanes,
  focusedPaneIndex: INITIAL_SPLIT.focusedPaneIndex,

  openInNewPane: (sessionId) =>
    set((s) => {
      // Already on screen (its roster row, its rail tile, its context menu):
      // this is a FOCUS, not an assignment — the pane keeps whichever tab it is
      // on, and the session is never shown twice (FR-19).
      const existing = paneIndexOf(s, sessionId);
      if (existing !== null) return focusPanePatch(s, existing);

      // An EMPTY pane is already the room this was going to make — fill the
      // first one rather than opening a second waiting pane beside it.
      const empty = s.extraPanes.findIndex((p) => p.sessionId === null);
      if (empty !== -1) {
        const filled = s.extraPanes.slice();
        filled[empty] = { sessionId, tab: 'session' };
        persistSplitState({ extraPanes: filled, focusedPaneIndex: empty + 1 });
        return { extraPanes: filled, focusedPaneIndex: empty + 1, focusedPane: 'main' };
      }

      const count = paneCount(s);
      if (count >= MAX_PANES) return {}; // FR-18: no room
      // FR-18: a session landing in a new pane opens on SESSION.
      const extraPanes = [...s.extraPanes, { sessionId, tab: 'session' as PaneTab }];
      const next: SplitState = { extraPanes, focusedPaneIndex: extraPanes.length };
      persistSplitState(next);
      return { ...next, focusedPane: 'main', ...growPatch(s, count, count + 1) };
    }),

  assignToFocusedPane: (sessionId) =>
    set((s) => {
      const count = paneCount(s);
      const i = clampPaneIndex(s.focusedPaneIndex, count);
      if (i === 0) return {}; // caller uses setActiveSessionId — it owns the tab reset
      const j = paneIndexOf(s, sessionId);
      if (j === i) return focusPanePatch(s, i);

      const extraPanes = s.extraPanes.slice();
      if (j === null) {
        // Plain assignment: the pane opens the new session on SESSION.
        extraPanes[i - 1] = { sessionId, tab: 'session' };
        persistSplitState({ extraPanes, focusedPaneIndex: i });
        return { extraPanes, focusedPane: 'main' };
      }
      // FR-19: the session is in another pane — SWAP the two rather than
      // showing it twice.
      const here = paneAt(s, i);
      const there = paneAt(s, j);
      extraPanes[i - 1] = { sessionId: there.sessionId, tab: there.tab };
      if (j === 0) {
        persistSplitState({ extraPanes, focusedPaneIndex: i });
        return { extraPanes, activeSessionId: here.sessionId, mainTab: here.tab as MainTab, focusedPane: 'main' };
      }
      extraPanes[j - 1] = { sessionId: here.sessionId, tab: here.tab };
      persistSplitState({ extraPanes, focusedPaneIndex: i });
      return { extraPanes, focusedPane: 'main' };
    }),

  setPaneCount: (n) =>
    set((s) => {
      const target = clampCount(n);
      const count = paneCount(s);
      if (target === count) return {};
      if (target === 1) return unsplitPatch(s, clampPaneIndex(s.focusedPaneIndex, count));

      if (target < count) {
        // FR-15: shrinking keeps the FOCUSED pane, then the lowest-indexed ones.
        const focused = clampPaneIndex(s.focusedPaneIndex, count);
        const keep = [focused];
        for (let i = 0; i < count && keep.length < target; i++) if (i !== focused) keep.push(i);
        keep.sort((a, b) => a - b);
        return rebuildPatch(s, keep, focused);
      }

      // FR-15: grow with the most recently active in-scope sessions not already
      // in a pane, and pad the rest with EMPTY panes — a project holding one
      // session still splits, you just get a pane waiting for its second.
      const inScope = filterSessionsByProject(s.sessions, s.activeProjectId);
      const add = splitCandidates(inScope, visibleSessionIds(s), target - count);
      const slots: PaneSlot[] = Array.from({ length: target - count }, (_, k) => ({
        sessionId: add[k]?.id ?? null,
        tab: 'session',
      }));
      const extraPanes = [...s.extraPanes, ...slots];
      const next: SplitState = {
        extraPanes,
        focusedPaneIndex: clampPaneIndex(s.focusedPaneIndex, extraPanes.length + 1),
      };
      persistSplitState(next);
      return { ...next, ...growPatch(s, count, extraPanes.length + 1) };
    }),

  unsplit: (index, tab) =>
    set((s) => {
      const count = paneCount(s);
      if (count === 1) return {};
      return unsplitPatch(s, clampPaneIndex(index ?? s.focusedPaneIndex, count), tab);
    }),

  closePane: (index) =>
    set((s) => {
      const count = paneCount(s);
      if (count <= 1) return {};
      const closed = clampPaneIndex(index, count);
      const keep: number[] = [];
      for (let i = 0; i < count; i++) if (i !== closed) keep.push(i);
      if (keep.length === 1) return unsplitPatch(s, keep[0]);
      // Focus follows the slot: closing the focused pane hands focus to whatever
      // slid into its place (the last pane when it was the last).
      const focused = clampPaneIndex(s.focusedPaneIndex, count);
      return rebuildPatch(s, keep, focused === closed ? keep[Math.min(closed, keep.length - 1)] : focused);
    }),

  setPaneTab: (index, tab) =>
    set((s) => {
      const i = clampPaneIndex(index, paneCount(s));
      if (i === 0) return { mainTab: tab as MainTab };
      const extraPanes = s.extraPanes.slice();
      if (extraPanes[i - 1].tab === tab) return {};
      extraPanes[i - 1] = { ...extraPanes[i - 1], tab };
      persistSplitState({ extraPanes, focusedPaneIndex: s.focusedPaneIndex });
      return { extraPanes };
    }),

  setFocusedPaneIndex: (index) => set((s) => focusPanePatch(s, index)),

  focusNextWaitingPane: () =>
    set((s) => {
      const count = paneCount(s);
      if (count <= 1) return {};
      const from = clampPaneIndex(s.focusedPaneIndex, count);
      for (let k = 1; k <= count; k++) {
        const i = (from + k) % count;
        const id = paneSessionIdAt(s, i);
        const meta = id === null ? undefined : s.sessions.find((x) => x.id === id);
        if (meta && statusNeedsAttention(meta.status)) return focusPanePatch(s, i);
      }
      return {};
    }),

  splitRatio: loadSplitRatio(),

  setSplitRatio: (ratio) =>
    set((s) => {
      const splitRatio = clampSplitRatio(ratio);
      // Called on every pointermove of a drag — the no-op path must not write.
      if (splitRatio === s.splitRatio) return {};
      persistSplitRatio(splitRatio);
      return { splitRatio };
    }),
});

// ---------- shared patch builders (pure, module-private) ----------

/** Pane `i` as a slot — the shape rebuildPatch and the swap paths shuffle. */
function paneAt(s: AppState, i: number): { sessionId: SessionId | null; tab: PaneTab } {
  return { sessionId: paneSessionIdAt(s, i), tab: paneTabAt(s, i) };
}

/**
 * FR-12. Called on EVERY click inside a pane, so the no-op path must not touch
 * localStorage — a transcript click is not a layout change.
 */
function focusPanePatch(s: AppState, index: number): Partial<AppState> {
  const i = clampPaneIndex(index, paneCount(s));
  if (s.focusedPaneIndex === i) return s.focusedPane === 'main' ? {} : { focusedPane: 'main' };
  persistSplitState({ extraPanes: s.extraPanes, focusedPaneIndex: i });
  return { focusedPaneIndex: i, focusedPane: 'main' };
}

/**
 * FR-5: what the side columns do at `to` panes. Growing folds them WITHOUT
 * persisting; shrinking restores whatever the user had. FR-20: the first split
 * also clamps pane 0's tab and closes every dynamic tab (clearAgentTabs'
 * effect, inlined so entering split is one atomic set).
 */
function growPatch(s: AppState, from: number, to: number): Partial<AppState> {
  const patch: Partial<AppState> = columnPatch(layoutRegime(to));
  if (from === 1) {
    patch.mainTab = clampToPaneTab(s.mainTab);
    patch.agentTabs = [];
  }
  return patch;
}

function columnPatch(regime: LayoutRegime): Partial<AppState> {
  return {
    // The grid has no room for the roster (turn 5d) — it folds to the tile rail.
    showLeftPane: regime === 'grid' ? false : persistedLeftPane(),
    // Two panes fold the right column to its 46px icon rail; the grid drops it.
    showRightPane: regime === 'single' ? persistedRightPane() : false,
  };
}

/** FR-16: pane `i` becomes the single main pane. */
function unsplitPatch(s: AppState, i: number, tab?: PaneTab): Partial<AppState> {
  const slot = paneAt(s, i);
  persistSplitState({ ...NOT_SPLIT });
  return {
    ...NOT_SPLIT,
    activeSessionId: slot.sessionId,
    mainTab: (tab ?? slot.tab) as MainTab,
    ...columnPatch('single'),
  };
}

/**
 * FR-15/FR-17: rebuild the pane list from the kept indices (ascending). The
 * lowest kept pane becomes pane 0, so `activeSessionId`/`mainTab` follow when
 * pane 0 itself was dropped.
 */
function rebuildPatch(s: AppState, keepAsc: readonly number[], focusedBefore: number): Partial<AppState> {
  const slots = keepAsc.map((i) => paneAt(s, i));
  const head = slots[0];
  // Empty panes are KEPT: a pane the user deliberately opened does not vanish
  // because nothing has landed in it yet (FR-15).
  const extraPanes: PaneSlot[] = slots.slice(1).map((x) => ({ sessionId: x.sessionId, tab: x.tab }));
  const moved = keepAsc.indexOf(focusedBefore);
  const next: SplitState = {
    extraPanes,
    focusedPaneIndex: clampPaneIndex(moved === -1 ? 0 : moved, extraPanes.length + 1),
  };
  persistSplitState(next);
  return {
    ...next,
    activeSessionId: head.sessionId,
    mainTab: head.tab as MainTab,
    ...columnPatch(layoutRegime(extraPanes.length + 1)),
  };
}
