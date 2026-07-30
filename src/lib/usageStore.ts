// usage-bar store slice (§6): ONE app-scoped snapshot, written by the
// francois://app/event subscription (and the mount-time cache seed). Nothing
// derived is stored — threshold color and fill width are computed at render.
// Split out of the former monolithic store.ts — see store.ts for the
// composition root.

import type { StateCreator } from 'zustand';
import type { UsageSnapshot } from '../../contract/usage-bar';
import type { AppState } from './store';

/** Pre-first-probe cache state, mirroring the core's own initial snapshot (FR-4). */
const EMPTY_USAGE: UsageSnapshot = { status: 'empty', meters: [], fetchedAt: null, error: null };

export interface UsageSlice {
  usage: UsageSnapshot;
  setUsage: (s: UsageSnapshot) => void;
}

export const createUsageSlice: StateCreator<AppState, [], [], UsageSlice> = (set) => ({
  usage: EMPTY_USAGE,
  setUsage: (usage) => set({ usage }),
});
