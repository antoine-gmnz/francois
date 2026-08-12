// sessions store slice: the app-wide session cache (written by
// sessions-sidebar, read by every pane) plus the sidebar's own
// selection/filter state. Split out of the former monolithic store.ts — see
// store.ts for the composition root.
//
// Cross-slice coupling: `setActiveSessionId` moves agentTabStore's `mainTab`
// off a dynamic tab on a session SWITCH, and `removeSession` drops the removed
// session's tabs (fix-agent-view FR-8/FR-9).

import type { StateCreator } from 'zustand';
import type { SessionId, SessionMeta } from '../../contract/common';
import { dropSessionTabs, mainTabAfterClose } from '../features/agents/agent-tab';
import type { MainTab } from './agentTabStore';
import {
  clampPaneIndex,
  clampToPaneTab,
  paneCount,
  paneIndexOf,
  panesWithout,
  persistedLeftPane,
  persistedRightPane,
  persistSplitState,
  layoutRegime,
  type PaneSlot,
} from './layoutStore';
import type { AppState } from './store';

export interface SessionsSlice {
  // session cache (owned/written by sessions-sidebar, read by all)
  sessions: SessionMeta[];
  setSessions: (s: SessionMeta[]) => void;
  upsertSession: (m: SessionMeta) => void;
  patchStatus: (id: SessionId, status: string) => void;
  /**
   * overview FR-28: record a `session.error` message onto the cached SessionMeta.
   * The engine emits session.error and THEN session.status, and never a fresh
   * session.meta — so without this the message is dropped, the activity feed logs
   * an empty detail, and NEEDS ATTENTION falls back to the generic "session
   * failed" for every live failure.
   */
  patchError: (id: SessionId, message: string) => void;
  patchUsage: (id: SessionId, used: number, limit: number) => void;
  removeSession: (id: SessionId) => void;

  // sessions-sidebar store slice (§5)
  activeSessionId: SessionId | null;
  setActiveSessionId: (id: SessionId | null) => void;
  /**
   * split-by-4 FR-27: the post-REMOVAL fallback — a plain reassignment that
   * never swaps panes. `setActiveSessionId` reads "assign another pane's session
   * to pane 0" as a user pick and SWAPS the two (FR-19), which is wrong here:
   * the session being replaced has just been removed, so there is nothing to
   * swap it with, and the swap branch would both skip the agent-tab reset and
   * transiently put the removed id back into a pane. The nearest remaining
   * session is very often a paned one, so this is reachable, not theoretical —
   * that pane is DROPPED instead, and the grid compacts.
   */
  reassignActiveSessionId: (id: SessionId | null) => void;
  sidebarFilter: string | null;
  setSidebarFilter: (f: string | null) => void;
}

/**
 * The plain session switch, shared by `setActiveSessionId`'s non-swap branch
 * and `reassignActiveSessionId`.
 *
 * fix-agent-view FR-8 (supersedes agent-tab FR-14): a switch no longer CLOSES
 * anything. Tabs are keyed by session, so the outgoing session keeps its own and
 * gets them back when you return; pane 0 just cannot stay on a tab belonging to
 * the session it is leaving, hence the `mainTabAfterClose` fold — which leaves a
 * built-in `diff`/`shell` tab alone, as before. Re-selecting the session already
 * active stays a pure no-op.
 */
function switchTo(s: AppState, activeSessionId: SessionId | null): Partial<AppState> {
  return s.activeSessionId === activeSessionId
    ? { activeSessionId }
    : { activeSessionId, mainTab: mainTabAfterClose(s.mainTab, null) as MainTab };
}

/**
 * split-by-4 FR-27: persist a shortened pane list and re-clamp the focused
 * index. Only the pane LIST changes — pane 0 (`activeSessionId`/`mainTab`) is
 * the caller's business — but dropping to one pane has to unfold the columns
 * the split folded (FR-5).
 */
function compact(s: AppState, extraPanes: PaneSlot[]): Partial<AppState> {
  const focusedPaneIndex = clampPaneIndex(s.focusedPaneIndex, extraPanes.length + 1);
  persistSplitState({ extraPanes, focusedPaneIndex });
  const regime = layoutRegime(extraPanes.length + 1);
  return {
    extraPanes,
    focusedPaneIndex,
    showLeftPane: regime === 'grid' ? false : persistedLeftPane(),
    showRightPane: regime === 'single' ? persistedRightPane() : false,
  };
}

export const createSessionsSlice: StateCreator<AppState, [], [], SessionsSlice> = (set) => ({
  sessions: [],
  setSessions: (sessions) => set({ sessions }),
  upsertSession: (m) =>
    set((s) => {
      const i = s.sessions.findIndex((x) => x.id === m.id);
      if (i === -1) return { sessions: [...s.sessions, m] }; // append on create (FR-2)
      const next = s.sessions.slice();
      next[i] = m; // update in place, position preserved
      return { sessions: next };
    }),
  patchStatus: (id, status) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, status: status as SessionMeta['status'] } : x)),
    })),
  patchError: (id, message) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, errorMessage: message } : x)),
    })),
  patchUsage: (id, used, limit) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, contextUsedTokens: used, contextLimitTokens: limit, lastActivityAt: Date.now() } : x,
      ),
    })),
  removeSession: (id) =>
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      // split-by-4 FR-27: the session is gone from every pane it sat in and the
      // grid compacts. (Pane 0's own removal is handled by fleet-board's
      // reassignAfterRemoval below, which reassigns first — pane 1 is never
      // silently promoted into pane 0 by a removal that has a fallback.)
      const extraPanes = panesWithout(s.extraPanes, id);
      // fix-agent-view FR-9: a removed session takes its dynamic tabs with it —
      // nothing else would ever collect them, since the map is keyed by a
      // session id that no longer resolves.
      const agentTabs = dropSessionTabs(s.agentTabs, id);
      if (extraPanes.length === s.extraPanes.length) return { sessions, agentTabs };
      return { sessions, agentTabs, ...compact(s, extraPanes) };
    }),

  activeSessionId: null,
  // The USER's pick of the left pane's session (agent-tab FR-14's tab reset
  // lives in switchTo above). The post-removal fallback is
  // `reassignActiveSessionId` — it must not take the swap branch below.
  setActiveSessionId: (activeSessionId) =>
    set((s) => {
      // split-by-4 FR-19: assigning another pane's session to pane 0 SWAPS the
      // two rather than showing it twice. No tab reset is owed: each pane's tab
      // travels with the session it belongs to (fix-agent-view §7 case 4), and
      // the map is keyed by session, so nothing has to be re-homed.
      const j = activeSessionId === null ? null : paneIndexOf(s, activeSessionId);
      if (j !== null && j > 0) {
        const extraPanes = s.extraPanes.slice();
        const displaced = extraPanes[j - 1];
        if (s.activeSessionId === null) {
          // Nothing to swap WITH — pane 0 was empty, so the pane just gives up
          // its session rather than showing it in two places.
          return { activeSessionId, mainTab: displaced.tab as MainTab, ...compact(s, panesWithout(s.extraPanes, activeSessionId!)) };
        }
        extraPanes[j - 1] = { sessionId: s.activeSessionId, tab: clampToPaneTab(s.mainTab) };
        persistSplitState({ extraPanes, focusedPaneIndex: s.focusedPaneIndex });
        return { activeSessionId, extraPanes, mainTab: displaced.tab as MainTab };
      }
      return switchTo(s, activeSessionId);
    }),
  reassignActiveSessionId: (activeSessionId) =>
    set((s) => {
      const patch = switchTo(s, activeSessionId);
      // FR-27: the fallback may well land on a session another pane is already
      // showing — drop that pane rather than duplicate it.
      if (activeSessionId === null || paneCount(s) === 1) return patch;
      const extraPanes = panesWithout(s.extraPanes, activeSessionId);
      if (extraPanes.length === s.extraPanes.length) return patch;
      return { ...patch, ...compact(s, extraPanes) };
    }),
  sidebarFilter: null,
  setSidebarFilter: (sidebarFilter) => set({ sidebarFilter }),
});
