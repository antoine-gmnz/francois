// usage-bar store slice (§6): one snapshot PER ACCOUNT (multi-account FR-27),
// written by the francois://app/event subscription (and the mount-time/
// account-change cache seed). Nothing derived is stored — threshold color and
// fill width are computed at render. Split out of the former monolithic
// store.ts — see store.ts for the composition root.

import type { StateCreator } from 'zustand';
import type { AccountId } from '../../contract/common';
import type { UsageSnapshot } from '../../contract/usage-bar';
import type { AppState } from './store';

/** Pre-first-probe cache state, mirroring the core's own initial snapshot (FR-4). */
export const EMPTY_USAGE: UsageSnapshot = { status: 'empty', meters: [], fetchedAt: null, error: null };

export interface UsageSlice {
  usageByAccount: Record<AccountId, UsageSnapshot>;
  setAccountUsage: (accountId: AccountId, snapshot: UsageSnapshot) => void;
}

export const createUsageSlice: StateCreator<AppState, [], [], UsageSlice> = (set) => ({
  usageByAccount: {},
  setAccountUsage: (accountId, snapshot) =>
    set((s) => ({ usageByAccount: { ...s.usageByAccount, [accountId]: snapshot } })),
});
