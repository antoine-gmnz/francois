// overview store slice: the per-session derived figures (diff file count +
// running agents) and the cross-project activity ring buffer. Split out of the
// former monolithic store.ts — see store.ts for the composition root.
//
// Cross-slice coupling: `mergeDerived` reads `sessions` from sessionsStore.ts to
// ignore a late resolution for a session no longer cached (fleet-board FR-7).

import type { StateCreator } from 'zustand';
import type { SessionId } from '../../contract/common';
import type { SessionDerived } from '../../contract/fleet-board';
import type { ActivityEntry } from '../../contract/overview';
import { appendActivity } from '../../contract/overview';
import { mintActivityId } from '../features/overview/overview';
import type { AppState } from './store';

export interface OverviewSlice {
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
}

export const createOverviewSlice: StateCreator<AppState, [], [], OverviewSlice> = (set) => ({
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
      if (
        s.derived.has(id) &&
        merged.fileCount === current.fileCount &&
        merged.runningAgentCount === current.runningAgentCount
      ) {
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
});
