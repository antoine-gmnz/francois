import { describe, expect, it } from 'vitest';
import { meterPercent } from './Meter';

describe('meterPercent', () => {
  it('clamps to 0..100 and rounds to one decimal', () => {
    expect(meterPercent(0.47)).toBe(47);
    expect(meterPercent(0.1234)).toBe(12.3);
    expect(meterPercent(-1)).toBe(0);
    expect(meterPercent(3)).toBe(100);
  });

  it('treats a non-finite fraction as empty', () => {
    expect(meterPercent(Number.NaN)).toBe(0);
    expect(meterPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
