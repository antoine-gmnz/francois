// roster store slice — design 12b ("sorted by what wants you"). Everything the
// reworked pane [1] needs that is NOT already on SessionMeta or in the
// fleet-board `derived` map:
//
//   - `sessionActivity` the live one-line "what is it doing" per running session
//   - `runningSince`    when the current turn started, for the row's elapsed
//   - `pendingAsk`      the parked permission ask, so the row can answer it
//                       inline instead of making you open the session first
//
// Deliberately its own slice rather than fields on `SessionDerived`: that map's
// merge does a field-by-field no-op check (overviewStore.ts) and is read by the
// OVERVIEW dashboard, so a per-keystroke activity string written into it would
// re-render the whole dashboard on every tool call.
//
// Written by the ONE session-event subscription in Sidebar (useSessionFleetSync);
// read by the roster's rows.

import type { StateCreator } from 'zustand';
import type { BlockId, PermissionAsk, SessionId } from '../../contract/common';
import type { AppState } from './store';

/** The parked ask, plus the block it belongs to — `permissions_decide` needs both. */
export interface RosterAsk {
  blockId: BlockId;
  ask: PermissionAsk;
}

export interface RosterSlice {
  /** sessionId → the live activity line ('editing UsageBar.tsx'). Absent when
   *  the session is not mid-tool. */
  sessionActivity: Map<SessionId, string>;
  setSessionActivity: (id: SessionId, line: string | null) => void;

  /** sessionId → epoch ms the current turn began. Absent when not busy. */
  runningSince: Map<SessionId, number>;
  markRunningSince: (id: SessionId, at: number | null) => void;

  /** sessionId → the ask parked on it, if any. */
  pendingAsk: Map<SessionId, RosterAsk>;
  setPendingAsk: (id: SessionId, ask: RosterAsk | null) => void;

  /** Drops all three for a session that is gone (or was /clear-ed). */
  clearRosterSignals: (id: SessionId) => void;
}

/** Shared shape of the three per-session maps: set-or-delete, and bail on a
 *  no-op so an unchanged value never mints a new Map (which would re-render
 *  every row of the roster on every repeated tool.start). */
function withEntry<V>(map: Map<SessionId, V>, id: SessionId, value: V | null, same: (a: V, b: V) => boolean): Map<SessionId, V> | null {
  const current = map.get(id);
  if (value === null) {
    if (current === undefined) return null;
    const next = new Map(map);
    next.delete(id);
    return next;
  }
  if (current !== undefined && same(current, value)) return null;
  const next = new Map(map);
  next.set(id, value);
  return next;
}

const sameString = (a: string, b: string) => a === b;
const sameNumber = (a: number, b: number) => a === b;
const sameAsk = (a: RosterAsk, b: RosterAsk) => a.blockId === b.blockId;

export const createRosterSlice: StateCreator<AppState, [], [], RosterSlice> = (set) => ({
  sessionActivity: new Map(),
  setSessionActivity: (id, line) =>
    set((s) => {
      const next = withEntry(s.sessionActivity, id, line, sameString);
      return next === null ? {} : { sessionActivity: next };
    }),

  runningSince: new Map(),
  markRunningSince: (id, at) =>
    set((s) => {
      const next = withEntry(s.runningSince, id, at, sameNumber);
      return next === null ? {} : { runningSince: next };
    }),

  pendingAsk: new Map(),
  setPendingAsk: (id, ask) =>
    set((s) => {
      const next = withEntry(s.pendingAsk, id, ask, sameAsk);
      return next === null ? {} : { pendingAsk: next };
    }),

  clearRosterSignals: (id) =>
    set((s) => {
      const sessionActivity = withEntry(s.sessionActivity, id, null, sameString);
      const runningSince = withEntry(s.runningSince, id, null, sameNumber);
      const pendingAsk = withEntry(s.pendingAsk, id, null, sameAsk);
      return {
        ...(sessionActivity ? { sessionActivity } : {}),
        ...(runningSince ? { runningSince } : {}),
        ...(pendingAsk ? { pendingAsk } : {}),
      };
    }),
});
