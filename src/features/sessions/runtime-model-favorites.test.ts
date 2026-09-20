import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from './runtime-model-favorites';
import { isFavoriteModel, recentModels, recordRecentModel, toggleFavoriteModel } from './runtime-model-favorites';

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
