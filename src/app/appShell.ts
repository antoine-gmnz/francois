// app-shell pure logic (App.tsx's decomposition — REFACTOR.md §6c/§7): the tab
// strip's label class, the shell footer's WSL-aware path, the main-pane
// tab → renderer-branch keying, and the single-letter global shortcuts'
// key → action Record. Kept here, framework-free, so it stays unit-testable
// without a component renderer (this project has none — see
// REFACTOR-CONVENTIONS.md).

import { displayWslCwd } from '../../contract/wsl-filesystem';
import { agentIdFromTab, workflowIdFromTab } from '../features/agents/agent-tab';
import { isRightPane } from '../lib/layoutStore';
import { abbreviate } from '../lib/path';
import type { MainTab, Pane, RightPane } from '../lib/store';

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
