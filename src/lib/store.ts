// Shared frontend store. Holds the app-wide session cache + the sessions-sidebar
// store slice (activeSessionId, sidebarFilter) plus the minimal app-shell state
// this build needs (focusedPane, newSessionOpen). The session cache is written
// by sessions-sidebar and read by every pane.

import { create } from 'zustand';
import type { SessionMeta, SessionId } from '../../contract/common';
import type { SessionDerived } from '../../contract/fleet-board';
import type { ActivityEntry } from '../../contract/overview';
import { appendActivity } from '../../contract/overview';
import type { ProjectsState } from '../../contract/projects';
import type { UsageSnapshot } from '../../contract/usage-bar';
import type { RemoteControlStatus } from '../../contract/remote-control';
import { isPluginPaneId, type PluginPaneId, type PluginTabId } from '../../contract/plugin-system';
import { applyRemoteResult, applyRemoteStatus, applySeedStatus, type RemoteMap } from '../features/remote/remote-control';
import { loadActiveProjectId, persistActiveProjectId, reconcileActiveProjectId } from '../features/projects/projects';
import {
  agentIdFromTab,
  agentTabId,
  closeTab,
  mainTabAfterClose,
  openTab,
  syncTab,
  type AgentTabRef,
} from '../features/agents/agent-tab';
import { mintActivityId } from '../features/overview/overview';

// plugin-system FR-45: a plugin panel claims a numbered pane `[6]+`, whose id is
// `plugin:<pluginId>`.
export type Pane = 'sidebar' | 'main' | 'agents' | 'mcp' | 'skills' | PluginPaneId;
/**
 * The main pane's active tab. Both dynamic members are template-literal rather
 * than discriminated objects so every existing `mainTab === 'diff'` comparison
 * keeps working untouched:
 *   - `agent:${string}` — agent-tab FR-9's per-subagent tab.
 *   - `PluginTabId` (`plugintab:<id>`) — plugin-system FR-81's tab contribution.
 * The four static tabs remain Francois's own and keep their order — a dynamic
 * tab APPENDS to the strip, it never replaces or reorders the spine.
 */
export type MainTab = 'overview' | 'session' | 'diff' | 'shell' | `agent:${string}` | PluginTabId;

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
/** Plugin panes append to the SAME right column, below skills (plugin-system FR-46). */
function isRightPane(pane: Pane): boolean {
  return RIGHT_PANES.includes(pane) || isPluginPaneId(pane);
}

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

// `extends ProjectsState` pins the projects slice to the contract's declaration
// (contract/projects.ts §5) — a drift there breaks the build here.
interface AppState extends ProjectsState {
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

  // remote-control: sessionId → Remote Control host state. Sessions with no host
  // are ABSENT rather than stored as `{phase:'off'}` (remote-control FR-15), so
  // "is anything remote-controlled?" is a key count.
  remote: RemoteMap;
  mergeRemote: (status: RemoteControlStatus) => void;
  /** Fold a mount-time `remote_get` seed — fills a hole only, never overwrites a
   * live entry the event stream has since populated (remote-control H2 #1). */
  mergeRemoteSeed: (status: RemoteControlStatus) => void;
  /** Fold a `remote_start`/`remote_stop` command result, guarded against a stale
   * response racing the event stream (remote-control H2 #2). */
  mergeRemoteResult: (status: RemoteControlStatus) => void;

  // Per-session derived figures (diff file count + running agents). Owned by the
  // ONE session/diff event subscription in Sidebar, but held here because the
  // OVERVIEW dashboard reads the same numbers — a second subscription would
  // double every diff_get_summary seed (fleet-board FR-4/FR-6).
  derived: Map<SessionId, SessionDerived>;
  mergeDerived: (id: SessionId, partial: Partial<SessionDerived>) => void;
  dropDerived: (id: SessionId) => void;

  // overview: the cross-project activity feed — an in-memory ring buffer capped
  // at MAX_ACTIVITY, fed by that same subscription. Never persisted: it starts
  // empty at every launch and only ever accumulates forward.
  activity: ActivityEntry[];
  recordActivity: (e: Omit<ActivityEntry, 'id'>) => void;

  // main-pane active tab (minimal app-shell)
  mainTab: MainTab;
  setMainTab: (t: MainTab) => void;

  // agent-tab §6: the open agent tabs, in the order they were opened. Scoped to
  // the active session (agent ids are session-scoped) and never persisted.
  agentTabs: AgentTabRef[];
  /** FR-10: open (or re-activate) an agent's tab and make it the active tab. */
  openAgentTab: (ref: AgentTabRef) => void;
  /** Refresh an OPEN tab's name/status from an agent.update; never opens one. */
  syncAgentTab: (ref: AgentTabRef) => void;
  /** FR-13: close one tab; falls back to SESSION only if it was the active one. */
  closeAgentTab: (agentId: string) => void;
  /** FR-14: close every agent tab (session switch). */
  clearAgentTabs: () => void;

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
  // permission-guardrails FR-26: the rules editor modal, opened from the palette.
  permissionsOpen: boolean;
  setPermissionsOpen: (o: boolean) => void;

  // usage-bar slice (§6): ONE app-scoped snapshot, written by the
  // francois://app/event subscription (and the mount-time cache seed). Nothing
  // derived is stored — threshold color and fill width are computed at render.
  usage: UsageSnapshot;
  setUsage: (s: UsageSnapshot) => void;
}

/** Pre-first-probe cache state, mirroring the core's own initial snapshot (FR-4). */
const EMPTY_USAGE: UsageSnapshot = { status: 'empty', meters: [], fetchedAt: null, error: null };

// Restored once, before the store exists, because the initial main tab depends
// on it: launching into "All projects" lands on the OVERVIEW dashboard rather
// than on whichever session happened to be first.
const INITIAL_ACTIVE_PROJECT = loadActiveProjectId();

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

  remote: {},
  mergeRemote: (status) => set((s) => ({ remote: applyRemoteStatus(s.remote, status) })),
  mergeRemoteSeed: (status) => set((s) => ({ remote: applySeedStatus(s.remote, status) })),
  mergeRemoteResult: (status) => set((s) => ({ remote: applyRemoteResult(s.remote, status) })),

  derived: new Map(),
  // Ignore a late resolution for a session no longer in the cache, so a removed
  // session can never leak an entry back in (fleet-board FR-7).
  mergeDerived: (id, partial) =>
    set((s) => {
      if (!s.sessions.some((x) => x.id === id)) return {};
      const current = s.derived.get(id) ?? { fileCount: null, runningAgentCount: 0 };
      const merged = { ...current, ...partial };
      // Bail on a no-op merge. `agent.update` fires per subagent STEP and Sidebar
      // recomputes runningAgentCount unconditionally, so most merges change
      // nothing — and minting a new Map anyway hands OVERVIEW a fresh `derived`
      // reference, re-running its totals/rollup/attention memos and re-rendering
      // the whole dashboard on every step of every session.
      if (s.derived.has(id) && merged.fileCount === current.fileCount && merged.runningAgentCount === current.runningAgentCount) {
        return {};
      }
      const next = new Map(s.derived);
      next.set(id, merged);
      return { derived: next };
    }),
  dropDerived: (id) =>
    set((s) => {
      if (!s.derived.has(id)) return {};
      const next = new Map(s.derived);
      next.delete(id);
      return { derived: next };
    }),

  activity: [],
  recordActivity: (e) =>
    set((s) => ({ activity: appendActivity(s.activity, { ...e, id: mintActivityId(e.at) }) })),

  mainTab: INITIAL_ACTIVE_PROJECT === null ? 'overview' : 'session',
  setMainTab: (mainTab) => set({ mainTab }),

  agentTabs: [],
  openAgentTab: (ref) =>
    set((s) => ({ agentTabs: openTab(s.agentTabs, ref), mainTab: agentTabId(ref.id) as MainTab })),
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
      s.agentTabs.length === 0 && agentIdFromTab(s.mainTab) === null
        ? {}
        : { agentTabs: [], mainTab: mainTabAfterClose(s.mainTab, null) as MainTab },
    ),

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
      if (isRightPane(focusedPane) && !s.showRightPane) {
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
      const focusedPane = !show && isRightPane(s.focusedPane) ? 'main' : s.focusedPane;
      return { showRightPane: show, focusedPane };
    }),
  newSessionOpen: false,
  setNewSessionOpen: (newSessionOpen) => set({ newSessionOpen }),
  newAgentOpen: false,
  setNewAgentOpen: (newAgentOpen) => set({ newAgentOpen }),
  mcpAttachOpen: false,
  setMcpAttachOpen: (mcpAttachOpen) => set({ mcpAttachOpen }),
  permissionsOpen: false,
  setPermissionsOpen: (permissionsOpen) => set({ permissionsOpen }),

  // projects slice (contract/projects.ts ProjectsState). The registry cache is
  // written by ProjectSwitcher / ProjectsModal after every project_list;
  // activeProjectId (null = All) is restored from localStorage at launch and
  // reconciled against the fetched list on every write (FR-26, §7 case 16).
  projects: [],
  setProjects: (projects) =>
    set((s) => {
      const activeProjectId = reconcileActiveProjectId(s.activeProjectId, projects);
      if (activeProjectId !== s.activeProjectId) persistActiveProjectId(activeProjectId);
      return { projects, activeProjectId };
    }),
  activeProjectId: INITIAL_ACTIVE_PROJECT,
  setActiveProjectId: (activeProjectId) => {
    persistActiveProjectId(activeProjectId);
    set({ activeProjectId });
  },
  projectsOpen: false,
  setProjectsOpen: (projectsOpen) => set({ projectsOpen }),

  usage: EMPTY_USAGE,
  setUsage: (usage) => set({ usage }),
}));
