// Shared frontend store. Holds the app-wide session cache + the sessions-sidebar
// store slice (activeSessionId, sidebarFilter) plus the minimal app-shell state
// this build needs (focusedPane, newSessionOpen). The session cache is written
// by sessions-sidebar and read by every pane.

import { create } from 'zustand';
import type { SessionMeta, SessionId } from '../contract/common';
import type { UsageSnapshot } from '../contract/usage-bar';

export type Pane = 'sidebar' | 'main' | 'agents' | 'mcp' | 'skills';
export type MainTab = 'session' | 'diff' | 'shell';

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
const RIGHT_PANES: readonly Pane[] = ['agents', 'mcp', 'skills'];

export type Theme = 'light' | 'dark';
const THEME_KEY = 'francois.theme';

// Theme persistence — mirrors loadPane/persistPane. Degrades to 'dark' if storage
// throws (restricted env / node test env). The DOM write is guarded so the node
// test env (no `document`) does not crash.
function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}
function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
  }
}

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

  // light/dark theme (§theme). Initialized from localStorage; setter/toggle both
  // persist and apply data-theme to <html>.
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;

  // sessions-sidebar store slice (§5)
  activeSessionId: SessionId | null;
  setActiveSessionId: (id: SessionId | null) => void;
  sidebarFilter: string | null;
  setSidebarFilter: (f: string | null) => void;

  // minimal app-shell state
  focusedPane: Pane;
  setFocusedPane: (p: Pane) => void;
  // layout: left (sessions) / right (agents+mcp+skills) column visibility.
  // Persisted to localStorage; hiding the column that owns focus hands focus to
  // 'main', and focusing a pane always reveals its column (setFocusedPane).
  showLeftPane: boolean;
  showRightPane: boolean;
  toggleLeftPane: () => void;
  toggleRightPane: () => void;
  newSessionOpen: boolean;
  setNewSessionOpen: (o: boolean) => void;
  newAgentOpen: boolean;
  setNewAgentOpen: (o: boolean) => void;
  // mcp-panel attach overlay — lifted to the store so the command palette can open it (FR-23)
  mcpAttachOpen: boolean;
  setMcpAttachOpen: (o: boolean) => void;

  // usage-bar slice (§6): ONE app-scoped snapshot, written by the
  // francois://app/event subscription (and the mount-time cache seed). Nothing
  // derived is stored — threshold color and fill width are computed at render.
  usage: UsageSnapshot;
  setUsage: (s: UsageSnapshot) => void;
}

/** Pre-first-probe cache state, mirroring the core's own initial snapshot (FR-4). */
const EMPTY_USAGE: UsageSnapshot = { status: 'empty', meters: [], fetchedAt: null, error: null };

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

  theme: loadTheme(),
  setTheme: (theme) => {
    persistTheme(theme);
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () =>
    set((s) => {
      const theme: Theme = s.theme === 'dark' ? 'light' : 'dark';
      persistTheme(theme);
      applyTheme(theme);
      return { theme };
    }),

  activeSessionId: null,
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  sidebarFilter: null,
  setSidebarFilter: (sidebarFilter) => set({ sidebarFilter }),

  focusedPane: 'sidebar',
  // Invariant: the focused pane's column is always visible — focusing a hidden
  // pane (key 1/3/4/5, palette commands, `a`) reveals its column first.
  setFocusedPane: (focusedPane) =>
    set((s) => {
      const patch: Partial<AppState> = { focusedPane };
      if (focusedPane === 'sidebar' && !s.showLeftPane) {
        patch.showLeftPane = true;
        persistPane(LEFT_KEY, true);
      }
      if (RIGHT_PANES.includes(focusedPane) && !s.showRightPane) {
        patch.showRightPane = true;
        persistPane(RIGHT_KEY, true);
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
      const focusedPane = !show && RIGHT_PANES.includes(s.focusedPane) ? 'main' : s.focusedPane;
      return { showRightPane: show, focusedPane };
    }),
  newSessionOpen: false,
  setNewSessionOpen: (newSessionOpen) => set({ newSessionOpen }),
  newAgentOpen: false,
  setNewAgentOpen: (newAgentOpen) => set({ newAgentOpen }),
  mcpAttachOpen: false,
  setMcpAttachOpen: (mcpAttachOpen) => set({ mcpAttachOpen }),

  usage: EMPTY_USAGE,
  setUsage: (usage) => set({ usage }),
}));
