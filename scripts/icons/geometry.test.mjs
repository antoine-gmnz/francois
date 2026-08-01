import { describe, expect, it } from 'vitest';
import {
  computeIconGeometry,
  parallelogramPoints,
  SLAB_DIM,
  SLAB_LIVE,
  TILE_BORDER,
  TILE_FILL,
} from './geometry.mjs';

function expectPointsClose(actual, expected) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach(([x, y], i) => {
    expect(x).toBeCloseTo(expected[i][0], 9);
    expect(y).toBeCloseTo(expected[i][1], 9);
  });
}

describe('parallelogramPoints', () => {
  it('maps the clip-path polygon(28% 0%, 100% 0%, 72% 100%, 0% 100%) onto a rect', () => {
    expectPointsClose(parallelogramPoints(0, 0, 100, 20), [
      [28, 0],
      [100, 0],
      [72, 20],
      [0, 20],
    ]);
  });

  it('offsets by the rect origin', () => {
    expectPointsClose(parallelogramPoints(10, 5, 100, 20), [
      [38, 5],
      [110, 5],
      [82, 25],
      [10, 25],
    ]);
  });
});

describe('computeIconGeometry', () => {
  it('sizes the tile to fill the requested square exactly, with a radius ~21% of it', () => {
    const geo = computeIconGeometry(104);
    expect(geo.tile).toMatchObject({ x: 0, y: 0, width: 104, height: 104, fill: TILE_FILL, borderColor: TILE_BORDER });
    // 6c's reference: a 104px tile with a 22px radius.
    expect(geo.tile.radius).toBeCloseTo(22, 5);
    expect(geo.tile.borderWidth).toBeCloseTo(1, 5);
  });

  it('centres a mark ~54.8% of the tile height, close to 6c\'s hand-placed reference', () => {
    // 6c ("Francois Logo.dc.html" turn 6c): slabs 52×15, lefts 34/28/22, tops
    // 26/47/68 at 104px — those are hand-rounded to the pixel, so this checks
    // the generic formula lands within a few px of them, not an exact match
    // (see the report for the titlebar's parallel 7d discrepancy).
    const geo = computeIconGeometry(104);
    expect(geo.slabs).toHaveLength(3);

    const widths = geo.slabs.map((s) => s.points[1][0] - s.points[3][0]);
    for (const w of widths) expect(w).toBeCloseTo(51.3, 0);

    const heights = geo.slabs.map((s) => s.points[3][1] - s.points[0][1]);
    for (const h of heights) expect(h).toBeCloseTo(15.7, 0);

    const tops = geo.slabs.map((s) => s.points[0][1]);
    expect(tops[0]).toBeGreaterThanOrEqual(20);
    expect(tops[0]).toBeLessThanOrEqual(27);
    expect(tops[2]).toBeGreaterThanOrEqual(62);
    expect(tops[2]).toBeLessThanOrEqual(69);
  });

  it('colours the top two slabs live and the bottom slab dim — the idle session, never the accent', () => {
    const geo = computeIconGeometry(1024);
    expect(geo.slabs[0].color).toBe(SLAB_LIVE);
    expect(geo.slabs[1].color).toBe(SLAB_LIVE);
    expect(geo.slabs[2].color).toBe(SLAB_DIM);
  });

  it('scales linearly with size', () => {
    const small = computeIconGeometry(104);
    const big = computeIconGeometry(1040);
    expect(big.tile.radius).toBeCloseTo(small.tile.radius * 10, 5);
    const widthAt = (geo, i) => geo.slabs[i].points[1][0] - geo.slabs[i].points[3][0];
    expect(widthAt(big, 0)).toBeCloseTo(widthAt(small, 0) * 10, 5);
  });
});
