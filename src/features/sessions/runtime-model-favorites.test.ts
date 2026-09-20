import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from './runtime-model-favorites';
import { favoriteKeys, isFavoriteModel, recentModels, recentRankByKey, recordRecentModel, toggleFavoriteModel } from './runtime-model-favorites';
import { runtimeModelKey } from '../../../contract/pi-models-metrics';

/** An in-memory KeyValueStore — the frontend suite runs in a 'node' environment
 *  (no real localStorage), and this is also how the module is meant to be used:
 *  dependency-injected, like packaging's home/appData pattern. */
function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

function throwingStore(): KeyValueStore {
  return {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  };
}

const ref = { providerId: 'anthropic', modelId: 'claude-sonnet-5' };

describe('isFavoriteModel / toggleFavoriteModel', () => {
  it('starts un-favorited', () => {
    expect(isFavoriteModel('acct-1', ref, memoryStore())).toBe(false);
  });

  it('toggling on then reading back is consistent, and returns the new state', () => {
    const store = memoryStore();
    expect(toggleFavoriteModel('acct-1', ref, store)).toBe(true);
    expect(isFavoriteModel('acct-1', ref, store)).toBe(true);
    expect(toggleFavoriteModel('acct-1', ref, store)).toBe(false);
    expect(isFavoriteModel('acct-1', ref, store)).toBe(false);
  });

  it('scopes favorites per account — a favorite in one account is not a favorite in another', () => {
    const store = memoryStore();
    toggleFavoriteModel('acct-1', ref, store);
    expect(isFavoriteModel('acct-2', ref, store)).toBe(false);
  });

  it('distinguishes two providers sharing a modelId (FR-1)', () => {
    const store = memoryStore();
    toggleFavoriteModel('acct-1', { providerId: 'anthropic', modelId: 'm' }, store);
    expect(isFavoriteModel('acct-1', { providerId: 'ollama', modelId: 'm' }, store)).toBe(false);
  });

  it('degrades to "not favorited" and never throws when storage is unavailable', () => {
    const store = throwingStore();
    expect(() => isFavoriteModel('acct-1', ref, store)).not.toThrow();
    expect(isFavoriteModel('acct-1', ref, store)).toBe(false);
    expect(() => toggleFavoriteModel('acct-1', ref, store)).not.toThrow();
  });
});

describe('favoriteKeys (A4: one read for a whole render instead of one per row)', () => {
  it('is empty with no favorites', () => {
    expect(favoriteKeys(memoryStore())).toEqual(new Set());
  });

  it('holds every favorited key, matching isFavoriteModel row by row', () => {
    const store = memoryStore();
    toggleFavoriteModel('acct-1', ref, store);
    toggleFavoriteModel('acct-1', { providerId: 'ollama', modelId: 'm' }, store);
    const keys = favoriteKeys(store);
    expect(keys.has(runtimeModelKey('acct-1', ref.providerId, ref.modelId))).toBe(true);
    expect(keys.has(runtimeModelKey('acct-1', 'ollama', 'm'))).toBe(true);
    expect(keys.size).toBe(2);
  });

  it('degrades to an empty set rather than throwing when storage is unavailable', () => {
    expect(() => favoriteKeys(throwingStore())).not.toThrow();
    expect(favoriteKeys(throwingStore())).toEqual(new Set());
  });
});

describe('recordRecentModel / recentModels', () => {
  it('is most-recent-first', () => {
    const store = memoryStore();
    recordRecentModel('acct-1', { providerId: 'a', modelId: '1' }, store);
    recordRecentModel('acct-1', { providerId: 'a', modelId: '2' }, store);
    expect(recentModels('acct-1', store)).toEqual([
      { providerId: 'a', modelId: '2' },
      { providerId: 'a', modelId: '1' },
    ]);
  });

  it('dedupes — re-recording the same pair moves it to the front instead of repeating it', () => {
    const store = memoryStore();
    recordRecentModel('acct-1', { providerId: 'a', modelId: '1' }, store);
    recordRecentModel('acct-1', { providerId: 'a', modelId: '2' }, store);
    recordRecentModel('acct-1', { providerId: 'a', modelId: '1' }, store);
    expect(recentModels('acct-1', store)).toEqual([
      { providerId: 'a', modelId: '1' },
      { providerId: 'a', modelId: '2' },
    ]);
  });

  it('caps at 5', () => {
    const store = memoryStore();
    for (let i = 0; i < 8; i++) recordRecentModel('acct-1', { providerId: 'a', modelId: String(i) }, store);
    expect(recentModels('acct-1', store)).toHaveLength(5);
    expect(recentModels('acct-1', store)[0]).toEqual({ providerId: 'a', modelId: '7' });
  });

  it('caps PER ACCOUNT — filling one account\'s recents never evicts another account\'s (A6)', () => {
    const store = memoryStore();
    for (let i = 0; i < 5; i++) recordRecentModel('acct-1', { providerId: 'a', modelId: String(i) }, store);
    recordRecentModel('acct-2', { providerId: 'b', modelId: 'x' }, store);
    expect(recentModels('acct-1', store)).toHaveLength(5);
    expect(recentModels('acct-1', store)[0]).toEqual({ providerId: 'a', modelId: '4' });
    expect(recentModels('acct-2', store)).toEqual([{ providerId: 'b', modelId: 'x' }]);
  });

  it('scopes recents per account, same as favorites', () => {
    const store = memoryStore();
    recordRecentModel('acct-1', { providerId: 'a', modelId: '1' }, store);
    expect(recentModels('acct-2', store)).toEqual([]);
  });

  it('is resilient to a corrupt stored blob', () => {
    const store = memoryStore();
    store.setItem('francois:model-prefs', 'not json');
    expect(recentModels('acct-1', store)).toEqual([]);
    expect(() => recordRecentModel('acct-1', ref, store)).not.toThrow();
  });
});

describe('recentRankByKey (A6: one read for a whole render, same shape as favoriteKeys)', () => {
  it('ranks most-recent-first, 0-based, keyed like favoriteKeys', () => {
    const store = memoryStore();
    recordRecentModel('acct-1', { providerId: 'a', modelId: '1' }, store);
    recordRecentModel('acct-1', { providerId: 'a', modelId: '2' }, store);
    const ranks = recentRankByKey('acct-1', store);
    expect(ranks.get(runtimeModelKey('acct-1', 'a', '2'))).toBe(0);
    expect(ranks.get(runtimeModelKey('acct-1', 'a', '1'))).toBe(1);
  });

  it('is empty with no recents', () => {
    expect(recentRankByKey('acct-1', memoryStore())).toEqual(new Map());
  });

  it("never carries another account's recents into this account's ranks", () => {
    const store = memoryStore();
    recordRecentModel('acct-2', { providerId: 'b', modelId: 'x' }, store);
    expect(recentRankByKey('acct-1', store).size).toBe(0);
  });
});
