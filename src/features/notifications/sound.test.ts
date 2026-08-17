// audio-cues sound.ts — unit tests for the pure coalescer (FR-6), the DND
// cache (FR-20), and the play-path wiring (FR-5/FR-7/FR-9/FR-10). No test
// constructs a real AudioContext (FR-9): every case that exercises
// `initAudioCues` injects a fake `AudioBackend` and asserts on it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '../../../contract/common';
import { COALESCE_WINDOW_MS, DND_CACHE_TTL_MS, TONES, type DndState } from '../../../contract/audio-cues';
import type { NotifyTrigger } from '../../../contract/notifications';

const { registerTriggerSinkMock, appDndStateMock } = vi.hoisted(() => ({
  registerTriggerSinkMock: vi.fn(),
  appDndStateMock: vi.fn(),
}));

vi.mock('./trigger', () => ({ registerTriggerSink: registerTriggerSinkMock }));
vi.mock('../../lib/api', () => ({ appDndState: appDndStateMock }));

function mockStorage(seed: Record<string, string> = {}): { store: Record<string, string> } {
  const state = { store: { ...seed } };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in state.store ? state.store[k] : null),
    setItem: (k: string, v: string) => {
      state.store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete state.store[k];
    },
    clear: () => {
      state.store = {};
    },
  });
  return state;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('coalesce (FR-6)', () => {
  beforeEach(() => {
    vi.resetModules();
    mockStorage();
    registerTriggerSinkMock.mockReset();
    appDndStateMock.mockReset().mockResolvedValue({ ok: true, data: { dnd: false, supported: true } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('plays the first tone — seeded -Infinity always plays', async () => {
    const { coalesce } = await import('./sound');
    const state = { lastPlayedAt: -Infinity };
    expect(coalesce(1000, state)).toBe('play');
    expect(state.lastPlayedAt).toBe(1000);
  });

  it('drops a tone inside the window, class-blind, without advancing the clock', async () => {
    const { coalesce } = await import('./sound');
    const state = { lastPlayedAt: 1000 };
    expect(coalesce(1000 + COALESCE_WINDOW_MS - 1, state)).toBe('drop');
    expect(state.lastPlayedAt).toBe(1000); // never advances on drop
  });

  it('plays again exactly at the window boundary', async () => {
    const { coalesce } = await import('./sound');
    const state = { lastPlayedAt: 1000 };
    expect(coalesce(1000 + COALESCE_WINDOW_MS, state)).toBe('play');
  });

  it('four triggers within 900ms produce exactly one play (fleet-settle scenario, §3.3)', async () => {
    const { coalesce } = await import('./sound');
    const state = { lastPlayedAt: -Infinity };
    const results = [0, 200, 500, 900].map((t) => coalesce(t, state));
    expect(results).toEqual(['play', 'drop', 'drop', 'drop']);
  });

  it('a turnDone then an attention 200ms later: the second (attention) is dropped (§7)', async () => {
    const { coalesce } = await import('./sound');
    const state = { lastPlayedAt: -Infinity };
    expect(coalesce(0, state)).toBe('play'); // turnDone
    expect(coalesce(200, state)).toBe('drop'); // attention, class-blind
  });
});

describe('dndSuppressed (FR-20)', () => {
  beforeEach(() => {
    vi.resetModules();
    mockStorage();
    registerTriggerSinkMock.mockReset();
    appDndStateMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes on the first call and caches the result', async () => {
    const { dndSuppressed } = await import('./sound');
    const probe = vi.fn(async (): Promise<Result<DndState>> => ({ ok: true, data: { dnd: true, supported: true } }));
    const cache = { value: false, at: -Infinity };
    expect(await dndSuppressed(1000, cache, probe)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('reuses the cached value inside DND_CACHE_TTL_MS without re-probing', async () => {
    const { dndSuppressed } = await import('./sound');
    const probe = vi.fn(async (): Promise<Result<DndState>> => ({ ok: true, data: { dnd: true, supported: true } }));
    const cache = { value: false, at: -Infinity };
    await dndSuppressed(1000, cache, probe);
    expect(await dndSuppressed(1000 + DND_CACHE_TTL_MS - 1, cache, probe)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the TTL has elapsed', async () => {
    const { dndSuppressed } = await import('./sound');
    let calls = 0;
    const probe = async (): Promise<Result<DndState>> => {
      calls += 1;
      return calls === 1
        ? { ok: true, data: { dnd: true, supported: true } }
        : { ok: true, data: { dnd: false, supported: true } };
    };
    const cache = { value: false, at: -Infinity };
    await dndSuppressed(1000, cache, probe);
    expect(await dndSuppressed(1000 + DND_CACHE_TTL_MS, cache, probe)).toBe(false);
    expect(calls).toBe(2);
  });

  it('an unsupported platform (supported:false) is never suppressed — permissive degrade (FR-15)', async () => {
    const { dndSuppressed } = await import('./sound');
    const probe = vi.fn(async (): Promise<Result<DndState>> => ({ ok: true, data: { dnd: false, supported: false } }));
    const cache = { value: true, at: -Infinity };
    expect(await dndSuppressed(1000, cache, probe)).toBe(false);
  });

  it('a transport error (rejected probe) caches false — not suppressed', async () => {
    const { dndSuppressed } = await import('./sound');
    const probe = vi.fn(async (): Promise<Result<DndState>> => {
      throw new Error('transport down');
    });
    const cache = { value: true, at: -Infinity };
    expect(await dndSuppressed(1000, cache, probe)).toBe(false);
  });

  it('an err Result also resolves to not-suppressed', async () => {
    const { dndSuppressed } = await import('./sound');
    const probe = vi.fn(
      async (): Promise<Result<DndState>> => ({ ok: false, error: { code: 'INTERNAL', message: 'boom' } }),
    );
    const cache = { value: true, at: -Infinity };
    expect(await dndSuppressed(1000, cache, probe)).toBe(false);
  });
});

describe('initAudioCues (FR-5/FR-7/FR-9/FR-10)', () => {
  let sink: ((t: NotifyTrigger) => void) | undefined;

  const approval: NotifyTrigger = { class: 'attention', kind: 'approval', sessionId: 's1', toolName: 'Bash' };
  const settle: NotifyTrigger = { class: 'turnDone', kind: 'settle', sessionId: 's1', status: 'idle' };

  beforeEach(() => {
    vi.resetModules();
    mockStorage();
    sink = undefined;
    registerTriggerSinkMock.mockReset().mockImplementation((s: (t: NotifyTrigger) => void) => {
      sink = s;
    });
    appDndStateMock.mockReset().mockResolvedValue({ ok: true, data: { dnd: false, supported: true } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers exactly one trigger sink and is idempotent on a second call', async () => {
    const { initAudioCues } = await import('./sound');
    initAudioCues({ play: vi.fn() });
    initAudioCues({ play: vi.fn() });
    expect(registerTriggerSinkMock).toHaveBeenCalledTimes(1);
  });

  it('plays the exact TONES.attention ToneSpec for an attention trigger', async () => {
    const { initAudioCues } = await import('./sound');
    const backend = { play: vi.fn() };
    initAudioCues(backend);
    sink?.(approval);
    await tick();
    expect(backend.play).toHaveBeenCalledWith(TONES.attention);
  });

  it('plays the exact TONES.turnDone ToneSpec for a settle trigger', async () => {
    const { initAudioCues } = await import('./sound');
    const backend = { play: vi.fn() };
    initAudioCues(backend);
    sink?.(settle);
    await tick();
    expect(backend.play).toHaveBeenCalledWith(TONES.turnDone);
  });

  it('plays even for the active, visible, focused session — no focus gate (FR-7)', async () => {
    // sound.ts has no notion of visibility/focus at all — this is the point.
    const { initAudioCues } = await import('./sound');
    const backend = { play: vi.fn() };
    initAudioCues(backend);
    sink?.(settle);
    await tick();
    expect(backend.play).toHaveBeenCalledTimes(1);
  });

  it('the master toggle off silences every trigger and never probes DND', async () => {
    const notifStore = await import('../../lib/notificationsStore');
    notifStore.useNotificationsStore.getState().setSoundEnabled(false);
    const { initAudioCues } = await import('./sound');
    const backend = { play: vi.fn() };
    initAudioCues(backend);
    sink?.(approval);
    await tick();
    expect(backend.play).not.toHaveBeenCalled();
    expect(appDndStateMock).not.toHaveBeenCalled(); // (a) short-circuits before (b)/(c)
  });

  it('a second trigger inside the coalesce window is dropped, not queued', async () => {
    const { initAudioCues } = await import('./sound');
    const backend = { play: vi.fn() };
    initAudioCues(backend);
    sink?.(settle);
    sink?.(approval);
    await tick();
    expect(backend.play).toHaveBeenCalledTimes(1);
  });

  it('DND reported on suppresses the tone entirely', async () => {
    appDndStateMock.mockResolvedValue({ ok: true, data: { dnd: true, supported: true } });
    const { initAudioCues } = await import('./sound');
    const backend = { play: vi.fn() };
    initAudioCues(backend);
    sink?.(approval);
    await tick();
    expect(backend.play).not.toHaveBeenCalled();
  });

  it('the coalescer clock advances before the awaited DND read, so a suppressed burst issues one probe (FR-7)', async () => {
    let resolveProbe: ((r: { ok: true; data: DndState }) => void) | undefined;
    appDndStateMock.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const { initAudioCues } = await import('./sound');
    const backend = { play: vi.fn() };
    initAudioCues(backend);
    sink?.(settle);
    sink?.(approval);
    await tick();
    expect(appDndStateMock).toHaveBeenCalledTimes(1);
    resolveProbe?.({ ok: true, data: { dnd: true, supported: true } });
    await tick();
    expect(appDndStateMock).toHaveBeenCalledTimes(1);
    expect(backend.play).not.toHaveBeenCalled();
  });

  it('DND supported:false still plays (permissive degrade)', async () => {
    appDndStateMock.mockResolvedValue({ ok: true, data: { dnd: false, supported: false } });
    const { initAudioCues } = await import('./sound');
    const backend = { play: vi.fn() };
    initAudioCues(backend);
    sink?.(approval);
    await tick();
    expect(backend.play).toHaveBeenCalledTimes(1);
  });
});
