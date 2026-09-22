import { describe, expect, it } from 'vitest';
import { shouldNotifyGate, type GateNotifyFacts } from './notify';

const base: GateNotifyFacts = { prefOn: true, alreadyNotified: false, firstSeenAt: 1_000, requestedAt: 1_000, windowFocused: false, originVisible: true };

describe('shouldNotifyGate (FR-87)', () => {
  it('fires when the window is unfocused', () => expect(shouldNotifyGate(base)).toBe(true));
  it('fires when focused but the origin session is not on screen', () => {
    expect(shouldNotifyGate({ ...base, windowFocused: true, originVisible: false })).toBe(true);
    expect(shouldNotifyGate({ ...base, windowFocused: true, originVisible: true })).toBe(false);
  });
  it('is off with the pref off, and once per approval', () => {
    expect(shouldNotifyGate({ ...base, prefOn: false })).toBe(false);
    expect(shouldNotifyGate({ ...base, alreadyNotified: true })).toBe(false);
  });
  it('stays silent for backfill of a run first seen >60 s after its gate opened', () => {
    expect(shouldNotifyGate({ ...base, firstSeenAt: 70_000, requestedAt: 1_000 })).toBe(false);
    expect(shouldNotifyGate({ ...base, firstSeenAt: 50_000, requestedAt: 1_000 })).toBe(true);
  });
});
