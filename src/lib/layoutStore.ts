// app-shell layout store slice: focused pane, left/right column visibility, and
// the modal-open flags lifted to the store so the command palette can open them.
// Split out of the former monolithic store.ts — see store.ts for the
// composition root.

import type { StateCreator } from 'zustand';
import type { ProjectId, SessionId, SessionMeta } from '../../contract/common';
import type { ShellId } from '../../contract/shell-terminal';
import { statusNeedsAttention } from '../../contract/fleet-board';
import { SHELL_CAP } from '../features/shell/shell';
import { shellDispose } from './api';
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

// ── split-by-4 / unbound-panes (specs/split-by-4.md §5, specs/unbound-panes.md §5) ──
// Up to four live panes at once. `activeSessionId` + `mainTab` keep their exact
// current meaning — THEY ARE PANE 0, ALWAYS A SESSION PANE (unbound-panes FR-4)
// — so no existing consumer changes semantics; panes 1..3 hang off `extraPanes`,
// persisted with the focused index as one record.

/**
 * What a pane can show. A strict subset of MainTab — everything except the
 * app-scoped `overview` and the four dissolved panel tabs, which are chrome
 * overlays rather than a session's view.
 *
 * fix-agent-view FR-3: this used to be the three built-in tabs alone. The
 * dynamic members joined when agent/workflow tabs became per-session, so a
 * split pane can show one.
 */
export type PaneTab = 'session' | 'diff' | 'shell' | `agent:${string}` | `workflow:${string}`;

/** The three tabs a pane's strip actually draws as buttons. */
export type BuiltinPaneTab = 'session' | 'diff' | 'shell';

/** fix-agent-view FR-3: is this one of the three built-ins? */
export function isBuiltinPaneTab(tab: string): tab is BuiltinPaneTab {
  return tab === 'session' || tab === 'diff' || tab === 'shell';
}

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
 * One pane AFTER pane 0 — a discriminated union (unbound-panes FR-4). A
 * `session` pane is what `split-by-4` always shipped: `sessionId: null` is
 * still the EMPTY pane, a real pane that takes focus, persists, and waits for
 * a session. A `shell` pane (unbound-panes FR-6) holds exactly one PTY rooted
 * at a registered PROJECT's root — `shellId` is runtime-only (FR-7), never
 * persisted (FR-17).
 */
export type PaneSlot =
  | { kind: 'session'; sessionId: SessionId | null; tab: PaneTab }
  | { kind: 'shell'; projectId: ProjectId; shellId: ShellId | null };

/** FR-15/FR-4: a fresh, empty SESSION pane — what a new extra pane starts as. */
function emptySessionSlot(): PaneSlot {
  return { kind: 'session', sessionId: null, tab: 'session' };
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
 * `canSplit` (unbound-panes FR-2: at least one session anywhere in the fleet)
 * gates only ENTERING a split. Once split, every button stays live — otherwise
 * a layout you are already in can strand you in it.
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
 * MainTab → the PaneTab a pane can show. `overview` and the four dissolved
 * panel tabs (`agents`/`mcp`/`skills`/`workflows`) clamp to 'session' — they are
 * chrome overlays over the whole main cell, not one session's view.
 *
 * fix-agent-view FR-3 narrowed this: the dynamic `agent:<id>` / `workflow:<id>`
 * tabs are PaneTab members now and pass straight through, so entering a
 * two-pane split no longer discards the tab you were reading (split-by-4 FR-20,
 * superseded). The GRID regime still hides them — see `denseTab`.
 *
 * Declared by split-by-4 §5 under `src/app/appShell.ts`, which re-exports it —
 * it lives here beside `PaneTab` because the store slice below needs it inside
 * its own `set()`, and importing it the other way would make the two modules
 * cyclic.
 */
export function clampToPaneTab(tab: MainTab): PaneTab {
  if (isBuiltinPaneTab(tab)) return tab;
  return tab.startsWith('agent:') || tab.startsWith('workflow:') ? (tab as PaneTab) : 'session';
}

/**
 * fix-agent-view FR-13: a pane's tab as the GRID regime can render it. At three
 * panes and up a pane is one surface with no tab strip (split-by-4 FR-9), so
 * there is nowhere to hang a chip and no way back off a dynamic tab — it reads
 * as `session` instead.
 *
 * Applied at READ time (`paneTabAt`) rather than written into the slot, so
 * shrinking back to two panes restores the tab the pane was really on.
 */
export function denseTab(tab: PaneTab): PaneTab {
  return isBuiltinPaneTab(tab) ? tab : 'session';
}

// ---------- pure pane readers ----------

type PaneReadable = Pick<AppState, 'activeSessionId' | 'mainTab' | 'extraPanes'>;

/** FR-1 */
export function paneCount(s: Pick<AppState, 'extraPanes'>): number {
  return 1 + s.extraPanes.length;
}

/** Pane `i` as a slot. Pane 0 is always coerced into a `session` slot
 *  (unbound-panes FR-4) so callers never special-case it. */
export function paneSlotAt(s: PaneReadable, i: number): PaneSlot {
  if (i === 0) return { kind: 'session', sessionId: s.activeSessionId, tab: paneTabAt(s, 0) };
  return s.extraPanes[i - 1] ?? emptySessionSlot();
}

/** Pane `i`'s session, or null (an out-of-range index, an empty session pane,
 *  or a shell pane — unbound-panes FR-6: a shell pane holds no session). */
export function paneSessionIdAt(s: PaneReadable, i: number): SessionId | null {
  if (i === 0) return s.activeSessionId;
  const p = s.extraPanes[i - 1];
  return p && p.kind === 'session' ? p.sessionId : null;
}

/**
 * Pane `i`'s tab. Pane 0's is `mainTab`, clamped — it may sit on OVERVIEW or on
 * one of the dissolved panel tabs. fix-agent-view FR-13: in the GRID regime the
 * result is additionally flattened by `denseTab`, since a dense pane has no
 * strip to carry a dynamic tab's chip. A shell pane has no PaneTab of its own
 * (unbound-panes FR-6/FR-11: no tab strip at all) — reads as 'session', which
 * is never actually rendered since callers check `paneSlotAt`'s `kind` first.
 */
export function paneTabAt(s: PaneReadable, i: number): PaneTab {
  const raw = i === 0 ? clampToPaneTab(s.mainTab) : paneTabRaw(s.extraPanes[i - 1]);
  return layoutRegime(paneCount(s)) === 'grid' ? denseTab(raw) : raw;
}
function paneTabRaw(p: PaneSlot | undefined): PaneTab {
  if (!p) return 'session';
  return p.kind === 'session' ? p.tab : 'session';
}

/** unbound-panes FR-5/FR-16: every pane index showing `sessionId` — a session
 *  may occupy any number of panes now, so this replaces the old `paneIndexOf`
 *  (which answered with the first/only one). */
export function paneIndicesOf(s: PaneReadable, sessionId: SessionId): number[] {
  const out: number[] = [];
  if (s.activeSessionId === sessionId) out.push(0);
  s.extraPanes.forEach((p, i) => {
    if (p.kind === 'session' && p.sessionId === sessionId) out.push(i + 1);
  });
  return out;
}

/**
 * FR-13: the session the user is looking at — what the titlebar quota, the right
 * column, the status bar, the palette's session-scoped commands and the
 * single-letter globals read. Derived, never stored. At one pane it equals
 * `activeSessionId`, so every existing consumer is behaviour-identical outside
 * split.
 *
 * unbound-panes FR-12: when the focused pane is a SHELL pane, this falls back
 * to `lastFocusedSessionId` — the most recently focused session pane — so
 * nothing blanks. It stays null only when no session pane has ever been
 * focused this run (an empty focused SESSION pane still answers null: it
 * genuinely shows nothing).
 */
export function focusedSessionId(
  s: PaneReadable & Pick<AppState, 'focusedPaneIndex' | 'lastFocusedSessionId'>,
): SessionId | null {
  const i = clampPaneIndex(s.focusedPaneIndex, paneCount(s));
  const id = paneSessionIdAt(s, i);
  if (id !== null) return id;
  const slot = paneSlotAt(s, i);
  return slot.kind === 'shell' ? s.lastFocusedSessionId : null;
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
 * otherwise (a session in two panes counts once; a shell pane contributes
 * nothing). The notification gate suppresses `turnDone` for all of them, not
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
 * `mainTab` pair is no longer the whole answer. A `shell`-KIND pane never
 * matches here — it is not a session's SHELL tab, it is its own PTY.
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
 * unbound-panes FR-3: the `n` most recently active sessions in the WHOLE
 * FLEET that no pane already holds, by `lastActivityAt` desc — `splitCandidates`
 * lost its scope argument (supersedes split-by-4 FR-15's project-scoped read).
 * Re-exported by `src/app/appShell.ts` per §5.
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

/**
 * unbound-panes FR-8: which of `panes` (the extras, 1..MAX_PANES-1) gets
 * promoted into slot 0 when pane 0 closes — the first SESSION-kind pane, so a
 * shell pane never leaps ahead of a session one. `null` ⇒ none of them is a
 * session pane, so pane 0 clears instead (edge case 6).
 */
export function promotionTarget(panes: readonly PaneSlot[]): number | null {
  const i = panes.findIndex((p) => p.kind === 'session');
  return i === -1 ? null : i;
}

/**
 * unbound-panes FR-15: the grid session rail's order — every session currently
 * in a pane first (pinned, so a paned session is never scrolled out of reach),
 * then the rest — both groups `lastActivityAt` desc, the same order
 * `splitCandidates`/`⊞` uses, so the rail and the fill button never disagree.
 */
export function railOrder(sessions: readonly SessionMeta[], paned: readonly SessionId[]): SessionMeta[] {
  const pinnedSet = new Set(paned);
  const byRecency = (a: SessionMeta, b: SessionMeta) => b.lastActivityAt - a.lastActivityAt;
  const pinned = sessions.filter((s) => pinnedSet.has(s.id)).sort(byRecency);
  const rest = sessions.filter((s) => !pinnedSet.has(s.id)).sort(byRecency);
  return [...pinned, ...rest];
}

/**
 * unbound-panes FR-15 / design brief — how many tiles the rail pins to the top,
 * which is exactly where the 1px hairline separating them from the rest goes.
 * Zero when nothing is paned OR when EVERY tile is pinned: a hairline with no
 * `rest` below it would read as a rule under the whole rail.
 */
export function railPinnedCount(sessions: readonly SessionMeta[], paned: readonly SessionId[]): number {
  const pinnedSet = new Set(paned);
  const n = sessions.filter((s) => pinnedSet.has(s.id)).length;
  return n === sessions.length ? 0 : n;
}

/**
 * unbound-panes FR-9: may an "open a shell here" entry point be offered at all?
 * A shell pane needs a slot to live in AND a registered project to be rooted at
 * — every one of the four entry points (empty pane, palette, pane header menu,
 * roster project row) gates on the same two facts.
 */
export function canOpenShellPane(panes: number, registeredProjectCount: number): boolean {
  return panes < MAX_PANES && registeredProjectCount > 0;
}

/**
 * unbound-panes edge case 4: once a project's currently-open shell panes hit
 * `SHELL_CAP` (mirrors `shell_create`'s `SHELL_LIMIT_REACHED`, per-owner), no
 * further shell-pane entry point may offer it until one closes. A shell pane's
 * `shellId` is never persisted (FR-17) and this is a single-window desktop app,
 * so the currently-open `extraPanes` ARE the live count — no separate fetch.
 */
export function projectShellPaneCount(extraPanes: readonly PaneSlot[], projectId: ProjectId): number {
  return extraPanes.filter((p) => p.kind === 'shell' && p.projectId === projectId).length;
}

/**
 * unbound-panes edge case 4: the registered projects a shell pane may still be
 * rooted at — a live root AND under the per-owner shell cap. Every shell-pane
 * entry point (project picker, pane header menu, empty-pane "Open a shell
 * here", the palette's "New shell pane") filters through this one function so
 * they can never disagree.
 */
export function shellPaneEligibleProjects<T extends { id: ProjectId; rootExists: boolean }>(
  projects: readonly T[],
  extraPanes: readonly PaneSlot[],
): T[] {
  return projects.filter((p) => p.rootExists && projectShellPaneCount(extraPanes, p.id) < SHELL_CAP);
}

// ---------- persistence ----------

function readPaneSlot(raw: unknown): PaneSlot | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  // unbound-panes FR-17: the union shape's shell variant. `shellId` is never
  // persisted (runtime-only, FR-7) — a hydrated shell pane always starts fresh.
  if (obj.kind === 'shell') {
    const projectId = obj.projectId;
    if (typeof projectId !== 'string' || projectId.length === 0) return null;
    return { kind: 'shell', projectId, shellId: null };
  }

  // The union shape's session variant AND the split-by-4 shape (no `kind` at
  // all) both read as a session pane — a bare `{sessionId, tab}` record is
  // exactly what split-by-4 persisted.
  const id = obj.sessionId;
  // An EMPTY pane round-trips: the split is the user's layout choice, and it
  // survives a reload whether or not a session has landed in it yet.
  const sessionId = typeof id === 'string' && id.length > 0 ? id : null;
  if (id !== null && sessionId === null) return null; // anything else is garbage
  const tab = obj.tab;
  // fix-agent-view §6: only the three BUILT-IN tabs survive a reload. `PaneTab`
  // widened to carry `agent:<id>` / `workflow:<id>`, but those live in memory
  // only (FR-1) — a persisted one would index into an empty map and strand the
  // pane on a tab with no chip and no body, so it degrades to 'session' here.
  return { kind: 'session', sessionId, tab: tab === 'diff' || tab === 'shell' ? tab : 'session' };
}

/**
 * Pure, exported for tests (FR-23/unbound-panes FR-17): normalizes whatever
 * came out of localStorage. A malformed, non-object, array or partially-typed
 * value returns the not-split default rather than throwing. Three record
 * generations load: the union shape (session AND shell panes), the plain
 * split-by-4 shape (a bare `{sessionId, tab}` reads as `kind: 'session'`), and
 * the legacy split-session shape (`{ splitSessionId, splitTab, focusedSide }`),
 * which loads as one extra pane.
 *
 * unbound-panes FR-5 deletes split-by-4 FR-19's duplicate-drop: a session may
 * legitimately sit in more than one persisted pane now, so no de-duplication
 * happens here any more.
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
      extraPanes: [
        { kind: 'session', sessionId: obj.splitSessionId, tab: tab === 'diff' || tab === 'shell' ? tab : 'session' },
      ],
      focusedPaneIndex: obj.focusedSide === 'right' ? 1 : 0,
    };
  }

  if (!Array.isArray(obj.extraPanes)) return { ...NOT_SPLIT };
  const extraPanes: PaneSlot[] = [];
  for (const entry of obj.extraPanes) {
    const slot = readPaneSlot(entry);
    if (!slot) continue;
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

/** unbound-panes FR-17: a shell pane's `shellId` is runtime-only — stripped on write. */
function serializePane(p: PaneSlot): unknown {
  if (p.kind === 'shell') return { kind: 'shell', projectId: p.projectId };
  return { kind: 'session', sessionId: p.sessionId, tab: p.tab };
}

/** FR-23: written on every change. Exported so sessionsStore's FR-27 removal
 *  path can record the compacted grid without duplicating the key. */
export function persistSplitState(state: SplitState): void {
  try {
    const record = { extraPanes: state.extraPanes.map(serializePane), focusedPaneIndex: state.focusedPaneIndex };
    localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* ignore */
  }
}

// ── split dividers ──────────────────────────────────────────────────────────
// How the panes share the main cell: one ratio per axis — columns everywhere,
// rows only in the 2×2 regimes. Kept in their OWN storage keys rather than
// inside the split record: they are lasting layout preferences, and the record
// is wiped on every unsplit — the next split would forget the geometry.

export const SPLIT_RATIO_STORAGE_KEY = 'francois.splitRatio';
export const SPLIT_ROW_RATIO_STORAGE_KEY = 'francois.splitRowRatio';
/** The first pane's share of the main cell, on either axis. */
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
/**
 * The row equivalent. Lower than the column minimum because a pane costs its
 * height in fixed chrome (header + tab strip ≈ 60px) and everything below that
 * is transcript — a short pane is cramped where a narrow one is unusable.
 */
export const MIN_SPLIT_PANE_ROW_PX = 180;

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
 * Pure: the pointer's position against the split grid's box → the first pane's
 * share of that axis. Axis-agnostic — `(clientX, left, width)` for the column
 * handle, `(clientY, top, height)` for the row one.
 *
 * Clamped by BOTH the ratio bounds and `minPx`, so neither pane can be dragged
 * down to an unreadable sliver. A cell too small to give both panes their
 * minimum degrades to an even split rather than fighting itself.
 */
export function splitRatioFromDrag(pos: number, start: number, size: number, minPx = MIN_SPLIT_PANE_PX): number {
  if (!Number.isFinite(size) || size <= 0) return DEFAULT_SPLIT_RATIO;
  const pxBound = minPx / size;
  const lo = Math.max(MIN_SPLIT_RATIO, Math.min(pxBound, DEFAULT_SPLIT_RATIO));
  const hi = Math.min(MAX_SPLIT_RATIO, Math.max(1 - pxBound, DEFAULT_SPLIT_RATIO));
  return clampSplitRatio(Math.min(Math.max((pos - start) / size, lo), hi));
}

function loadRatio(key: string): number {
  try {
    return parseSplitRatio(localStorage.getItem(key));
  } catch {
    return DEFAULT_SPLIT_RATIO;
  }
}
function persistRatio(key: string, ratio: number): void {
  try {
    localStorage.setItem(key, String(ratio));
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

/** FR-27: `extraPanes` with every SESSION pane on `sessionId` removed — a shell
 *  pane never matches (it carries no session). */
export function panesWithout(extraPanes: readonly PaneSlot[], sessionId: SessionId): PaneSlot[] {
  return extraPanes.filter((p) => !(p.kind === 'session' && p.sessionId === sessionId));
}

/** unbound-panes FR-17: `extraPanes` with every SHELL pane whose project is no
 *  longer registered dropped — like a stale session pane (split-by-4 FR-24). */
export function panesWithoutStaleProjects(extraPanes: readonly PaneSlot[], validProjectIds: ReadonlySet<ProjectId>): PaneSlot[] {
  return extraPanes.filter((p) => !(p.kind === 'shell' && !validProjectIds.has(p.projectId)));
}

/** Dispose the PTY behind every shell pane in `dropped` — FR-10. */
function disposeShellPanes(dropped: readonly PaneSlot[]): void {
  for (const p of dropped) {
    if (p.kind === 'shell' && p.shellId) void shellDispose(p.shellId).catch(() => {});
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
  // cloud-sessions FR-14: the "Adopt cloud session" modal. Lifted here — like
  // newSessionOpen — because both the pane [1] action beside "New session" and
  // the ⌘K command open the same one. Never persisted: a modal is not layout.
  adoptCloudOpen: boolean;
  setAdoptCloudOpen: (o: boolean) => void;
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
  /** unbound-panes FR-12: the session of the most recently focused SESSION
   *  pane — what `focusedSessionId` falls back to while a shell pane has focus. */
  lastFocusedSessionId: SessionId | null;
  /**
   * FR-18: append a pane holding `sessionId` and focus it. A session already on
   * screen is FOCUSED instead of duplicated; a full grid is a no-op. Also
   * applies FR-5 (fold the columns WITHOUT persisting) and FR-20 (clamp pane
   * 0's tab, close every dynamic tab).
   */
  openInNewPane: (sessionId: SessionId) => void;
  /**
   * unbound-panes FR-5: put `sessionId` in the FOCUSED pane. A PLAIN assign —
   * split-by-4 FR-19's swap-on-reassign is gone, since a session may now sit in
   * any number of panes at once. No-op at pane 0 — that path is
   * `setActiveSessionId`, which owns the agent-tab reset.
   */
  assignToFocusedPane: (sessionId: SessionId) => void;
  /** FR-15: the titlebar control — grow to / shrink to `n` panes (1..MAX_PANES). */
  setPaneCount: (n: number) => void;
  /**
   * FR-16: leave split, keeping pane `index`'s session and tab as the single
   * pane. Defaults to the focused pane; `tab` overrides the pane's own (Review
   * diff). No-op when not split. unbound-panes FR-8/FR-10: every shell pane
   * dropped by leaving split is disposed; a shell-kind promoted pane coerces to
   * an empty session pane (pane 0 is always a session).
   */
  unsplit: (index?: number, tab?: PaneTab) => void;
  /**
   * FR-17: drop pane `index`; the grid compacts. No-op at one pane.
   * unbound-panes FR-8: closing pane 0 promotes the next SESSION pane
   * (`promotionTarget`), not simply pane 1; with none left, pane 0 clears
   * instead and the shell panes keep their slots. FR-10: a closed shell pane's
   * PTY is disposed.
   */
  closePane: (index: number) => void;
  setPaneTab: (index: number, tab: PaneTab) => void;
  /** FR-12. Also sets focusedPane = 'main'. */
  setFocusedPaneIndex: (index: number) => void;
  /** FR-14: `⌥⇥` — the next pane parked on an approval or a question. Skips
   *  shell panes — they never wait on you (unbound-panes edge case 8). */
  focusNextWaitingPane: () => void;
  /**
   * unbound-panes FR-9/FR-7: append (or fill the first empty pane with) a
   * SHELL pane rooted at `projectId`, and focus it. Its PTY is spawned by the
   * pane component on mount (FR-7) — this only reserves the slot.
   */
  openShellPane: (projectId: ProjectId) => void;
  /** unbound-panes FR-9: turn pane `index` into a shell pane. No-op at index 0
   *  (FR-8). Disposes whatever shell used to be there (FR-10). */
  convertPaneToShell: (index: number, projectId: ProjectId) => void;
  /** unbound-panes FR-7: record the spawned shell for pane `index`, in memory only. */
  setPaneShellId: (index: number, shellId: ShellId | null) => void;
  /**
   * The left column's share of the main cell's WIDTH, and — in the 2×2 regimes
   * — the top row's share of its HEIGHT. Both are dragged from the divider on
   * that axis, clamped, and persisted on their own keys, so they survive
   * leaving and re-entering split.
   */
  splitRatio: number;
  setSplitRatio: (ratio: number) => void;
  splitRowRatio: number;
  setSplitRowRatio: (ratio: number) => void;
}

/**
 * unbound-panes FR-12: what `lastFocusedSessionId` should read the instant the
 * store exists — BEFORE the `useStore.subscribe` in store.ts ever runs. Pane 0
 * (`activeSessionId`) is always null this early (sessions arrive later over the
 * fleet sync), so this reads only the hydrated `SplitState`: the focused extra
 * pane's session if it has one, else the first session-holding extra pane. A
 * persisted `focusedPaneIndex` pointing at a SHELL pane (a normal quit/reopen —
 * FR-17) must still resolve to a real session here, or every consumer of
 * `focusedSessionId` (titlebar quota, [3]-[6], status bar, palette, AccountChip)
 * blanks on load until the user manually refocuses a session pane.
 */
export function initialLastFocusedSessionId(split: SplitState): SessionId | null {
  const readable: PaneReadable = { activeSessionId: null, mainTab: 'session', extraPanes: split.extraPanes };
  const count = paneCount(readable);
  const focused = clampPaneIndex(split.focusedPaneIndex, count);
  const direct = paneSessionIdAt(readable, focused);
  if (direct !== null) return direct;
  for (let i = 0; i < count; i++) {
    const id = paneSessionIdAt(readable, i);
    if (id !== null) return id;
  }
  return null;
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
  adoptCloudOpen: false,
  setAdoptCloudOpen: (adoptCloudOpen) => set({ adoptCloudOpen }),
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

  // ---------- split-by-4 / unbound-panes ----------
  extraPanes: INITIAL_SPLIT.extraPanes,
  focusedPaneIndex: INITIAL_SPLIT.focusedPaneIndex,
  lastFocusedSessionId: initialLastFocusedSessionId(INITIAL_SPLIT),

  openInNewPane: (sessionId) =>
    set((s) => {
      // Already on screen (its roster row, its rail tile, its context menu):
      // this is a FOCUS, not an assignment — the pane keeps whichever tab it is
      // on, and the session is never shown twice by THIS action (FR-19).
      const existing = paneIndicesOf(s, sessionId)[0];
      if (existing !== undefined) return focusPanePatch(s, existing);

      // An EMPTY session pane is already the room this was going to make — fill
      // the first one rather than opening a second waiting pane beside it.
      const empty = s.extraPanes.findIndex((p) => p.kind === 'session' && p.sessionId === null);
      if (empty !== -1) {
        const filled = s.extraPanes.slice();
        filled[empty] = { kind: 'session', sessionId, tab: 'session' };
        persistSplitState({ extraPanes: filled, focusedPaneIndex: empty + 1 });
        return { extraPanes: filled, focusedPaneIndex: empty + 1, focusedPane: 'main' };
      }

      const count = paneCount(s);
      if (count >= MAX_PANES) return {}; // FR-18: no room
      // FR-18: a session landing in a new pane opens on SESSION.
      const extraPanes = [...s.extraPanes, { kind: 'session', sessionId, tab: 'session' } as PaneSlot];
      const next: SplitState = { extraPanes, focusedPaneIndex: extraPanes.length };
      persistSplitState(next);
      return { ...next, focusedPane: 'main', ...growPatch(s, count, count + 1) };
    }),

  assignToFocusedPane: (sessionId) =>
    set((s) => {
      const count = paneCount(s);
      const i = clampPaneIndex(s.focusedPaneIndex, count);
      if (i === 0) return {}; // caller uses setActiveSessionId — it owns the tab reset
      const cur = s.extraPanes[i - 1];
      if (cur && cur.kind === 'session' && cur.sessionId === sessionId) return focusPanePatch(s, i);

      // unbound-panes FR-5: a PLAIN assign — a session already sitting in
      // another pane is simply duplicated, never swapped out of it.
      const extraPanes = s.extraPanes.slice();
      extraPanes[i - 1] = { kind: 'session', sessionId, tab: 'session' };
      persistSplitState({ extraPanes, focusedPaneIndex: s.focusedPaneIndex });
      if (cur?.kind === 'shell' && cur.shellId) void shellDispose(cur.shellId).catch(() => {});
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
        // unbound-panes FR-10: every shell pane being dropped is disposed.
        const keptExtra = new Set(keep.filter((i) => i > 0).map((i) => i - 1));
        disposeShellPanes(s.extraPanes.filter((_, idx) => !keptExtra.has(idx)));
        return rebuildPatch(s, keep, focused);
      }

      // unbound-panes FR-3: grow with the most recently active sessions in the
      // WHOLE FLEET not already in a pane, and pad the rest with EMPTY panes —
      // a project holding one session still splits, you just get a pane
      // waiting for its second.
      const add = splitCandidates(s.sessions, visibleSessionIds(s), target - count);
      const slots: PaneSlot[] = Array.from({ length: target - count }, (_, k) => ({
        kind: 'session',
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

      if (closed === 0) {
        // unbound-panes FR-8: promote the next SESSION pane, not simply pane 1.
        const target = promotionTarget(s.extraPanes);
        if (target === null) {
          // No session pane left to promote — pane 0 clears; the shell panes
          // keep their slots below it, and nothing is disposed.
          return { activeSessionId: null, mainTab: 'session' as MainTab };
        }
        const promoted = s.extraPanes[target];
        const extraPanes = s.extraPanes.filter((_, i) => i !== target);
        const focused = clampPaneIndex(s.focusedPaneIndex, count);
        const nextFocused = focused === 0 || focused === target + 1 ? 0 : focused < target + 1 ? focused : focused - 1;
        const next: SplitState = { extraPanes, focusedPaneIndex: clampPaneIndex(nextFocused, extraPanes.length + 1) };
        persistSplitState(next);
        return {
          ...next,
          activeSessionId: promoted.kind === 'session' ? promoted.sessionId : null,
          mainTab: (promoted.kind === 'session' ? promoted.tab : 'session') as MainTab,
        };
      }

      const dropped = s.extraPanes[closed - 1];
      if (dropped) disposeShellPanes([dropped]); // FR-10

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
      const cur = s.extraPanes[i - 1];
      if (!cur || cur.kind !== 'session' || cur.tab === tab) return {};
      const extraPanes = s.extraPanes.slice();
      extraPanes[i - 1] = { ...cur, tab };
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

  openShellPane: (projectId) =>
    set((s) => {
      const empty = s.extraPanes.findIndex((p) => p.kind === 'session' && p.sessionId === null);
      if (empty !== -1) {
        const extraPanes = s.extraPanes.slice();
        extraPanes[empty] = { kind: 'shell', projectId, shellId: null };
        const next: SplitState = { extraPanes, focusedPaneIndex: empty + 1 };
        persistSplitState(next);
        return { ...next, focusedPane: 'main' };
      }
      const count = paneCount(s);
      if (count >= MAX_PANES) return {};
      const extraPanes = [...s.extraPanes, { kind: 'shell', projectId, shellId: null } as PaneSlot];
      const next: SplitState = { extraPanes, focusedPaneIndex: extraPanes.length };
      persistSplitState(next);
      return { ...next, focusedPane: 'main', ...growPatch(s, count, extraPanes.length + 1) };
    }),

  convertPaneToShell: (index, projectId) =>
    set((s) => {
      const i = clampPaneIndex(index, paneCount(s));
      if (i === 0) return {}; // FR-8: pane 0 is always a session pane
      const old = s.extraPanes[i - 1];
      const extraPanes = s.extraPanes.slice();
      extraPanes[i - 1] = { kind: 'shell', projectId, shellId: null };
      persistSplitState({ extraPanes, focusedPaneIndex: s.focusedPaneIndex });
      if (old) disposeShellPanes([old]); // FR-10: dispose whatever used to be there
      return { extraPanes };
    }),

  setPaneShellId: (index, shellId) =>
    set((s) => {
      const i = clampPaneIndex(index, paneCount(s));
      if (i === 0) return {};
      const p = s.extraPanes[i - 1];
      if (!p || p.kind !== 'shell') return {};
      const extraPanes = s.extraPanes.slice();
      extraPanes[i - 1] = { ...p, shellId };
      // FR-17: `shellId` is runtime-only — no persistSplitState call here.
      return { extraPanes };
    }),

  splitRatio: loadRatio(SPLIT_RATIO_STORAGE_KEY),

  setSplitRatio: (ratio) =>
    set((s) => {
      const splitRatio = clampSplitRatio(ratio);
      // Called on every pointermove of a drag — the no-op path must not write.
      if (splitRatio === s.splitRatio) return {};
      persistRatio(SPLIT_RATIO_STORAGE_KEY, splitRatio);
      return { splitRatio };
    }),

  splitRowRatio: loadRatio(SPLIT_ROW_RATIO_STORAGE_KEY),

  setSplitRowRatio: (ratio) =>
    set((s) => {
      const splitRowRatio = clampSplitRatio(ratio);
      if (splitRowRatio === s.splitRowRatio) return {};
      persistRatio(SPLIT_ROW_RATIO_STORAGE_KEY, splitRowRatio);
      return { splitRowRatio };
    }),
});

// ---------- shared patch builders (pure, module-private) ----------

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
    // fix-agent-view FR-10 (supersedes split-by-4 FR-20's second half): entering
    // split closes NOTHING. Dynamic tabs are keyed by session and every pane
    // renders its own session's, so pane 0 keeps the agent tab it was on. Only
    // `overview` and the dissolved panel tabs still clamp — they are overlays
    // over the whole main cell, and the grid regime flattens the rest at read
    // time (`denseTab`) rather than by wiping state here.
    patch.mainTab = clampToPaneTab(s.mainTab);
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

/** Pane `i` as a slot — the shape rebuildPatch and unsplitPatch shuffle. */
function paneAt(s: AppState, i: number): PaneSlot {
  return paneSlotAt(s, i);
}

/**
 * FR-16: pane `i` becomes the single main pane. unbound-panes FR-8/FR-10: every
 * extra pane is gone once this settles, so every shell among them is disposed;
 * a shell-kind promoted slot (only reachable if `i` itself was a shell pane)
 * coerces to an empty session pane, since pane 0 is always a session.
 */
function unsplitPatch(s: AppState, i: number, tab?: PaneTab): Partial<AppState> {
  const slot = paneAt(s, i);
  disposeShellPanes(s.extraPanes);
  persistSplitState({ ...NOT_SPLIT });
  return {
    ...NOT_SPLIT,
    activeSessionId: slot.kind === 'session' ? slot.sessionId : null,
    mainTab: (tab ?? (slot.kind === 'session' ? slot.tab : 'session')) as MainTab,
    ...columnPatch('single'),
  };
}

/**
 * FR-15/FR-17: rebuild the pane list from the kept indices (ascending). Index 0
 * is always kept by every caller of this function (only the dedicated
 * `closePane(0)` branch above ever drops it), so `head` is always a session
 * slot — no shell-at-pane-0 coercion is needed here.
 */
function rebuildPatch(s: AppState, keepAsc: readonly number[], focusedBefore: number): Partial<AppState> {
  const slots = keepAsc.map((i) => paneAt(s, i));
  const head = slots[0];
  // Empty panes are KEPT: a pane the user deliberately opened does not vanish
  // because nothing has landed in it yet (FR-15).
  const extraPanes: PaneSlot[] = slots.slice(1);
  const moved = keepAsc.indexOf(focusedBefore);
  const next: SplitState = {
    extraPanes,
    focusedPaneIndex: clampPaneIndex(moved === -1 ? 0 : moved, extraPanes.length + 1),
  };
  persistSplitState(next);
  return {
    ...next,
    activeSessionId: head.kind === 'session' ? head.sessionId : null,
    mainTab: (head.kind === 'session' ? head.tab : 'session') as MainTab,
    ...columnPatch(layoutRegime(extraPanes.length + 1)),
  };
}
