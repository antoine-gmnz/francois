// Shared frontend store. Holds the app-wide session cache + the sessions-sidebar
// store slice (activeSessionId, sidebarFilter) plus the minimal app-shell state
// this build needs (focusedPane, newSessionOpen). The session cache is written
// by sessions-sidebar and read by every pane.

import { create } from 'zustand';
import type { SessionMeta, SessionId } from '../contract/common';

export type Pane = 'sidebar' | 'main' | 'agents' | 'mcp' | 'skills';
export type MainTab = 'session' | 'diff' | 'shell';

interface AppState {
  // session cache (owned/written by sessions-sidebar, read by all)
  sessions: SessionMeta[];
  setSessions: (s: SessionMeta[]) => void;
  upsertSession: (m: SessionMeta) => void;
  patchStatus: (id: SessionId, status: string) => void;
  patchUsage: (id: SessionId, used: number, limit: number) => void;
  removeSession: (id: SessionId) => void;

  // main-pane active tab (minimal app-shell)
  mainTab: MainTab;
  setMainTab: (t: MainTab) => void;

  // sessions-sidebar store slice (§5)
  activeSessionId: SessionId | null;
  setActiveSessionId: (id: SessionId | null) => void;
  sidebarFilter: string | null;
  setSidebarFilter: (f: string | null) => void;

  // minimal app-shell state
  focusedPane: Pane;
  setFocusedPane: (p: Pane) => void;
  newSessionOpen: boolean;
  setNewSessionOpen: (o: boolean) => void;
  newAgentOpen: boolean;
  setNewAgentOpen: (o: boolean) => void;
  // mcp-panel attach overlay — lifted to the store so the command palette can open it (FR-23)
  mcpAttachOpen: boolean;
  setMcpAttachOpen: (o: boolean) => void;
}

export const useStore = create<AppState>((set) => ({
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
  patchUsage: (id, used, limit) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, contextUsedTokens: used, contextLimitTokens: limit, lastActivityAt: Date.now() } : x,
      ),
    })),
  removeSession: (id) => set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) })),

  mainTab: 'session',
  setMainTab: (mainTab) => set({ mainTab }),

  activeSessionId: null,
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  sidebarFilter: null,
  setSidebarFilter: (sidebarFilter) => set({ sidebarFilter }),

  focusedPane: 'sidebar',
  setFocusedPane: (focusedPane) => set({ focusedPane }),
  newSessionOpen: false,
  setNewSessionOpen: (newSessionOpen) => set({ newSessionOpen }),
  newAgentOpen: false,
  setNewAgentOpen: (newAgentOpen) => set({ newAgentOpen }),
  mcpAttachOpen: false,
  setMcpAttachOpen: (mcpAttachOpen) => set({ mcpAttachOpen }),
}));
