// projects store slice (contract/projects.ts ProjectsState). Split out of the
// former monolithic store.ts — see store.ts for the composition root.
//
// `INITIAL_ACTIVE_PROJECT` is exported because agentTabStore.ts's initial
// `mainTab` depends on it (agent-tab/overview FR-3: which tab the app opens on).
//
// project-groups §6: `groups` is fed by the same `project_list` call that
// already feeds `projects` — no new fetch site. Both fields live on the
// contract's `ProjectsState` (contract/projects.ts).

import type { StateCreator } from 'zustand';
import type { ProjectsState } from '../../contract/projects';
import {
  firstSessionInProject,
  loadActiveProjectId,
  persistActiveProjectId,
  reconcileActiveProjectId,
} from '../features/projects/projects';
import { clampPaneIndex, layoutRegime, panesWithoutStaleProjects, persistedLeftPane, persistedRightPane, persistSplitState } from './layoutStore';
import type { AppState } from './store';

// Restored once, before the store exists, because the initial main tab
// (agentTabStore.ts) depends on it: launching into "All projects" lands on the
// OVERVIEW dashboard rather than on whichever session happened to be first.
export const INITIAL_ACTIVE_PROJECT = loadActiveProjectId();

export const createProjectsSlice: StateCreator<AppState, [], [], ProjectsState> = (set, get) => ({
  // The registry cache is written by useProjectRegistrySync / ProjectsModal after every
  // project_list; activeProjectId (null = All) is restored from localStorage at
  // launch and reconciled against the fetched list on every write (FR-26, §7
  // case 16).
  projects: [],
  // project-groups FR-11: fed by the same project_list read as `projects`.
  groups: [],
  setGroups: (groups) => set({ groups }),
  setProjects: (projects) =>
    set((s) => {
      const activeProjectId = reconcileActiveProjectId(s.activeProjectId, projects);
      if (activeProjectId !== s.activeProjectId) persistActiveProjectId(activeProjectId);
      const patch: Partial<AppState> = { projects, activeProjectId };
      // unbound-panes FR-17: a shell pane whose project is no longer registered
      // is dropped on hydration, like a stale session pane (split-by-4 FR-24).
      const validProjectIds = new Set(projects.map((p) => p.id));
      const extraPanes = panesWithoutStaleProjects(s.extraPanes, validProjectIds);
      if (extraPanes.length !== s.extraPanes.length) {
        const focusedPaneIndex = clampPaneIndex(s.focusedPaneIndex, extraPanes.length + 1);
        persistSplitState({ extraPanes, focusedPaneIndex });
        patch.extraPanes = extraPanes;
        patch.focusedPaneIndex = focusedPaneIndex;
        const regime = layoutRegime(extraPanes.length + 1);
        patch.showLeftPane = regime === 'grid' ? false : persistedLeftPane();
        patch.showRightPane = regime === 'single' ? persistedRightPane() : false;
      }
      return patch;
    }),
  activeProjectId: INITIAL_ACTIVE_PROJECT,
  setActiveProjectId: (activeProjectId) => {
    persistActiveProjectId(activeProjectId);
    set({ activeProjectId });
  },

  // FR-39: switching scope is a NAVIGATION, not just a filter — it lands the
  // user inside the project it selects. (This supersedes the original FR-28,
  // under which a scope change never touched activeSessionId: that rule kept the
  // main pane showing a session the board no longer listed, which read as the
  // switch having half-failed.) The plain field write stays available as
  // setActiveProjectId for the paths that must NOT navigate: the rollback below,
  // setProjects' reconciliation, and the demo fixture.
  switchProject: (id) => {
    const s = get();
    if (id === s.activeProjectId) return;
    const previous = s.activeProjectId;
    s.setActiveProjectId(id);

    // "All projects" has no first session — the shell zooms back out to the
    // OVERVIEW dashboard instead (App.tsx), and the active session is left alone.
    if (id === null) {
      set({ projectSwitchRollback: null });
      return;
    }

    const first = firstSessionInProject(s.sessions, id);
    if (first) {
      s.setActiveSessionId(first.id);
      // Same rule as picking a card in the sidebar: arriving at a session means
      // "read this one", so the dashboard steps aside. Any other tab is left
      // alone — setActiveSessionId has already dropped the agent tabs.
      if (get().mainTab === 'overview') s.setMainTab('session');
      set({ projectSwitchRollback: null });
      return;
    }

    // An empty project: offer to start its first session. Cancelling that modal
    // is what undoes the switch (rollbackProjectSwitch).
    set((st) => ({
      newSessionOpen: true,
      // Keep the OLDEST pending target: switching on from one empty project to
      // another is one excursion, and cancelling it must return to where the
      // user actually was — not to the empty project they passed through.
      projectSwitchRollback: st.projectSwitchRollback ?? { to: previous },
    }));
  },
  projectSwitchRollback: null,
  rollbackProjectSwitch: () => {
    const pending = get().projectSwitchRollback;
    if (!pending) return;
    set({ projectSwitchRollback: null });
    // The plain write on purpose: the scope we are returning to was already on
    // screen, so re-running switchProject would re-select its first session and
    // could re-open the modal we are backing out of.
    get().setActiveProjectId(pending.to);
  },
  clearProjectSwitchRollback: () => set({ projectSwitchRollback: null }),

  projectsOpen: false,
  setProjectsOpen: (projectsOpen) => set({ projectsOpen }),
});
