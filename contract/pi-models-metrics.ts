// Retired Pi model/metric snapshots remain presentation data; model/metrics IPC is removed.
import type { AccountId } from './common';
export type { RuntimeMetrics, RuntimeModelDescriptor, RuntimeModelRef } from './common';

// ---------- UI preferences (frontend-only; never sent to the core) ----------

/**
 * Favorites/recents are UI preferences keyed by account + exact pair — not credentials
 * and not availability (FR-3). This is the canonical key so every consumer agrees.
 */
export const runtimeModelKey = (accountId: AccountId, providerId: string, modelId: string): string =>
  `${accountId}\u0000${providerId}\u0000${modelId}`;

