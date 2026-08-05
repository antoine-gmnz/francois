// panel-counts store slice: the header count each right-column panel shows,
// published per session so something OTHER than the panel itself can render it.
//
// Why it exists (split-session §Right column): while split, the right column
// folds to a 46px icon rail and every panel is hidden (`display:none`, still
// mounted). The rail has to carry each pane's count as a badge — but those
// counts live inside the panels' own feeds (mcp_list, the skills feed, the
// workflow run map) and re-fetching them here would double every subscription
// the panels already own. So each panel publishes its own number, and the rail
// reads it. Keyed by session because the badges are focused-session scoped.
//
// Cross-slice coupling: `setPanelCount` reads `sessions` to drop a late write
// for a session no longer cached — the same rule overviewStore's `mergeDerived`
// applies (fleet-board FR-7).

import type { StateCreator } from 'zustand';
import type { SessionId } from '../../contract/common';
import type { AppState } from './store';

/** The four right-column panes, each of which owns one count. */
export type CountedPane = 'agents' | 'mcp' | 'skills' | 'workflows';

export type PanelCounts = Record<CountedPane, number>;

export const EMPTY_PANEL_COUNTS: PanelCounts = { agents: 0, mcp: 0, skills: 0, workflows: 0 };

export interface PanelCountsSlice {
  /** sessionId → the four pane counts. Absent ⇒ nothing published yet (no badge). */
  panelCounts: Map<SessionId, PanelCounts>;
  /** Called from each panel's publish effect with its own header count. */
  setPanelCount: (sessionId: SessionId, pane: CountedPane, count: number) => void;
  /** Session removal (fleet-board's dropDerived) — drops its whole record. */
  dropPanelCounts: (sessionId: SessionId) => void;
}

export const createPanelCountsSlice: StateCreator<AppState, [], [], PanelCountsSlice> = (set) => ({
  panelCounts: new Map(),
  setPanelCount: (sessionId, pane, count) =>
    set((s) => {
      // A late resolution for a session that is gone must not leak an entry back
      // in (the panels' own fetches outlive a removal by one round trip).
      if (!s.sessions.some((x) => x.id === sessionId)) return {};
      const current = s.panelCounts.get(sessionId) ?? EMPTY_PANEL_COUNTS;
      // Bail on a no-op: these publish effects re-run on every feed update, and
      // minting a fresh Map anyway would re-render the rail on every event.
      if (s.panelCounts.has(sessionId) && current[pane] === count) return {};
      const next = new Map(s.panelCounts);
      next.set(sessionId, { ...current, [pane]: count });
      return { panelCounts: next };
    }),
  dropPanelCounts: (sessionId) =>
    set((s) => {
      if (!s.panelCounts.has(sessionId)) return {};
      const next = new Map(s.panelCounts);
      next.delete(sessionId);
      return { panelCounts: next };
    }),
});
