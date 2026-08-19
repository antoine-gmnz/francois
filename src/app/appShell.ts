// app-shell pure logic (App.tsx's decomposition — REFACTOR.md §6c/§7): the tab
// strip's label class, the shell footer's WSL-aware path, the main-pane
// tab → renderer-branch keying, and the single-letter global shortcuts'
// key → action Record. Kept here, framework-free, so it stays unit-testable
// without a component renderer (this project has none — see
// REFACTOR-CONVENTIONS.md).

import { displayWslCwd } from '../../contract/wsl-filesystem';
import { agentIdFromTab, workflowIdFromTab } from '../features/agents/agent-tab';
import { extIdFromTab } from '../features/extensions/extensions';
import type { LayoutRegime } from '../lib/layoutStore';
import { abbreviate } from '../lib/path';
import { clampRosterWidth } from '../lib/rosterWidth';
import type { MainTab, Pane } from '../lib/store';

// ---------- shell columns ----------

/**
 * The width both side columns fold to. A hidden column is never GONE — it keeps
 * this rail, so [1] and [3]–[6] stay one click away in every regime.
 */
const RAIL = '46px';
/**
 * The middle track's width — resizable-sidebar FR-1: this reproduces the 12px
 * `gap` the grid used to have between its two tracks, and IS the drag handle's
 * hit area (`RosterDivider` renders into it) rather than an overlay stealing
 * clicks from the roster's edge.
 */
const GUTTER = '12px';

export interface ShellColumns {
  /**
   * `grid-template-columns` for `.app-grid` — THREE tracks (left, the 12px
   * gutter, 1fr) when `showHandle` is true, or TWO (left, 1fr) when it's
   * false. The DOM must match: `App.tsx` renders `RosterDivider` into the
   * gutter track only when `showHandle` is true, so the track count has to
   * agree or CSS auto-placement drops `.app-main-cell` into the gutter track.
   */
  template: string;
  /** Render `SessionRail` in the first track instead of the roster. */
  leftRail: boolean;
  /** resizable-sidebar FR-11: false in the `grid` regime, where the roster is forced to the rail. */
  showHandle: boolean;
}

/**
 * The shell's tracks, given the pane regime, the roster toggle, and the
 * roster's stored width.
 *
 * design 7a dissolved the right column into the roster's own rows, so the only
 * column left to size is the roster. Its rule survives 7a unchanged: **folded
 * means the 46px rail, not nothing**, at any pane count — the grid used to drop
 * it outright, which left `[` toggling something that looked like a crash.
 *
 * resizable-sidebar: the roster's width is now user-set, not regime-picked.
 * `rosterWidth` is the STORED intent; the regime only constrains what fits —
 * `clampRosterWidth` applies the per-regime cap (tighter in `split`, since it
 * pays ~340px for the second pane) without ever touching the stored value.
 */
export function shellColumns(
  regime: LayoutRegime,
  showLeftPane: boolean,
  rosterWidth: number,
  viewportWidth: number,
): ShellColumns {
  const left = showLeftPane ? `${clampRosterWidth(rosterWidth, viewportWidth, regime)}px` : RAIL;
  const showHandle = regime !== 'grid';
  return { template: showHandle ? `${left} ${GUTTER} 1fr` : `${left} 1fr`, leftRail: !showLeftPane, showHandle };
}

// ---------- resizable split grid ----------

/**
 * Where one pane (or one divider) sits in the split grid.
 *
 * The grid interleaves GUTTER TRACKS with the pane tracks so a drag handle has
 * a cell of its own: columns are `pane | gutter | pane` and, in the 2×2
 * regimes, rows are too. That breaks CSS auto-placement — a pane would land in
 * a gutter — so every cell above two panes is placed explicitly. `undefined`
 * means "let the grid place it", which is what the one-row regimes want:
 * pane, divider, pane in DOM order fills `1 / 2 / 3` correctly by itself.
 */
export interface GridArea {
  gridColumn: string;
  gridRow: string;
}

/** Track indices: 1 = first pane, 2 = the gutter/handle, 3 = second pane. */
export function paneGridArea(index: number, panes: number): GridArea | undefined {
  if (panes <= 2) return undefined;
  // FR-2: at three panes the last one spans the whole bottom row rather than
  // leaving a hole — the same rule upstream draws with `grid-column: span 2`,
  // restated here because explicit placement overrides it.
  if (panes === 3 && index === 2) return { gridColumn: '1 / -1', gridRow: '3' };
  return { gridColumn: index % 2 === 0 ? '1' : '3', gridRow: index < 2 ? '1' : '3' };
}

/**
 * The vertical handle splits the two COLUMNS; the horizontal one splits the two
 * ROWS. At three panes the vertical handle covers the top row only — below it
 * the single wide pane has no column seam to drag.
 */
export function dividerGridArea(axis: 'x' | 'y', panes: number): GridArea | undefined {
  if (panes <= 2) return undefined;
  if (axis === 'y') return { gridColumn: '1 / -1', gridRow: '2' };
  return { gridColumn: '2', gridRow: panes === 3 ? '1' : '1 / -1' };
}

// ---------- split-by-4 (§5) ----------

// All three helpers are declared by specs/split-by-4.md §5 under this module.
// They are IMPLEMENTED in src/lib/layoutStore.ts, beside the `PaneTab` type and
// the store slice that needs `clampToPaneTab` inside its own `set()` — importing
// it the other way would make the two modules cyclic. Re-exported here so the
// spec's import path resolves.
export { clampToPaneTab, splitCandidate, splitCandidates } from '../lib/layoutStore';

// ---------- shell tab footer ----------

// Shell footer path (spec §8): WSL cwds render as '<distro>:/path'; when the
// shell name already names that distro (FR-12), drop the redundant prefix so
// the footer doesn't repeat it — '● Ubuntu · /home/u/api', not '· Ubuntu:/…'.
export function shellFooterPath(cwd: string, shellName: string, home: string): string {
  const wsl = displayWslCwd(cwd);
  if (!wsl) return abbreviate(cwd, home);
  const prefix = `${shellName}:`;
  return wsl.startsWith(prefix) ? wsl.slice(prefix.length) : wsl;
}

// ---------- main pane render branch (Phase 5 dispatch table) ----------

/**
 * Which `MainPaneBody` renderer a `mainTab` value selects. The dynamic tabs are
 * `agent:<id>`, `workflow:<id>` (workflow-details FR-11) and `ext:<id>`
 * (extensions FR-9) — template-literal
 * `MainTab` members, not plain keys — so they collapse to the `'agent'` /
 * `'workflow'` branches here and `MainPaneBody` handles those explicitly rather
 * than forcing them into the `Record<MainTab, renderer>` table.
 */
export type MainPaneBranch = 'overview' | 'session' | 'diff' | 'shell' | 'panel' | 'agent' | 'workflow' | 'ext';

export function mainPaneBranch(mainTab: MainTab): MainPaneBranch {
  if (mainTab === 'overview' || mainTab === 'session' || mainTab === 'diff' || mainTab === 'shell') return mainTab;
  if (isPanelTab(mainTab)) return 'panel';
  // extensions FR-9: `ext:<id>` is the third dynamic-tab kind. Checked before
  // the agent fallback, which claims everything it does not recognise.
  if (extIdFromTab(mainTab) !== null) return 'ext';
  return workflowIdFromTab(mainTab) !== null ? 'workflow' : 'agent';
}

// ---------- panel tabs (design 7a) ----------

/**
 * The four panes that used to be the right column. 7a dissolves that column into
 * the roster's quiet rows, so each one is now a main-pane tab. They are rendered
 * by a persistent host in App.tsx rather than by MainPaneBody: the panels own
 * their own feeds, and unmounting them on every tab switch would re-subscribe
 * (and lose the counts the roster rows read).
 */
export const PANEL_TABS = ['agents', 'mcp', 'skills', 'workflows'] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export function isPanelTab(tab: MainTab): tab is PanelTab {
  return (PANEL_TABS as readonly string[]).includes(tab);
}

/**
 * The tabs that describe ONE session's work — what the session row's segmented
 * control offers, and what makes its `Sessions` nav pill read as active. The
 * panel tabs and `overview` are session-independent, so they are not here.
 */
export function isSessionScopedTab(tab: MainTab): boolean {
  return tab !== 'overview' && !isPanelTab(tab);
}

// ---------- global shortcuts (Phase 5 dispatch table) ----------

/**
 * Everything `buildShortcutActions` needs to run one key's action. Mutations
 * either come straight from the component's own state setters (stable
 * zustand refs, already in the listener effect's dep array) or are read
 * fresh via the getters below — exactly what the original if/else chain did
 * by calling `useStore.getState()` inline — so the listener effect never
 * needs `mainTab` / `activeSessionId` in its own deps.
 */
export interface ShortcutActionsContext {
  preventDefault: () => void;
  getActiveSessionId: () => string | null;
  getMainTab: () => MainTab;
  getFocusedPane: () => Pane;
  setFocusedPane: (pane: Pane) => void;
  setMainTab: (tab: MainTab) => void;
  setNewSessionOpen: (open: boolean) => void;
  setNewAgentOpen: (open: boolean) => void;
  closeAgentTab: (agentId: string) => void;
  toggleLeftPane: () => void;
}

/**
 * design 7a: `3`–`6` used to focus a right-column pane. The column is gone, so
 * they open that pane's main tab instead — and, like `d`/`t`/`o`, a second press
 * returns to SESSION so the key is a toggle rather than a one-way door.
 */
function togglePanelTab(ctx: ShortcutActionsContext, pane: PanelTab): () => void {
  return () => {
    ctx.setFocusedPane('main');
    ctx.setMainTab(ctx.getMainTab() === pane ? 'session' : pane);
  };
}

/**
 * app-shell's minimal global keys: n (new session), a (new agent), 1/2 (focus
 * the roster / the pane), 3-6 (open a dissolved pane's main tab), d/t/o (toggle
 * diff/shell/overview ↔ session), w (close the active dynamic tab), [ (fold the
 * roster). Built fresh per keydown by the caller (which also builds `ctx` fresh
 * per keydown), so every branch always reads current state rather than a stale
 * render-time closure.
 */
export function buildShortcutActions(ctx: ShortcutActionsContext): Record<string, () => void> {
  const openNewSession = () => {
    ctx.preventDefault();
    ctx.setNewSessionOpen(true);
  };
  const openNewAgent = () => {
    if (ctx.getActiveSessionId()) {
      ctx.preventDefault();
      // design 7a: the modal lives inside AgentsPanel, which is a main tab now.
      ctx.setFocusedPane('main');
      ctx.setMainTab('agents');
      ctx.setNewAgentOpen(true);
    }
  };
  const toggleDiffTab = () => {
    ctx.setFocusedPane('main');
    ctx.setMainTab(ctx.getMainTab() === 'diff' ? 'session' : 'diff');
  };
  const toggleShellTab = () => {
    ctx.setFocusedPane('main');
    ctx.setMainTab(ctx.getMainTab() === 'shell' ? 'session' : 'shell');
  };
  const toggleOverviewTab = () => {
    ctx.setFocusedPane('main');
    ctx.setMainTab(ctx.getMainTab() === 'overview' ? 'session' : 'overview');
  };
  // `w` closes whichever DYNAMIC tab is active — an agent's or, since
  // workflow-details FR-12, a workflow run's. Both live in the same list.
  const closeActiveAgentTab = () => {
    const mainTab = ctx.getMainTab();
    const id = agentIdFromTab(mainTab) ?? workflowIdFromTab(mainTab);
    if (id !== null) {
      ctx.preventDefault();
      ctx.closeAgentTab(id);
    }
  };
  return {
    n: openNewSession,
    N: openNewSession,
    a: openNewAgent,
    A: openNewAgent,
    '1': () => ctx.setFocusedPane('sidebar'),
    '2': () => ctx.setFocusedPane('main'),
    '3': togglePanelTab(ctx, 'agents'),
    '4': togglePanelTab(ctx, 'mcp'),
    '5': togglePanelTab(ctx, 'skills'),
    '6': togglePanelTab(ctx, 'workflows'),
    d: toggleDiffTab,
    D: toggleDiffTab,
    t: toggleShellTab,
    T: toggleShellTab,
    o: toggleOverviewTab,
    O: toggleOverviewTab,
    w: closeActiveAgentTab,
    W: closeActiveAgentTab,
    // design 7a: `]` and `c` went with the right column they acted on — there
    // is no second column to hide and no card left to collapse. `[` still folds
    // the roster; the session row's chevron is the same control.
    '[': ctx.toggleLeftPane,
  };
}
