// contract/audio-cues.ts — short synthesized tones for the two notification
// trigger classes. Authored from specs/audio-cues.md §5. Imports the shared
// vocabulary from common.ts / notifications.ts and never redefines it.

import type { NotifyClass } from './notifications';

/** OS Do Not Disturb / Focus / Quiet Hours state (FR-14..FR-19).
 *  `supported:false` means we have no probe for this platform (or it failed) —
 *  the caller MUST treat that as "not suppressed" and play (FR-15). */
export interface DndState {
  dnd: boolean;
  supported: boolean;
}

/** The audio sink reuses the notification classes 1:1 — one tone each. */
export type AudioClass = NotifyClass;

/** Envelope for one tone. Frequencies in Hz, gains 0..1, times in ms from start. */
export interface ToneSpec {
  /** Starting frequency. */
  freq: number;
  /** Second note, for a two-note tone. Undefined ⇒ single note. */
  freqTo?: number;
  /** When the second note starts (ms from tone start). */
  freqAtMs?: number;
  /** Peak gain after the attack ramp. Fixed — there is no volume control. */
  peakGain: number;
  /** Linear ramp 0 → peakGain. */
  attackMs: number;
  /** Total tone length; the gain decays exponentially to 0.0001 by this point. */
  durationMs: number;
}

/**
 * The two tones (FR-8), pinned here so "quiet" is not the implementer's call.
 * attention: a rising perfect fourth — reads as a question, carries in noise.
 * turnDone : one soft note an interval below — plainly a different event.
 */
export const TONES: Record<AudioClass, ToneSpec> = {
  attention: { freq: 660, freqTo: 880, freqAtMs: 90, peakGain: 0.26, attackMs: 8, durationMs: 180 },
  turnDone: { freq: 440, peakGain: 0.19, attackMs: 8, durationMs: 140 },
};

/** At most one tone per window; a tone inside it is dropped, never queued (FR-6). */
export const COALESCE_WINDOW_MS = 1500;

/** How long a DND probe result is reused before re-probing (FR-20). */
export const DND_CACHE_TTL_MS = 10_000;

/** localStorage key for the master toggle (FR-11). Absent ⇒ on. */
export const SOUND_ENABLED_KEY = 'francois.sound.enabled';

/** Everything the `◇ muted` chip can be reporting (FR-13). */
export type MutedChannel = NotifyClass | 'sound';

/** Chip-title phrase per channel — enumerated so the chip is never a mystery. */
export const MUTED_CHANNEL_LABEL: Record<MutedChannel, string> = {
  attention: 'approvals & questions notifications',
  turnDone: 'turn finished notifications',
  sound: 'audio cues',
};

/** All three off — read as one phrase rather than a list (FR-13). */
export const MUTED_ALL_TITLE = 'all notifications and audio cues are off';
