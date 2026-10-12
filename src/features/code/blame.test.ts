import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlameCache, blameAgo, formatBlame, INLINE_BLAME_KEY } from './blame';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

describe('blameAgo (FR-7)', () => {
  it.each([
    [NOW - 10_000, 'just now'],
    [NOW - MIN, '1 minute ago'],
    [NOW - 5 * MIN, '5 minutes ago'],
    [NOW - HOUR, '1 hour ago'],
    [NOW - 3 * HOUR, '3 hours ago'],
    [NOW - DAY, '1 day ago'],
    [NOW - 2 * DAY, '2 days ago'],
    [NOW - 14 * DAY, '2 weeks ago'],
    [NOW - 61 * DAY, '2 months ago'],
    [NOW - 400 * DAY, '1 year ago'],
  ])('%s → %s', (time, label) => {
    expect(blameAgo(time, NOW)).toBe(label);
  });

  it('treats a time in the future as just now', () => {
    expect(blameAgo(NOW + DAY, NOW)).toBe('just now');
  });
});

describe('formatBlame (FR-7)', () => {
  it('reads Author, <relative time> · <summary>', () => {
    const line = { author: 'Antoine G', time: NOW - 2 * DAY, summary: 'fix(auth): refresh the token', sha: 'a'.repeat(40) };
    expect(formatBlame(line, NOW)).toBe('Antoine G, 2 days ago · fix(auth): refresh the token');
  });

  it('drops the summary separator when the commit has no subject', () => {
    expect(formatBlame({ author: 'A', time: NOW, summary: '', sha: 'b' }, NOW)).toBe('A, just now');
  });
});

describe('BlameCache (FR-7)', () => {
  const line = { author: 'A', time: NOW, summary: 's', sha: 'c' };

  it('caches per (path, version, line), null included', () => {
    const c = new BlameCache();
    expect(c.has('a.ts', 'v1', 3)).toBe(false);
    c.set('a.ts', 'v1', 3, line);
    c.set('a.ts', 'v1', 4, null);
    expect(c.get('a.ts', 'v1', 3)).toEqual(line);
    expect(c.has('a.ts', 'v1', 4)).toBe(true);
    expect(c.get('a.ts', 'v1', 4)).toBeNull();
    expect(c.has('a.ts', 'v2', 3)).toBe(false);
    expect(c.has('b.ts', 'v1', 3)).toBe(false);
  });

  it('evicts the oldest entry past its capacity', () => {
    const c = new BlameCache(2);
    c.set('a', 'v', 1, line);
    c.set('a', 'v', 2, line);
    c.set('a', 'v', 3, line);
    expect(c.has('a', 'v', 1)).toBe(false);
    expect(c.has('a', 'v', 2)).toBe(true);
    expect(c.has('a', 'v', 3)).toBe(true);
  });
});

describe('useBlameStore (FR-7 toggle)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockStorage(seed: Record<string, string> = {}) {
    const store: Record<string, string> = { ...seed };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = String(v);
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    return store;
  }

  async function fresh() {
    vi.resetModules();
    return (await import('./blame')).useBlameStore;
  }

  it('defaults to on', async () => {
    mockStorage();
    expect((await fresh()).getState().enabled).toBe(true);
  });

  it('restores an off toggle and persists a flip', async () => {
    const store = mockStorage({ [INLINE_BLAME_KEY]: '0' });
    const s = await fresh();
    expect(s.getState().enabled).toBe(false);
    s.getState().toggle();
    expect(s.getState().enabled).toBe(true);
    expect(store[INLINE_BLAME_KEY]).toBe('1');
  });

  it('degrades to on when storage throws, and still toggles in memory', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const s = await fresh();
    expect(s.getState().enabled).toBe(true);
    s.getState().toggle();
    expect(s.getState().enabled).toBe(false);
  });
});

describe('fetchBlame (FR-7)', () => {
  it('calls editor_blame once per (path, version, line) and caches the answer', async () => {
    vi.resetModules();
    const invoke = vi.fn().mockResolvedValue({ ok: true, data: { author: 'A', time: NOW, summary: 's', sha: 'd' } });
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }));
    const { BlameCache: Cache, fetchBlame } = await import('./blame');
    const cache = new Cache();
    const root = { kind: 'project' as const, projectId: 'p1' };
    await expect(fetchBlame(cache, root, 'a.ts', 'v1', 7)).resolves.toMatchObject({ author: 'A' });
    await fetchBlame(cache, root, 'a.ts', 'v1', 7);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('editor_blame', { root, path: 'a.ts', line: 7 });
    vi.doUnmock('@tauri-apps/api/core');
  });

  it('resolves null for a null answer and for an error, caching only the null answer', async () => {
    vi.resetModules();
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL', message: 'x' } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL', message: 'x' } });
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }));
    const { BlameCache: Cache, fetchBlame } = await import('./blame');
    const cache = new Cache();
    const root = { kind: 'project' as const, projectId: 'p1' };
    await expect(fetchBlame(cache, root, 'a.ts', 'v1', 1)).resolves.toBeNull();
    await fetchBlame(cache, root, 'a.ts', 'v1', 1);
    await expect(fetchBlame(cache, root, 'a.ts', 'v1', 2)).resolves.toBeNull();
    await fetchBlame(cache, root, 'a.ts', 'v1', 2);
    expect(invoke).toHaveBeenCalledTimes(3);
    vi.doUnmock('@tauri-apps/api/core');
  });
});
