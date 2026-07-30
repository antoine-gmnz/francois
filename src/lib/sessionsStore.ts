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
  sidebarFilter: string | null;
  setSidebarFilter: (f: string | null) => void;
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
  removeSession: (id) => set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) })),

  activeSessionId: null,
  // agent-tab FR-14: agent ids are session-scoped, so a session CHANGE closes
  // every agent tab (and hands SESSION back the main pane if one was active).
  // Re-selecting the session already active must not — clicking the current row
  // in the sidebar would otherwise wipe the tabs you are reading.
  setActiveSessionId: (activeSessionId) =>
    set((s) =>
      s.activeSessionId === activeSessionId
        ? { activeSessionId }
        : { activeSessionId, agentTabs: [], mainTab: mainTabAfterClose(s.mainTab, null) as MainTab },
    ),
  sidebarFilter: null,
  setSidebarFilter: (sidebarFilter) => set({ sidebarFilter }),
});
