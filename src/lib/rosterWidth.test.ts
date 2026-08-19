// resizable-sidebar: covers the pure roster-width helpers — rosterCap
// (per-regime fraction, MAX_ROSTER_WIDTH ceiling), clampRosterWidth (floor,
// cap, garbage input per FR-7/FR-8), parseRosterWidth (storage normalizer)
// and rosterWidthFromDrag (drag math + the snap-collapse boundary, FR-6).
//
// The store slice (persistence, no-op writes) is covered in layoutStore.test.ts
// alongside its sibling splitRatio slice.

import { describe, expect, it } from 'vitest';
import {
  clampRosterWidth,
  DEFAULT_ROSTER_WIDTH,
  MAX_ROSTER_WIDTH,
  MIN_ROSTER_WIDTH,
  parseRosterWidth,
  ROSTER_CAP_FRACTION,
  rosterCap,
  rosterWidthFromDrag,
} from './rosterWidth';

describe('rosterCap', () => {
  it('applies the single-regime fraction', () => {
    expect(rosterCap(1000, 'single')).toBe(1000 * ROSTER_CAP_FRACTION.single);
  });

  it('applies the tighter split-regime fraction', () => {
    expect(rosterCap(1000, 'split')).toBe(1000 * ROSTER_CAP_FRACTION.split);
  });

  it('grid uses the single fraction — FR-11: no handle there, so this is only ever a render-time fallback', () => {
    expect(rosterCap(1000, 'grid')).toBe(rosterCap(1000, 'single'));
  });

  it('never exceeds MAX_ROSTER_WIDTH on a wide viewport', () => {
    expect(rosterCap(4000, 'single')).toBe(MAX_ROSTER_WIDTH);
  });

  it('degrades to 0 on a garbage viewport rather than NaN-ing', () => {
    expect(rosterCap(NaN, 'single')).toBe(0);
    expect(rosterCap(-500, 'single')).toBe(0);
  });
});

describe('clampRosterWidth', () => {
  it('passes an in-range width through unchanged', () => {
    expect(clampRosterWidth(300, 2000, 'single')).toBe(300);
  });

  it('clamps to the cap on the wide end', () => {
    expect(clampRosterWidth(99999, 1200, 'single')).toBe(rosterCap(1200, 'single'));
    expect(clampRosterWidth(99999, 4000, 'single')).toBe(MAX_ROSTER_WIDTH);
  });

  it('clamps to MIN_ROSTER_WIDTH on the narrow end', () => {
    expect(clampRosterWidth(-5, 2000, 'single')).toBe(MIN_ROSTER_WIDTH);
    expect(clampRosterWidth(0, 2000, 'single')).toBe(MIN_ROSTER_WIDTH);
  });

  it('the floor wins when the cap computes below MIN_ROSTER_WIDTH (FR-7)', () => {
    // 0.30 * 300 = 90px, well under the 180 floor.
    expect(clampRosterWidth(520, 300, 'split')).toBe(MIN_ROSTER_WIDTH);
  });

  it('falls back to the default for a non-finite width rather than throwing', () => {
    expect(clampRosterWidth(NaN, 2000, 'single')).toBe(clampRosterWidth(DEFAULT_ROSTER_WIDTH, 2000, 'single'));
  });

  it('a 520px roster clamps entering split and is restored leaving it (acceptance §9)', () => {
    const viewport = 1400;
    expect(clampRosterWidth(520, viewport, 'split')).toBe(rosterCap(viewport, 'split'));
    expect(clampRosterWidth(520, viewport, 'single')).toBe(520);
  });
});

describe('parseRosterWidth', () => {
  it('defaults for an absent or malformed persisted value', () => {
    expect(parseRosterWidth(null)).toBe(DEFAULT_ROSTER_WIDTH);
    expect(parseRosterWidth('')).toBe(DEFAULT_ROSTER_WIDTH);
    expect(parseRosterWidth('abc')).toBe(DEFAULT_ROSTER_WIDTH);
    expect(parseRosterWidth('NaN')).toBe(DEFAULT_ROSTER_WIDTH);
  });

  it('reads back the raw stored intent, unclamped', () => {
    expect(parseRosterWidth('520')).toBe(520);
    expect(parseRosterWidth('99999')).toBe(99999);
    expect(parseRosterWidth('-5')).toBe(-5);
  });
});

describe('rosterWidthFromDrag', () => {
  it('maps the pointer to a width relative to the grid content-box left', () => {
    expect(rosterWidthFromDrag(500, 100, 2000, 'single')).toEqual({ width: 400, collapse: false });
  });

  it('flags collapse below MIN_ROSTER_WIDTH, but still returns a floored width', () => {
    const result = rosterWidthFromDrag(150, 100, 2000, 'single'); // raw = 50
    expect(result.collapse).toBe(true);
    expect(result.width).toBe(MIN_ROSTER_WIDTH);
  });

  it('the snap boundary sits exactly at MIN_ROSTER_WIDTH', () => {
    expect(rosterWidthFromDrag(100 + MIN_ROSTER_WIDTH, 100, 2000, 'single').collapse).toBe(false);
    expect(rosterWidthFromDrag(100 + MIN_ROSTER_WIDTH - 1, 100, 2000, 'single').collapse).toBe(true);
  });

  it('clamps to the regime cap on the wide end', () => {
    const result = rosterWidthFromDrag(100 + 9999, 100, 1200, 'split');
    expect(result.width).toBe(rosterCap(1200, 'split'));
    expect(result.collapse).toBe(false);
  });
});
