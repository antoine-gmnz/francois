// Shared frontend store — composition root. Combines the per-concern zustand
// slices below into ONE store via the standard zustand "slices" pattern:
// `useStore` remains a single store with an unchanged public shape even though
// each concern's state + actions now live in their own file.
//
// Cross-slice coupling (each slice creator receives the full get/set, so this
// still works — noted here since it is the main risk of this split):
//  - sessionsStore's `setActiveSessionId` also resets agentTabStore's
//    `agentTabs`/`mainTab` on a session SWITCH (agent-tab FR-14).
//  - overviewStore's `mergeDerived` reads sessionsStore's `sessions` to ignore
//    a late resolution for a session no longer cached (fleet-board FR-7).
//  - agentTabStore's initial `mainTab` reads projectsStore's
//    `INITIAL_ACTIVE_PROJECT` (FR-3: which tab the app opens on).

import { create } from 'zustand';
import type { ProjectsState } from '../../contract/projects';
import { createAccountsSlice, type AccountsSlice } from './accountsStore';
import { createAgentTabSlice, type AgentTabSlice, type MainTab } from './agentTabStore';
import { createExtensionsSlice, type ExtensionsSlice } from './extensionsStore';
import { createLayoutSlice, type LayoutSlice, type Pane, type RightPane } from './layoutStore';
import { createOverviewSlice, type OverviewSlice } from './overviewStore';
import { createPanelCountsSlice, type PanelCountsSlice } from './panelCountsStore';
import { createProjectsSlice } from './projectsStore';
import { createRemoteSlice, type RemoteSlice } from './remoteStore';
import { createSessionsSlice, type SessionsSlice } from './sessionsStore';
import { createThemeSlice, type Theme, type ThemeSlice } from './theme';
import { createUpdateSlice, type UpdateSlice } from './updateStore';
import { createUsageSlice, type UsageSlice } from './usageStore';

export type { Pane, RightPane, MainTab, Theme };

// `& ProjectsState` pins the projects slice to the contract's declaration
// (contract/projects.ts §5) — a drift there breaks the build here.
export type AppState = SessionsSlice &
  RemoteSlice &
  OverviewSlice &
  PanelCountsSlice &
  AgentTabSlice &
  ExtensionsSlice &
  ThemeSlice &
  LayoutSlice &
  UsageSlice &
  AccountsSlice &
  UpdateSlice &
  ProjectsState;

export const useStore = create<AppState>((set, get, api) => ({
  ...createSessionsSlice(set, get, api),
  ...createRemoteSlice(set, get, api),
  ...createOverviewSlice(set, get, api),
  ...createPanelCountsSlice(set, get, api),
  ...createAgentTabSlice(set, get, api),
  ...createExtensionsSlice(set, get, api),
  ...createThemeSlice(set, get, api),
  ...createLayoutSlice(set, get, api),
  ...createUsageSlice(set, get, api),
  ...createAccountsSlice(set, get, api),
  ...createUpdateSlice(set, get, api),
  ...createProjectsSlice(set, get, api),
}));
