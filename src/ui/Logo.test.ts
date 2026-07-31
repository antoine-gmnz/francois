import { describe, expect, it } from 'vitest';
import { logoGeometry, logoIsTwoTone, logoSlabColor } from './Logo';

describe('logoGeometry', () => {
  it('matches the specimen sheet 128px row exactly', () => {
    // Francois Logo.dc.html turn 7a, the 128px column: box 140.8×128, slabs
    // 115.2×35.2, tops 0/46.4/92.8, lefts 25.6/12.8/0.
    const geo = logoGeometry(128);
    expect(geo.width).toBeCloseTo(140.8, 10);
    expect(geo.height).toBe(128);

    const [top, middle, bottom] = geo.slabs;
    for (const slab of geo.slabs) {
      expect(slab.width).toBeCloseTo(115.2, 10);
      expect(slab.height).toBeCloseTo(35.2, 10);
    }
    expect(top.top).toBe(0);
    expect(top.left).toBeCloseTo(25.6, 10);
    expect(middle.top).toBeCloseTo(46.4, 10);
    expect(middle.left).toBeCloseTo(12.8, 10);
    expect(bottom.top).toBeCloseTo(92.8, 10);
    expect(bottom.left).toBe(0);
  });

  it('scales linearly at a second size (16px, the titlebar/tab floor)', () => {
    // Same sheet, 16px column: box 17.6×16, slabs 14.4×4.4, tops 0/5.8/11.6, lefts 3.2/1.6/0.
    const geo = logoGeometry(16);
    expect(geo.width).toBeCloseTo(17.6, 10);
    expect(geo.height).toBe(16);
    expect(geo.slabs[0]).toMatchObject({ left: expect.closeTo(3.2, 10), top: 0, width: expect.closeTo(14.4, 10), height: expect.closeTo(4.4, 10) });
    expect(geo.slabs[1].top).toBeCloseTo(5.8, 10);
    expect(geo.slabs[1].left).toBeCloseTo(1.6, 10);
    expect(geo.slabs[2].top).toBeCloseTo(11.6, 10);
    expect(geo.slabs[2].left).toBe(0);
  });
});

describe('logoIsTwoTone', () => {
  it('holds two-tone at and above the 16px floor', () => {
    expect(logoIsTwoTone(16)).toBe(true);
    expect(logoIsTwoTone(128)).toBe(true);
  });

  it('drops to single tone below 16px — specimen 7b marks two-tone-at-12 as "don\'t"', () => {
    expect(logoIsTwoTone(12)).toBe(false);
    expect(logoIsTwoTone(15)).toBe(false);
  });
});

describe('logoSlabColor', () => {
  it('gives the top two slabs the live colour at every size', () => {
    expect(logoSlabColor(0, 128)).toBe('var(--logo-slab)');
    expect(logoSlabColor(1, 128)).toBe('var(--logo-slab)');
    expect(logoSlabColor(0, 12)).toBe('var(--logo-slab)');
    expect(logoSlabColor(1, 12)).toBe('var(--logo-slab)');
  });

  it('gives the bottom slab the dim colour above the floor, live colour below it', () => {
    expect(logoSlabColor(2, 16)).toBe('var(--logo-slab-dim)');
    expect(logoSlabColor(2, 128)).toBe('var(--logo-slab-dim)');
    expect(logoSlabColor(2, 12)).toBe('var(--logo-slab)');
  });
});
