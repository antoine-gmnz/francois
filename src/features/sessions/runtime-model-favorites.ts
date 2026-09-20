// runtime-model-favorites (pi-models-metrics §5, design brief §Flows) —
// favorites/recents are UI PREFERENCES, never sent to the core and never a
// substitute for provider credentials or catalogue availability (FR-3). Keyed
// by `runtimeModelKey(accountId, providerId, modelId)`, the contract's own
// canonical key, so every consumer of this file agrees on identity with the
// core. Storage access is dependency-injected and wrapped in try/catch: the
// frontend suite's environment is 'node' (vite.config.ts), not jsdom, so
// `localStorage` isn't there at all outside a real webview, and a locked-down
// profile / private browsing can throw on a real one too — either way this
// degrades to "no favorites" rather than crashing the picker.

import type { AccountId, RuntimeModelRef } from '../../../contract/common';
import { runtimeModelKey } from '../../../contract/pi-models-metrics';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const globalStorage: KeyValueStore = {
  getItem(key) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // Favorites are a convenience, never load-bearing — a write failure is silent.
    }
  },
};

const STORAGE_KEY = 'francois:model-prefs';
const RECENTS_CAP = 5;

interface RecentEntry {
  accountId: AccountId;
  ref: RuntimeModelRef;
}

interface ModelPrefs {
  favorites: string[]; // runtimeModelKey values — already account-scoped by construction
  recents: RecentEntry[]; // most-recent-first, deduped per (accountId, ref)
}

const EMPTY_PREFS: ModelPrefs = { favorites: [], recents: [] };

function isRuntimeModelRef(x: unknown): x is RuntimeModelRef {
  return typeof x === 'object' && x !== null && typeof (x as RuntimeModelRef).providerId === 'string' && typeof (x as RuntimeModelRef).modelId === 'string';
}

function isRecentEntry(x: unknown): x is RecentEntry {
  return typeof x === 'object' && x !== null && typeof (x as RecentEntry).accountId === 'string' && isRuntimeModelRef((x as RecentEntry).ref);
}

function readPrefs(store: KeyValueStore): ModelPrefs {
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_PREFS;
    const parsed = JSON.parse(raw) as Partial<ModelPrefs>;
    return {
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter((f): f is string => typeof f === 'string') : [],
      recents: Array.isArray(parsed.recents) ? parsed.recents.filter(isRecentEntry) : [],
    };
  } catch {
    return EMPTY_PREFS;
  }
}

function writePrefs(store: KeyValueStore, prefs: ModelPrefs): void {
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignored — see the module doc comment
  }
}

export function isFavoriteModel(accountId: AccountId, ref: RuntimeModelRef, store: KeyValueStore = globalStorage): boolean {
  return readPrefs(store).favorites.includes(runtimeModelKey(accountId, ref.providerId, ref.modelId));
}

/** Returns the NEW favorited state (so a caller can update its own UI without a re-read). */
export function toggleFavoriteModel(accountId: AccountId, ref: RuntimeModelRef, store: KeyValueStore = globalStorage): boolean {
  const key = runtimeModelKey(accountId, ref.providerId, ref.modelId);
  const prefs = readPrefs(store);
  const wasFavorite = prefs.favorites.includes(key);
  const favorites = wasFavorite ? prefs.favorites.filter((f) => f !== key) : [...prefs.favorites, key];
  writePrefs(store, { ...prefs, favorites });
  return !wasFavorite;
}

/**
 * A4 (review addendum): every favorited key in one read, so a caller (a
 * rendered list of options) reads storage once per render instead of once per
 * row via `isFavoriteModel`.
 */
export function favoriteKeys(store: KeyValueStore = globalStorage): Set<string> {
  return new Set(readPrefs(store).favorites);
}

/**
 * Most-recent-first, deduped per (accountId, ref), capped at 5 PER ACCOUNT —
 * a picker footnote, not a registry. A6 (review addendum): the cap applies to
 * this account's own entries only; another account's recents are carried
 * through untouched, never evicted by this account's own churn.
 */
export function recordRecentModel(accountId: AccountId, ref: RuntimeModelRef, store: KeyValueStore = globalStorage): void {
  const prefs = readPrefs(store);
  const key = runtimeModelKey(accountId, ref.providerId, ref.modelId);
  const otherAccounts = prefs.recents.filter((r) => r.accountId !== accountId);
  const ownWithoutDup = prefs.recents.filter(
    (r) => r.accountId === accountId && runtimeModelKey(r.accountId, r.ref.providerId, r.ref.modelId) !== key,
  );
  const own = [{ accountId, ref }, ...ownWithoutDup].slice(0, RECENTS_CAP);
  writePrefs(store, { ...prefs, recents: [...own, ...otherAccounts] });
}

/** This account's recents, most-recent-first — never another account's (FR-3's "UI preference, not a credential"). */
export function recentModels(accountId: AccountId, store: KeyValueStore = globalStorage): RuntimeModelRef[] {
  return readPrefs(store)
    .recents.filter((r) => r.accountId === accountId)
    .map((r) => r.ref);
}

/**
 * A6 (review addendum): this account's recents as a rank lookup (0 = most
 * recent), keyed the same way `favoriteKeys` keys favorites — one read for a
 * whole render instead of one per row. Built on `recentModels`, so the
 * per-account scoping is the same code path, not a second copy of it.
 */
export function recentRankByKey(accountId: AccountId, store: KeyValueStore = globalStorage): Map<string, number> {
  const ranks = new Map<string, number>();
  recentModels(accountId, store).forEach((ref, index) => {
    ranks.set(runtimeModelKey(accountId, ref.providerId, ref.modelId), index);
  });
  return ranks;
}
