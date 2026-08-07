// app-shell pure logic (App.tsx's decomposition — REFACTOR.md §6c/§7): the tab
// strip's label class, the shell footer's WSL-aware path, the main-pane
// tab → renderer-branch keying, and the single-letter global shortcuts'
// key → action Record. Kept here, framework-free, so it stays unit-testable
// without a component renderer (this project has none — see
// REFACTOR-CONVENTIONS.md).

import { displayWslCwd } from '../../contract/wsl-filesystem';
import { agentIdFromTab, workflowIdFromTab } from '../features/agents/agent-tab';
import { isRightPane, type LayoutRegime } from '../lib/layoutStore';
import { abbreviate } from '../lib/path';
import type { MainTab, Pane, RightPane } from '../lib/store';

// ---------- shell columns ----------

/**
 * The width both side columns fold to. A hidden column is never GONE — it keeps
 * this rail, so [1] and [3]–[6] stay one click away in every regime.
 */
const RAIL = '46px';
/** The roster at one pane; it narrows once a second pane wants the width. */
const ROSTER = '276px';
const ROSTER_SPLIT = '238px';
const RIGHT_COLUMN = '296px';

export interface ShellColumns {
  /** `grid-template-columns` for `.app-grid` — always three tracks. */
  template: string;
  /** Render `SessionRail` in the first track instead of the roster. */
  leftRail: boolean;
  /** Render `RightRail` in the last track instead of the panel column. */
  rightRail: boolean;
}

/**
 * The shell's three tracks, given the pane regime and the two column toggles.
 *
 * The rule is regime-independent on purpose: **folded means the 46px rail, not
 * nothing** — on either side, at any pane count. The regime only decides how
 * wide the roster is when it IS shown (split pays ~340px for its second pane by
 * narrowing it). Before this, the grid dropped the right column outright while
 * two panes folded it to the rail, and the left column disappeared everywhere
 * except the grid — two sides behaving differently for no reason the user could
 * see.
 */
export function shellColumns(regime: LayoutRegime, showLeftPane: boolean, showRightPane: boolean): ShellColumns {
  const left = showLeftPane ? (regime === 'single' ? ROSTER : ROSTER_SPLIT) : RAIL;
  const right = showRightPane ? RIGHT_COLUMN : RAIL;
  return { template: `${left} 1fr ${right}`, leftRail: !showLeftPane, rightRail: !showRightPane };
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

// ---------- tab strip ----------

/** Main tab-strip label (OVERVIEW/SESSION/DIFF/SHELL): the `app-tab--on`
 * modifier recolors to the accent when it is the active main tab. */
export function tabClassName(active: boolean): string {
  return active ? 'app-tab app-tab--on' : 'app-tab';
}

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
 * `agent:<id>` and `workflow:<id>` (workflow-details FR-11) — template-literal
 * `MainTab` members, not plain keys — so they collapse to the `'agent'` /
 * `'workflow'` branches here and `MainPaneBody` handles those explicitly rather
 * than forcing them into the `Record<MainTab, renderer>` table.
 */
export type MainPaneBranch = 'overview' | 'session' | 'diff' | 'shell' | 'agent' | 'workflow';

export function mainPaneBranch(mainTab: MainTab): MainPaneBranch {
  if (mainTab === 'overview' || mainTab === 'session' || mainTab === 'diff' || mainTab === 'shell') return mainTab;
  return workflowIdFromTab(mainTab) !== null ? 'workflow' : 'agent';
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
  /** collapse-right-column FR-10: which pane `c` acts on. */
  getFocusedPane: () => Pane;
  setFocusedPane: (pane: Pane) => void;
  setMainTab: (tab: MainTab) => void;
  setNewSessionOpen: (open: boolean) => void;
  setNewAgentOpen: (open: boolean) => void;
  closeAgentTab: (agentId: string) => void;
  toggleLeftPane: () => void;
  toggleRightPane: () => void;
  /** collapse-right-column FR-10: `c` collapses the focused right pane. */
  toggleCollapsedPane: (pane: RightPane) => void;
}

/**
 * app-shell's minimal global keys: n (new session), a (new agent), 1-6 (pane
 * focus), d/t/o (toggle diff/shell/overview ↔ session), w (close the active
 * agent tab), [ / ] (toggle the side columns), c (collapse-right-column FR-10:
 * collapse the focused right pane). Built fresh per keydown by the caller
 * (which also builds `ctx` fresh per keydown), so every branch always reads
 * current state rather than a stale render-time closure.
 */
export function buildShortcutActions(ctx: ShortcutActionsContext): Record<string, () => void> {
  const openNewSession = () => {
    ctx.preventDefault();
    ctx.setNewSessionOpen(true);
  };
  const openNewAgent = () => {
    if (ctx.getActiveSessionId()) {
      ctx.preventDefault();
      ctx.setFocusedPane('agents');
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
  // FR-10: no-op from sidebar/main — a collapsed card can't own focus, so
  // there is nothing to collapse from those two panes.
  const collapseFocusedPane = () => {
    const pane = ctx.getFocusedPane();
    if (isRightPane(pane)) ctx.toggleCollapsedPane(pane);
  };
  return {
    n: openNewSession,
    N: openNewSession,
    a: openNewAgent,
    A: openNewAgent,
    '1': () => ctx.setFocusedPane('sidebar'),
    '2': () => ctx.setFocusedPane('main'),
    '3': () => ctx.setFocusedPane('agents'),
    '4': () => ctx.setFocusedPane('mcp'),
    '5': () => ctx.setFocusedPane('skills'),
    '6': () => ctx.setFocusedPane('workflows'),
    d: toggleDiffTab,
    D: toggleDiffTab,
    t: toggleShellTab,
    T: toggleShellTab,
    o: toggleOverviewTab,
    O: toggleOverviewTab,
    w: closeActiveAgentTab,
    W: closeActiveAgentTab,
    c: collapseFocusedPane,
    C: collapseFocusedPane,
    '[': ctx.toggleLeftPane,
    ']': ctx.toggleRightPane,
  };
}
