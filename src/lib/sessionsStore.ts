// sessions store slice: the app-wide session cache (written by
// sessions-sidebar, read by every pane) plus the sidebar's own
// selection/filter state. Split out of the former monolithic store.ts — see
// store.ts for the composition root.
//
// Cross-slice coupling: `setActiveSessionId` also resets agentTabStore's
// `agentTabs`/`mainTab` on a session SWITCH (agent-tab FR-14) — agent ids are
// session-scoped, so tabs from the previous session must not survive.

import type { StateCreator } from 'zustand';
import type { SessionId, SessionMeta } from '../../contract/common';
import { mainTabAfterClose } from '../features/agents/agent-tab';
import type { MainTab } from './agentTabStore';
import { clampToPaneTab, persistedRightPane, persistSplitState } from './layoutStore';
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
   * split-session FR-20: the post-REMOVAL fallback — a plain reassignment that
   * never swaps panes. `setActiveSessionId` reads "assign the right pane's
   * session to the left side" as a user pick and SWAPS the two (FR-8), which is
   * wrong here: the session being replaced has just been removed, so there is
   * nothing to swap it with, and the swap branch would both skip the agent-tab
   * reset and transiently put the removed id into `splitSessionId`. The nearest
   * remaining session is very often the paned one, so this is reachable, not
   * theoretical.
   */
  reassignActiveSessionId: (id: SessionId | null) => void;
  sidebarFilter: string | null;
  setSidebarFilter: (f: string | null) => void;
}

/**
 * The plain session switch, shared by `setActiveSessionId`'s non-swap branch
 * and `reassignActiveSessionId`: agent ids are session-scoped, so a CHANGE
 * closes every agent tab (and hands SESSION back the main pane if one of them
 * was active). Re-selecting the session already active must not — clicking the
 * current row in the sidebar would otherwise wipe the tabs you are reading.
 */
function switchTo(s: AppState, activeSessionId: SessionId | null): Partial<AppState> {
  return s.activeSessionId === activeSessionId
    ? { activeSessionId }
    : { activeSessionId, agentTabs: [], mainTab: mainTabAfterClose(s.mainTab, null) as MainTab };
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
      // split-session FR-20: the right pane's session is gone — split ends and
      // the left pane goes full width. (The LEFT pane's own removal is handled
      // by fleet-board's reassignAfterRemoval, which unsplits after reassigning:
      // the right pane is never silently promoted into the left slot.)
      if (s.splitSessionId === id) {
        persistSplitState({ splitSessionId: null, splitTab: 'session', focusedSide: 'left' });
        return {
          sessions,
          splitSessionId: null,
          splitTab: 'session' as const,
          focusedSide: 'left' as const,
          // FR-3: leaving split unfolds the right column again, however it got left.
          showRightPane: persistedRightPane(),
        };
      }
      return { sessions };
    }),

  activeSessionId: null,
  // The USER's pick of the left pane's session (agent-tab FR-14's tab reset
  // lives in switchTo above). The post-removal fallback is
  // `reassignActiveSessionId` — it must not take the swap branch below.
  setActiveSessionId: (activeSessionId) =>
    set((s) => {
      // split-session FR-8: assigning the RIGHT pane's session to the left side
      // SWAPS the two panes rather than showing it twice. (Agent tabs are always
      // empty while split — FR-13 — so no tab reset is owed here.)
      if (s.splitSessionId !== null && activeSessionId !== null && activeSessionId === s.splitSessionId) {
        const splitTab = clampToPaneTab(s.mainTab);
        persistSplitState({ splitSessionId: s.activeSessionId, splitTab, focusedSide: s.focusedSide });
        return { activeSessionId, splitSessionId: s.activeSessionId, splitTab, mainTab: s.splitTab as MainTab };
      }
      return switchTo(s, activeSessionId);
    }),
  reassignActiveSessionId: (activeSessionId) => set((s) => switchTo(s, activeSessionId)),
  sidebarFilter: null,
  setSidebarFilter: (sidebarFilter) => set({ sidebarFilter }),
});
