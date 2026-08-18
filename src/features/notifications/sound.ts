// audio-cues sound.ts — the audio sink: short synthesized tones for the two
// notification trigger classes, with no focus gate. specs/audio-cues.md
// §4 (FR-5..FR-13) / §5 / §6.

import type { Result } from '../../../contract/common';
import type { DndState, ToneSpec } from '../../../contract/audio-cues';
import { COALESCE_WINDOW_MS, DND_CACHE_TTL_MS, TONES } from '../../../contract/audio-cues';
import type { NotifyTrigger } from '../../../contract/notifications';
import { appDndState } from '../../lib/api';
import { useNotificationsStore } from '../../lib/notificationsStore';
import { registerTriggerSink } from './trigger';

// ---------- pure coalescer (FR-6, unit-tested with an injected now) ----------

export interface CoalesceState {
  lastPlayedAt: number;
}

/**
 * At most one tone per COALESCE_WINDOW_MS; a tone inside the window is
 * dropped, never queued. Class-blind: `attention` inside the window drops
 * exactly like `turnDone`.
 */
export function coalesce(now: number, state: CoalesceState): 'play' | 'drop' {
  if (now - state.lastPlayedAt < COALESCE_WINDOW_MS) return 'drop';
  state.lastPlayedAt = now;
  return 'play';
}

// ---------- injectable audio backend seam (FR-9) ----------

export interface AudioBackend {
  play(spec: ToneSpec): void;
}

let ctx: AudioContext | null = null;

/** FR-10 — a single AudioContext, created lazily on first play. */
function getContext(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof window === 'undefined') return null; // node test env / no webview yet
  try {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** FR-8 — sine OscillatorNode + GainNode built straight from the ToneSpec. Never a hard stop. */
const webAudioBackend: AudioBackend = {
  play(spec: ToneSpec): void {
    try {
      const c = getContext();
      if (!c) return;
      if (c.state === 'suspended') {
        void c.resume().catch(() => {}); // FR-10: may reject; the tone is swallowed either way
      }
      const start = c.currentTime;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(spec.freq, start);
      if (spec.freqTo !== undefined && spec.freqAtMs !== undefined) {
        osc.frequency.setValueAtTime(spec.freqTo, start + spec.freqAtMs / 1000);
      }
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(spec.peakGain, start + spec.attackMs / 1000);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.durationMs / 1000);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(start);
      osc.stop(start + spec.durationMs / 1000);
    } catch {
      /* FR-10: swallowed silently — never an error path, never a prompt */
    }
  },
};

let gestureListenerInstalled = false;

/** FR-10 — resumes the lazily-created AudioContext on the first user gesture, then unregisters. */
function installGestureListener(): void {
  if (gestureListenerInstalled) return;
  gestureListenerInstalled = true;
  if (typeof window === 'undefined') return; // node test env / no webview yet
  const resume = (): void => {
    const c = getContext();
    if (c && c.state === 'suspended') void c.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', resume, { once: true, capture: true });
  window.addEventListener('keydown', resume, { once: true, capture: true });
}

// ---------- DND probe cache (FR-20, pure apart from the injected clock/api) ----------

export interface DndCache {
  value: boolean;
  at: number;
}

const defaultDndCache: DndCache = { value: false, at: -Infinity };

/**
 * At most one `app_dnd_state` probe per DND_CACHE_TTL_MS; no timer, no
 * polling — it runs only when a tone is about to play. A transport error
 * (rejected probe) caches `false` (not-suppressed), per FR-15/FR-20.
 */
export async function dndSuppressed(
  now: number,
  cache: DndCache = defaultDndCache,
  probe: () => Promise<Result<DndState>> = appDndState,
): Promise<boolean> {
  if (now - cache.at < DND_CACHE_TTL_MS) return cache.value;
  cache.at = now;
  try {
    const res = await probe();
    cache.value = res.ok ? res.data.dnd : false;
  } catch {
    cache.value = false;
  }
  return cache.value;
}

// ---------- runtime wiring (FR-5/FR-7) ----------

const coalesceState: CoalesceState = { lastPlayedAt: -Infinity };

/**
 * FR-7 — play path order, stopping at the first "no": (a) soundEnabled, (b)
 * coalesce, (c) DND. The coalescer clock advances at (b), before the awaited
 * DND read, so a burst later suppressed by DND still collapses to one probe.
 */
async function handleTrigger(trigger: NotifyTrigger, backend: AudioBackend): Promise<void> {
  if (!useNotificationsStore.getState().soundEnabled) return;
  const now = Date.now();
  if (coalesce(now, coalesceState) !== 'play') return;
  if (await dndSuppressed(now)) return;
  try {
    backend.play(TONES[trigger.class]);
  } catch {
    /* FR-10: swallowed silently for any injected backend, not just the default */
  }
}

let initialized = false;

/** Called once from App's mount effect (FR-5), alongside initNotifications(). Idempotent. */
export function initAudioCues(backend: AudioBackend = webAudioBackend): void {
  if (initialized) return;
  initialized = true;
  installGestureListener();
  registerTriggerSink((t) => {
    void handleTrigger(t, backend);
  });
}
