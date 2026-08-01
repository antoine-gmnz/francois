// Pure pixel rasteriser for the icon geometry in geometry.mjs — no I/O, so it
// is unit-testable; render-icon.mjs is the side of the pair that encodes the
// buffer to PNG bytes and writes the file.
//
// Both shapes here are convex (a rounded rect, and each slab's four-point
// parallelogram), so coverage is computed analytically per pixel from a
// signed-distance approximation rather than by supersampling the whole
// canvas: cheap, and the corners still come out smooth because the distance
// (not just a hit-test) drives a half-pixel-wide antialiasing ramp.

import { computeIconGeometry } from './geometry.mjs';

export function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

/** #rrggbb -> [r, g, b] (0-255 each). */
export function hexToRgb(hex) {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Signed distance from point (px, py) to the boundary of a rounded rect
 * (negative = inside). Standard rounded-box SDF.
 */
export function roundedRectDistance(px, py, rect) {
  const { x, y, width, height, radius } = rect;
  const r = Math.min(radius, width / 2, height / 2);
  const cx = x + width / 2;
  const cy = y + height / 2;
  const qx = Math.abs(px - cx) - (width / 2 - r);
  const qy = Math.abs(py - cy) - (height / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

/** Antialiased [0, 1] coverage of a rounded rect at (px, py) — a half-pixel ramp around the edge. */
export function roundedRectCoverage(px, py, rect) {
  return clamp01(0.5 - roundedRectDistance(px, py, rect));
}

/**
 * Signed distance from (px, py) to the boundary of a convex polygon given as
 * clockwise `points` (negative = inside). Exact away from corners (the true
 * per-edge distance); near a corner it slightly over-estimates being
 * "inside" the corner, which just softens that corner a hair — invisible at
 * the sizes this renders.
 */
export function polygonDistance(px, py, points) {
  let maxEdgeDistance = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const edgeLength = Math.hypot(bx - ax, by - ay);
    if (edgeLength === 0) continue;
    // Cross product of edge and (point - a), in screen space (y grows down):
    // for `points` wound top-left -> top-right -> bottom-right -> bottom-left
    // (as parallelogramPoints returns), this is negative on the inside.
    const cross = (by - ay) * (px - ax) - (bx - ax) * (py - ay);
    maxEdgeDistance = Math.max(maxEdgeDistance, cross / edgeLength);
  }
  return maxEdgeDistance;
}

/** Antialiased [0, 1] coverage of a convex polygon at (px, py). */
export function polygonCoverage(px, py, points) {
  return clamp01(0.5 - polygonDistance(px, py, points));
}

/** Alpha-composite `[r, g, b]` over `dst = [r, g, b, a]` (0-1 alpha) at `coverage`, in place. */
function compositeOver(dst, rgb, coverage) {
  if (coverage <= 0) return;
  const [dr, dg, db, da] = dst;
  const outAlpha = coverage + da * (1 - coverage);
  if (outAlpha <= 0) return;
  dst[0] = (rgb[0] * coverage + dr * da * (1 - coverage)) / outAlpha;
  dst[1] = (rgb[1] * coverage + dg * da * (1 - coverage)) / outAlpha;
  dst[2] = (rgb[2] * coverage + db * da * (1 - coverage)) / outAlpha;
  dst[3] = outAlpha;
}

/**
 * Render the icon at `canvasSize` px (the tile fills the canvas — see
 * geometry.mjs) to a straight-alpha RGBA byte buffer, row-major, 4 bytes/px.
 */
export function renderIconRGBA(canvasSize) {
  const geo = computeIconGeometry(canvasSize);
  const tileFillRgb = hexToRgb(geo.tile.fill);
  const tileBorderRgb = hexToRgb(geo.tile.borderColor);
  const inner = {
    x: geo.tile.x + geo.tile.borderWidth,
    y: geo.tile.y + geo.tile.borderWidth,
    width: geo.tile.width - 2 * geo.tile.borderWidth,
    height: geo.tile.height - 2 * geo.tile.borderWidth,
    radius: geo.tile.radius - geo.tile.borderWidth,
  };
  const slabRgb = geo.slabs.map((s) => hexToRgb(s.color));

  const buffer = new Uint8ClampedArray(canvasSize * canvasSize * 4);
  for (let py = 0; py < canvasSize; py++) {
    const y = py + 0.5;
    for (let px = 0; px < canvasSize; px++) {
      const x = px + 0.5;
      const dst = [0, 0, 0, 0];

      // Tile: draw the outer rounded rect in the border colour, then the
      // inset rect in the fill colour on top — the uncovered margin between
      // the two reads as a 1px inset border.
      compositeOver(dst, tileBorderRgb, roundedRectCoverage(x, y, geo.tile));
      compositeOver(dst, tileFillRgb, roundedRectCoverage(x, y, inner));

      // Slabs never overlap (the formula's gap keeps them apart), so plain
      // painter's-algorithm order is fine.
      for (let i = 0; i < geo.slabs.length; i++) {
        compositeOver(dst, slabRgb[i], polygonCoverage(x, y, geo.slabs[i].points));
      }

      const offset = (py * canvasSize + px) * 4;
      buffer[offset] = dst[0];
      buffer[offset + 1] = dst[1];
      buffer[offset + 2] = dst[2];
      buffer[offset + 3] = Math.round(dst[3] * 255);
    }
  }
  return buffer;
}
