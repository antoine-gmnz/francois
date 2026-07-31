import { describe, expect, it } from 'vitest';
import { clamp01, hexToRgb, polygonCoverage, renderIconRGBA, roundedRectCoverage } from './raster.mjs';

describe('clamp01', () => {
  it('clamps to [0, 1]', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(2)).toBe(1);
  });
});

describe('hexToRgb', () => {
  it('parses #rrggbb', () => {
    expect(hexToRgb('#c3f53f')).toEqual([0xc3, 0xf5, 0x3f]);
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
  });
});

describe('roundedRectCoverage', () => {
  const rect = { x: 0, y: 0, width: 100, height: 100, radius: 20 };

  it('is full coverage well inside the rect', () => {
    expect(roundedRectCoverage(50, 50, rect)).toBe(1);
  });

  it('is zero well outside the rect', () => {
    expect(roundedRectCoverage(-10, -10, rect)).toBe(0);
  });

  it('is zero in the cut-off corner, even though that point is inside the bare bounding box', () => {
    expect(roundedRectCoverage(2, 2, rect)).toBe(0);
  });

  it('is full coverage on a straight edge, away from any corner', () => {
    expect(roundedRectCoverage(50, 1, rect)).toBe(1);
  });
});

describe('polygonCoverage', () => {
  // The clip-path parallelogram polygon(28% 0%, 100% 0%, 72% 100%, 0% 100%)
  // mapped onto a 100×40 rect at the origin.
  const points = [
    [28, 0],
    [100, 0],
    [72, 40],
    [0, 40],
  ];

  it('is full coverage at the centroid', () => {
    expect(polygonCoverage(50, 20, points)).toBe(1);
  });

  it('is zero well outside the polygon', () => {
    expect(polygonCoverage(-20, 20, points)).toBe(0);
  });

  it('is zero above the top edge and below the bottom edge', () => {
    expect(polygonCoverage(50, -5, points)).toBe(0);
    expect(polygonCoverage(50, 45, points)).toBe(0);
  });

  it('is zero left of the slanted left edge at the top (28% clip)', () => {
    // At y=0 the polygon only starts at x=28; x=10 is outside there.
    expect(polygonCoverage(10, 0.5, points)).toBe(0);
  });
});

describe('renderIconRGBA', () => {
  const size = 200;
  const buf = renderIconRGBA(size);
  const at = (x, y) => {
    const o = (y * size + x) * 4;
    return [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]];
  };

  it('returns a straight-alpha RGBA buffer sized for the requested canvas', () => {
    expect(buf.length).toBe(size * size * 4);
  });

  it('is fully transparent in the rounded-off corner', () => {
    expect(at(0, 0)).toEqual([0, 0, 0, 0]);
    expect(at(1, 1)).toEqual([0, 0, 0, 0]);
  });

  it('is the tile fill colour on flat background, clear of the mark', () => {
    expect(at(170, 30)).toEqual([0x12, 0x16, 0x0e, 255]);
    expect(at(30, 170)).toEqual([0x12, 0x16, 0x0e, 255]);
  });

  it('is the live colour at the centroid of the top two slabs', () => {
    expect(at(111, 60)).toEqual([0xc3, 0xf5, 0x3f, 255]);
    expect(at(100, 100)).toEqual([0xc3, 0xf5, 0x3f, 255]);
  });

  it('is the dim colour at the centroid of the bottom slab — never the accent', () => {
    expect(at(89, 140)).toEqual([0x5f, 0x7a, 0x1e, 255]);
  });

  it('is opaque and clear of the mark in the gap between slabs', () => {
    expect(at(105, 76)).toEqual([0x12, 0x16, 0x0e, 255]);
  });
});
