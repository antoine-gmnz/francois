// notifications FR-19 / audio-cues FR-13 — pure derivation for the status-bar
// "muted" chip: what it reads is the list of OFF channels (attention,
// turnDone, sound) — no counts, no session names (design brief "Data
// shown"). Split out from the component so the rule is unit-testable with no
// DOM.

import type { MutedChannel } from '../../../contract/audio-cues';
import { MUTED_ALL_TITLE, MUTED_CHANNEL_LABEL } from '../../../contract/audio-cues';

const ALL_CHANNELS: readonly MutedChannel[] = ['attention', 'turnDone', 'sound'];

/** `null` ⇒ render nothing (all three channels on, the default state). */
export function mutedChipLabel(off: readonly MutedChannel[]): string | null {
  if (off.length === 0) return null;
  return off.length === ALL_CHANNELS.length ? 'muted (all)' : 'muted';
}

/** Native `title` naming exactly what is silenced. '' when nothing is. */
export function mutedChipTitle(off: readonly MutedChannel[]): string {
  if (off.length === 0) return '';
  if (off.length === ALL_CHANNELS.length) return MUTED_ALL_TITLE;
  return `${off.map((c) => MUTED_CHANNEL_LABEL[c]).join(', ')} are off`;
}
