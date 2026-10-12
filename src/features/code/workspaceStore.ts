// code-editor-workspace FR-1/FR-3/FR-4: the Code tab's workspace chrome — which view
// the sidebar shows (or none), the problems panel, the problems fed from Monaco's
// markers, and the TypeScript language-service status. App-run only, like codeStore.

import { create } from 'zustand';
import type { Problem } from './problems';

/** code-editor-vsx FR-6 adds 'extensions'. */
export type SidebarView = 'explorer' | 'search' | 'changes' | 'extensions';

export interface WorkspaceState {
  /** null = the sidebar is collapsed. */
  sidebar: SidebarView | null;
  /** Bumped by ⌘⇧F so the search input takes focus even when already shown. */
  searchFocusTick: number;
  problemsOpen: boolean;
  problemsMaximized: boolean;
  problemFilter: string;
  /** Markers of the Code tab's models, per root key. */
  problemsByRootKey: Record<string, Problem[]>;
  /** Monaco's bundled TypeScript, known once Monaco loaded. */
  tsVersion: string | null;
  /** The TS worker answered once. */
  tsReady: boolean;
}

export interface WorkspaceActions {
  /** The activity bar: switch to `view`, or collapse when it is the one shown. */
  pickView: (view: SidebarView) => void;
  /** ⌘⇧F: show the search view and focus its input. */
  showSearch: () => void;
  toggleProblems: () => void;
  toggleMaximized: () => void;
  setProblemFilter: (filter: string) => void;
  setProblems: (rootKey: string, problems: Problem[]) => void;
  setTsVersion: (version: string) => void;
  markTsReady: () => void;
}

export function initialWorkspaceState(): WorkspaceState {
  return {
    sidebar: 'explorer',
    searchFocusTick: 0,
    problemsOpen: false,
    problemsMaximized: false,
    problemFilter: '',
    problemsByRootKey: {},
    tsVersion: null,
    tsReady: false,
  };
}

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>((set) => ({
  ...initialWorkspaceState(),
  pickView: (view) => set((s) => ({ sidebar: s.sidebar === view ? null : view })),
  showSearch: () => set((s) => ({ sidebar: 'search', searchFocusTick: s.searchFocusTick + 1 })),
  toggleProblems: () => set((s) => ({ problemsOpen: !s.problemsOpen, problemsMaximized: false })),
  toggleMaximized: () => set((s) => ({ problemsMaximized: !s.problemsMaximized })),
  setProblemFilter: (problemFilter) => set({ problemFilter }),
  setProblems: (rk, problems) => set((s) => ({ problemsByRootKey: { ...s.problemsByRootKey, [rk]: problems } })),
  setTsVersion: (tsVersion) => set({ tsVersion }),
  markTsReady: () => set((s) => (s.tsReady ? s : { tsReady: true })),
}));
