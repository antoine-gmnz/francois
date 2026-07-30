// projects store slice (contract/projects.ts ProjectsState). Split out of the
// former monolithic store.ts — see store.ts for the composition root.
//
// `INITIAL_ACTIVE_PROJECT` is exported because agentTabStore.ts's initial
// `mainTab` depends on it (agent-tab/overview FR-3: which tab the app opens on).

import type { StateCreator } from 'zustand';
import type { ProjectsState } from '../../contract/projects';
import { loadActiveProjectId, persistActiveProjectId, reconcileActiveProjectId } from '../features/projects/projects';
import type { AppState } from './store';

// Restored once, before the store exists, because the initial main tab
// (agentTabStore.ts) depends on it: launching into "All projects" lands on the
// OVERVIEW dashboard rather than on whichever session happened to be first.
export const INITIAL_ACTIVE_PROJECT = loadActiveProjectId();

export const createProjectsSlice: StateCreator<AppState, [], [], ProjectsState> = (set) => ({
  // The registry cache is written by ProjectSwitcher / ProjectsModal after every
  // project_list; activeProjectId (null = All) is restored from localStorage at
  // launch and reconciled against the fetched list on every write (FR-26, §7
  // case 16).
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
});
