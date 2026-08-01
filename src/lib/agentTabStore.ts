// agent-tab store slice: the main pane's active tab + the open agent tabs
// (agent-tab §6, FR-9..FR-14). Split out of the former monolithic store.ts —
// see store.ts for the composition root.
//
// Cross-slice coupling: the initial `mainTab` reads projectsStore's
// `INITIAL_ACTIVE_PROJECT` (FR-3: which tab the app opens on). sessionsStore.ts's
// `setActiveSessionId` also writes `agentTabs`/`mainTab` directly (a session
// switch closes every agent tab) — that logic stays there since it is keyed off
// `activeSessionId`, not off anything owned by this slice.

import type { StateCreator } from 'zustand';
import {
  agentIdFromTab,
  closeTab,
  mainTabAfterClose,
  openTab,
  syncTab,
  tabIdFor,
  workflowIdFromTab,
  type AgentTabRef,
} from '../features/agents/agent-tab';
import { INITIAL_ACTIVE_PROJECT } from './projectsStore';
import type { AppState } from './store';

/**
 * The main pane's active tab. The `agent:${string}` member is agent-tab FR-9's
 * dynamic tab and `workflow:${string}` is workflow-details FR-11's — template-
 * literal members rather than a discriminated object so every existing
 * `mainTab === 'diff'` comparison keeps working untouched.
 */
export type MainTab = 'overview' | 'session' | 'diff' | 'shell' | `agent:${string}` | `workflow:${string}`;

export interface AgentTabSlice {
  // main-pane active tab (minimal app-shell)
  mainTab: MainTab;
  setMainTab: (t: MainTab) => void;

  /**
   * agent-tab §6: the open DYNAMIC tabs, in the order they were opened — agent
   * tabs and, since workflow-details FR-12, workflow tabs too (`ref.kind`), so
   * the 6-tab cap and the eviction order cover both kinds at once. Scoped to the
   * active session (both id kinds are session-scoped) and never persisted.
   */
  agentTabs: AgentTabRef[];
  /** FR-10 / workflow-details FR-11: open (or re-activate) a ref's tab and make it active. */
  openAgentTab: (ref: AgentTabRef) => void;
  /** Refresh an OPEN tab's name/status from an agent.update / workflow.update; never opens one. */
  syncAgentTab: (ref: AgentTabRef) => void;
  /** FR-13: close one tab; falls back to SESSION only if it was the active one. */
  closeAgentTab: (agentId: string) => void;
  /** FR-14 / workflow-details FR-13: close every dynamic tab (session switch). */
  clearAgentTabs: () => void;
}

export const createAgentTabSlice: StateCreator<AppState, [], [], AgentTabSlice> = (set) => ({
  mainTab: INITIAL_ACTIVE_PROJECT === null ? 'overview' : 'session',
  setMainTab: (mainTab) => set({ mainTab }),

  agentTabs: [],
  openAgentTab: (ref) =>
    set((s) => ({ agentTabs: openTab(s.agentTabs, ref), mainTab: tabIdFor(ref) as MainTab })),
  syncAgentTab: (ref) =>
    set((s) => {
      const agentTabs = syncTab(s.agentTabs, ref);
      return agentTabs === s.agentTabs ? {} : { agentTabs };
    }),
  closeAgentTab: (agentId) =>
    set((s) => ({
      agentTabs: closeTab(s.agentTabs, agentId),
      mainTab: mainTabAfterClose(s.mainTab, [agentId]) as MainTab,
    })),
  clearAgentTabs: () =>
    set((s) =>
      s.agentTabs.length === 0 && agentIdFromTab(s.mainTab) === null && workflowIdFromTab(s.mainTab) === null
        ? {}
        : { agentTabs: [], mainTab: mainTabAfterClose(s.mainTab, null) as MainTab },
    ),
});
