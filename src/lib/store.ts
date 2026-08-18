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
import { subscribeWithSelector } from 'zustand/middleware';
import { shallow } from 'zustand/shallow';
import type { ProjectsState } from '../../contract/projects';
import { createAccountsSlice, type AccountsSlice } from './accountsStore';
import { createAgentTabSlice, type AgentTabSlice, type MainTab } from './agentTabStore';
import { createExtensionsSlice, type ExtensionsSlice } from './extensionsStore';
import { clampPaneIndex, createLayoutSlice, paneCount, paneSessionIdAt, type LayoutSlice, type Pane, type RightPane } from './layoutStore';
import { createOverviewSlice, type OverviewSlice } from './overviewStore';
import { createPanelCountsSlice, type PanelCountsSlice } from './panelCountsStore';
import { createProfilesSlice, type ProfilesSlice } from './profilesStore';
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
  ProfilesSlice &
  ProjectsState;

export const useStore = create<AppState>()(
  subscribeWithSelector((set, get, api) => ({
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
  ...createProfilesSlice(set, get, api),
  ...createProjectsSlice(set, get, api),
  })),
);

// unbound-panes FR-12: `lastFocusedSessionId` tracks the most recently
// focused SESSION pane's session, one subscription for every path that can
// move focus or reassign a pane's content (setFocusedPaneIndex, openInNewPane,
// assignToFocusedPane, setActiveSessionId, closePane's promotion, …) rather
// than scattering the same write across each of them. Its INITIAL value is
// seeded synchronously in layoutStore's `createLayoutSlice` (via
// `initialLastFocusedSessionId`) from the hydrated split state, since a
// persisted `focusedPaneIndex` can point at a shell pane on quit/reopen — this
// subscription only keeps it current from there on.
// Narrowed to the slice this listener actually reads (subscribeWithSelector),
// so it only recomputes when focus/pane-shape/the active session move —
// not on every unrelated store write (session list refresh, agent tabs,
// usage meters, …). The selector returns a fresh array on every call, so the
// `shallow` equalityFn (rather than the default reference check) is what
// actually gates the listener on the three primitives changing.
useStore.subscribe(
  (state) => [state.focusedPaneIndex, state.extraPanes, state.activeSessionId] as const,
  () => {
    const state = useStore.getState();
    const i = clampPaneIndex(state.focusedPaneIndex, paneCount(state));
    const id = paneSessionIdAt(state, i);
    if (id !== null && id !== state.lastFocusedSessionId) {
      useStore.setState({ lastFocusedSessionId: id });
    }
  },
  { equalityFn: shallow },
);
