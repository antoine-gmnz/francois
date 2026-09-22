import { describe, expect, it } from 'vitest';
import { LOGO_BAR_OPACITY, logoGeometry } from './Logo';

// Redesign "Graphite & Signal", App bar (126:158) "Logo": a 20px box holding
// three left-aligned bars that shorten and fade top to bottom —
// 14.5 / 10.9 / 7.3 wide, 3.6 tall, left 2.7, tops 2.7 / 8.2 / 13.6, opacity
// 1 / .7 / .4.
describe('logoGeometry', () => {
  it('matches the app bar mark at its drawn 20px size', () => {
    const geo = logoGeometry(20);
    expect(geo.size).toBe(20);
    const [a, b, c] = geo.bars;
    for (const bar of geo.bars) {
      expect(bar.left).toBeCloseTo(2.7, 5);
      expect(bar.height).toBeCloseTo(3.6, 5);
    }
    expect(a.width).toBeCloseTo(14.5, 5);
    expect(b.width).toBeCloseTo(10.9, 5);
    expect(c.width).toBeCloseTo(7.3, 5);
    expect(a.top).toBeCloseTo(2.7, 5);
    expect(b.top).toBeCloseTo(8.2, 5);
    expect(c.top).toBeCloseTo(13.6, 5);
  });

  it('scales linearly', () => {
    const geo = logoGeometry(40);
    expect(geo.bars[0].width).toBeCloseTo(29, 5);
    expect(geo.bars[2].top).toBeCloseTo(27.2, 5);
  });

  it('fades the bars 1 / .7 / .4', () => {
    expect(LOGO_BAR_OPACITY).toEqual([1, 0.7, 0.4]);
  });
});
