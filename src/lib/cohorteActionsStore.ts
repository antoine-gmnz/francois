// cohorte-actions §6 / FR-50 — in-memory only: which session has the actions
// menu or a sheet open, this window's result cards (max 5/session, newest
// last), and the feature ids intake minted this app session (FR-62's NEW tag).
// A standalone zustand store, like cohorteStore — nothing here persists.

import { create } from 'zustand';
import type { CohorteActionId, CohorteIntakeResult } from '../../contract/cohorte-actions';
import type { SessionId } from '../../contract/common';

export const COHORTE_RESULT_CARD_CAP = 5;

export interface CohorteResultEntry {
  id: string;
  verb: 'intake';
  at: number;
  result: CohorteIntakeResult;
}

export interface CohorteSheetState {
  action: CohorteActionId;
  sessionId: SessionId;
  /** pre-selected feature (e.g. a Pipeline card's Brainstorm/Write spec/Start run). */
  featureId?: string;
}

export interface CohorteActionsState {
  menuOpenFor: SessionId | null;
  sheet: CohorteSheetState | null;
  results: Record<SessionId, CohorteResultEntry[]>;
  newFeatureIds: Set<string>;

  openMenu: (sessionId: SessionId) => void;
  closeMenu: () => void;
  openSheet: (sheet: CohorteSheetState) => void;
  closeSheet: () => void;
  addResult: (sessionId: SessionId, entry: CohorteResultEntry) => void;
  dismissResult: (sessionId: SessionId, id: string) => void;
  markNewFeature: (featureId: string) => void;
}

/** FR-50: newest last, capped at 5 — the oldest falls off the front. */
export function pushResult(list: readonly CohorteResultEntry[], entry: CohorteResultEntry): CohorteResultEntry[] {
  const next = [...list, entry];
  return next.length > COHORTE_RESULT_CARD_CAP ? next.slice(next.length - COHORTE_RESULT_CARD_CAP) : next;
}

export const useCohorteActionsStore = create<CohorteActionsState>((set) => ({
  menuOpenFor: null,
  sheet: null,
  results: {},
  newFeatureIds: new Set(),

  openMenu: (sessionId) => set({ menuOpenFor: sessionId }),
  closeMenu: () => set({ menuOpenFor: null }),
  openSheet: (sheet) => set({ sheet, menuOpenFor: null }),
  closeSheet: () => set({ sheet: null }),
  addResult: (sessionId, entry) =>
    set((s) => ({ results: { ...s.results, [sessionId]: pushResult(s.results[sessionId] ?? [], entry) } })),
  dismissResult: (sessionId, id) =>
    set((s) => {
      const list = s.results[sessionId];
      if (!list) return {};
      return { results: { ...s.results, [sessionId]: list.filter((e) => e.id !== id) } };
    }),
  markNewFeature: (featureId) => set((s) => ({ newFeatureIds: new Set(s.newFeatureIds).add(featureId) })),
}));
