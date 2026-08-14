// agent-tab store slice: each pane's active tab + the open dynamic tabs
// (agent-tab §6 FR-9..FR-14, as re-homed by fix-agent-view FR-1..FR-10).
// Split out of the former monolithic store.ts — see store.ts for the
// composition root.
//
// fix-agent-view: `agentTabs` is a MAP keyed by session id, not one flat list.
// A dynamic tab belongs to a session, not to the shell — which is what lets
// every pane carry its own tabs and lets a session switch keep them rather than
// closing them.
//
// Cross-slice coupling: the initial `mainTab` reads projectsStore's
// `INITIAL_ACTIVE_PROJECT` (FR-3: which tab the app opens on). sessionsStore.ts
// owns the session-switch and session-removal paths, since both are keyed off
// `activeSessionId` rather than off anything this slice owns.

import type { StateCreator } from 'zustand';
import type { SessionId } from '../../contract/common';
import {
  agentIdFromTab,
  closeTabIn,
  mainTabAfterClose,
  openTabIn,
  syncTabIn,
  tabIdFor,
  workflowIdFromTab,
  type AgentTabMap,
  type AgentTabRef,
} from '../features/agents/agent-tab';
import { clampToPaneTab, layoutRegime, paneCount, paneIndexOf, persistSplitState, type PaneTab } from './layoutStore';
import { INITIAL_ACTIVE_PROJECT } from './projectsStore';
import type { AppState } from './store';

/**
 * A pane's active tab, plus the values only the main CELL can show: `overview`,
 * and — since design 7a dissolved the right column — the four panel tabs, which
 * overlay the whole cell rather than being one session's view. Template-literal
 * members rather than a discriminated object so every existing
 * `mainTab === 'diff'` comparison keeps working untouched.
 */
export type MainTab =
  | 'overview'
  | 'agents'
  | 'mcp'
  | 'skills'
  | 'workflows'
  // extensions FR-9: one main-pane tab per available extension, after SHELL.
  // Unlike an agent/workflow tab it is NOT session-scoped — extensions FR-12
  // keeps it open across a session change, so `clearAgentTabs` deliberately
  // leaves it be (`mainTabAfterClose` only ever rewrites an agent/workflow tab).
  | `ext:${string}`
  | PaneTab;

export interface AgentTabSlice {
  // PANE 0's active tab (panes 1..3 carry their own in `extraPanes`)
  mainTab: MainTab;
  setMainTab: (t: MainTab) => void;

  /**
   * fix-agent-view FR-1: the open DYNAMIC tabs — agent tabs and workflow tabs
   * alike (`ref.kind`) — keyed by the session that owns them, each list in the
   * order it was opened. The 6-tab cap (FR-2) counts per session. Never
   * persisted: a reload starts with an empty map.
   */
  agentTabs: AgentTabMap;
  /** FR-4: open (or re-activate) a ref's tab and make it active in the pane holding `sessionId`. */
  openAgentTab: (sessionId: SessionId, ref: AgentTabRef) => void;
  /**
   * FR-21: record a newly SEEN agent's tab in its session's strip without
   * activating it, so a subagent shows up as a chip on its own instead of only
   * after a trip through the AGENTS view. Called once per agent, on its first
   * `agent.update` — see useSessionFleetSync, which owns the first-sighting
   * bookkeeping. Calling it again for an agent whose chip you closed would
   * simply reopen it, which is why the guard lives at the one call site rather
   * than in a second "dismissed" set here.
   */
  trackAgentTab: (sessionId: SessionId, ref: AgentTabRef) => void;
  /** FR-6: refresh an OPEN tab's name/status from an agent.update / workflow.update; never opens one. */
  syncAgentTab: (ref: AgentTabRef) => void;
  /** FR-6: close one tab; every pane showing it falls back to SESSION. */
  closeAgentTab: (id: string) => void;
  /** FR-7: close every dynamic tab, in every session (the All-projects widen). */
  clearAgentTabs: () => void;
}

/**
 * FR-6/FR-7: apply `mainTabAfterClose` to EVERY pane. Only panes actually
 * sitting on a closed tab are written, so an untouched pane never re-renders —
 * and the split record is only rewritten when a pane really moved.
 */
function foldPanesBack(s: AppState, closedIds: string[] | null): Partial<AppState> {
  const patch: Partial<AppState> = {};
  const mainTab = mainTabAfterClose(s.mainTab, closedIds) as MainTab;
  if (mainTab !== s.mainTab) patch.mainTab = mainTab;

  let moved = false;
  const extraPanes = s.extraPanes.map((p) => {
    const tab = mainTabAfterClose(p.tab, closedIds) as PaneTab;
    if (tab === p.tab) return p;
    moved = true;
    return { ...p, tab };
  });
  if (moved) {
    patch.extraPanes = extraPanes;
    persistSplitState({ extraPanes, focusedPaneIndex: s.focusedPaneIndex });
  }
  return patch;
}

/**
 * FR-21: the dynamic tab ids the panes are DISPLAYING right now — pane 0's
 * `mainTab` plus every extra pane's. Handed to `openTabIn` so the cap never
 * evicts a tab someone is currently reading.
 */
function displayedTabIds(s: AppState): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const tab of [s.mainTab as string, ...s.extraPanes.map((p) => p.tab as string)]) {
    const id = agentIdFromTab(tab) ?? workflowIdFromTab(tab);
    if (id !== null) ids.add(id);
  }
  return ids;
}

export const createAgentTabSlice: StateCreator<AppState, [], [], AgentTabSlice> = (set) => ({
  mainTab: INITIAL_ACTIVE_PROJECT === null ? 'overview' : 'session',
  setMainTab: (mainTab) => set({ mainTab }),

  agentTabs: new Map<SessionId, AgentTabRef[]>(),

  // FR-4: the tab lands in whichever pane holds the card's session — `mainTab`
  // for pane 0, that pane's own slot otherwise. FR-5: `focusedPaneIndex` is
  // deliberately NOT touched; the dissolved panels are scoped to the FOCUSED
  // pane's session, so a clicked card always belongs to the pane that already
  // has focus, and moving focus between panes would be a surprise. Focus moves
  // to the main pane here rather than in each caller, so a no-op cannot pull
  // focus off the panel you clicked in.
  openAgentTab: (sessionId, ref) =>
    set((s) => {
      // FR-13: the grid regime gives a pane no tab strip (split-by-4 FR-9), so
      // there is nowhere to hang the chip and no way back off the tab. Guarded
      // here rather than at each card, so every entry point — AgentsPanel,
      // WorkflowsPanel, the palette — is covered by one rule.
      if (layoutRegime(paneCount(s)) === 'grid') return {};
      const i = paneIndexOf(s, sessionId);
      if (i === null) return {}; // §7 case 1: a session on no pane opens nothing
      const agentTabs = openTabIn(s.agentTabs, sessionId, ref, displayedTabIds(s));
      const tab = tabIdFor(ref) as PaneTab;

      if (i === 0) return { agentTabs, mainTab: tab as MainTab, focusedPane: 'main' };

      const extraPanes = s.extraPanes.slice();
      extraPanes[i - 1] = { ...extraPanes[i - 1], tab };
      persistSplitState({ extraPanes, focusedPaneIndex: s.focusedPaneIndex });
      const patch: Partial<AppState> = { agentTabs, extraPanes, focusedPane: 'main' };
      // `mainTab` doubles as "which dissolved panel overlays the cell" (design
      // 7a). Opening a tab in ANOTHER pane has to dismiss that overlay, or the
      // pane just targeted stays hidden behind it. Clamping is exactly the right
      // rule: it drops `overview` + the four panel tabs and leaves a real pane-0
      // tab alone.
      const mainTab = clampToPaneTab(s.mainTab) as MainTab;
      if (mainTab !== s.mainTab) patch.mainTab = mainTab;
      return patch;
    }),

  // FR-21: the passive sibling of `openAgentTab` — it records the chip and
  // nothing else. No activation, no focus move, and deliberately NO grid guard
  // or pane lookup: a dynamic tab belongs to a SESSION (FR-1), so an agent
  // spawned in a session sitting on no pane still gets its chip, ready in the
  // strip the moment that session comes back onto one.
  trackAgentTab: (sessionId, ref) =>
    set((s) => {
      const agentTabs = openTabIn(s.agentTabs, sessionId, ref, displayedTabIds(s));
      return agentTabs === s.agentTabs ? {} : { agentTabs };
    }),

  syncAgentTab: (ref) =>
    set((s) => {
      const agentTabs = syncTabIn(s.agentTabs, ref);
      return agentTabs === s.agentTabs ? {} : { agentTabs };
    }),

  closeAgentTab: (id) =>
    set((s) => {
      const agentTabs = closeTabIn(s.agentTabs, id);
      const patch = foldPanesBack(s, [id]);
      if (agentTabs !== s.agentTabs) patch.agentTabs = agentTabs;
      return patch;
    }),

  clearAgentTabs: () =>
    set((s) => {
      const patch = foldPanesBack(s, null);
      if (s.agentTabs.size > 0) patch.agentTabs = new Map<SessionId, AgentTabRef[]>();
      return patch;
    }),
});
