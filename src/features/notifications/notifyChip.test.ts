// notifications FR-19 / audio-cues FR-13 — the muted-chip pure derivation.
// Design brief §1: hidden when all three channels are on, "muted" for one or
// two off, "muted (all)" for all three off, and a title naming exactly what
// is silenced.

import { describe, expect, it } from 'vitest';
import { mutedChipLabel, mutedChipTitle } from './notifyChip';

describe('mutedChipLabel (FR-13)', () => {
  it('renders nothing when all three channels are on', () => {
    expect(mutedChipLabel([])).toBeNull();
  });

  it('reads "muted" when exactly one channel is off', () => {
    expect(mutedChipLabel(['attention'])).toBe('muted');
    expect(mutedChipLabel(['turnDone'])).toBe('muted');
    expect(mutedChipLabel(['sound'])).toBe('muted');
  });

  it('reads "muted" when exactly two channels are off', () => {
    expect(mutedChipLabel(['attention', 'sound'])).toBe('muted');
  });

  it('reads "muted (all)" when all three channels are off', () => {
    expect(mutedChipLabel(['attention', 'turnDone', 'sound'])).toBe('muted (all)');
  });
});

describe('mutedChipTitle (FR-13)', () => {
  it('names the single silenced channel', () => {
    expect(mutedChipTitle(['turnDone'])).toBe('turn finished notifications are off');
    expect(mutedChipTitle(['attention'])).toBe('approvals & questions notifications are off');
    expect(mutedChipTitle(['sound'])).toBe('audio cues are off');
  });

  it('enumerates two silenced channels, comma-separated', () => {
    expect(mutedChipTitle(['attention', 'sound'])).toBe('approvals & questions notifications, audio cues are off');
  });

  it('names the pinned "all three off" phrase', () => {
    expect(mutedChipTitle(['attention', 'turnDone', 'sound'])).toBe('all notifications and audio cues are off');
  });
});
