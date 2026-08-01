// notifications FR-19 — the muted-chip pure derivation. Design brief §1: hidden
// when both classes are on, "muted" for one, "muted (all)" for both, and a
// title naming exactly what is silenced.

import { describe, expect, it } from 'vitest';
import { mutedChipLabel, mutedChipTitle } from './notifyChip';

describe('mutedChipLabel (FR-19)', () => {
  it('renders nothing when both classes are on', () => {
    expect(mutedChipLabel({ attention: true, turnDone: true })).toBeNull();
  });

  it('reads "muted" when exactly one class is off', () => {
    expect(mutedChipLabel({ attention: true, turnDone: false })).toBe('muted');
    expect(mutedChipLabel({ attention: false, turnDone: true })).toBe('muted');
  });

  it('reads "muted (all)" when both classes are off', () => {
    expect(mutedChipLabel({ attention: false, turnDone: false })).toBe('muted (all)');
  });
});

describe('mutedChipTitle (FR-19)', () => {
  it('names the silenced class', () => {
    expect(mutedChipTitle({ attention: true, turnDone: false })).toBe('turn finished notifications are off');
    expect(mutedChipTitle({ attention: false, turnDone: true })).toBe('approvals & questions notifications are off');
  });

  it('names "all" when both are silenced', () => {
    expect(mutedChipTitle({ attention: false, turnDone: false })).toBe('all notifications are off');
  });
});
