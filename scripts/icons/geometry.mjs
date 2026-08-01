// Pure geometry/colour decisions for the app-icon tile (design 6c —
// "Francois Logo.dc.html" turn 6c, "Francois Design System v2.dc.html" §Mark).
// No I/O lives here so it can be unit-tested; raster.mjs turns this into
// pixels and render-icon.mjs is the side of the pair that writes a file.
//
// Same three-slab formula as src/ui/Logo.tsx (clip-path: polygon(28% 0%,
// 100% 0%, 72% 100%, 0% 100%)), just re-centred inside a rounded tile instead
// of sitting at the origin: mark height is 54.8% of the tile, radius ~21% of
// the tile (6c's reference: a 104px tile with a 22px radius).

export const TILE_FILL = '#12160e';
export const TILE_BORDER = '#2a3320';
export const SLAB_LIVE = '#c3f53f';
export const SLAB_DIM = '#5f7a1e';

/** 6c's reference tile: 104px with a 22px corner radius and a 1px border. */
export const TILE_RADIUS_FRACTION = 22 / 104;
export const TILE_BORDER_FRACTION = 1 / 104;

/** Mark height as a fraction of the tile height (6c: "~54.8%"). */
export const MARK_HEIGHT_FRACTION = 0.548;

/** The mark's own formula (mirrors `logoGeometry` in src/ui/Logo.tsx). */
const SLAB_WIDTH_FRACTION = 0.9;
const SLAB_HEIGHT_FRACTION = 0.275;
const SLAB_TOP_FRACTIONS = [0, 0.3625, 0.725];
const SLAB_LEFT_FRACTIONS = [0.2, 0.1, 0];

/**
 * The four vertices of the slanted-parallelogram clip-path
 * (`polygon(28% 0%, 100% 0%, 72% 100%, 0% 100%)`) mapped onto a rect at
 * `(x, y)` sized `width` × `height`, in clockwise order starting top-left.
 */
export function parallelogramPoints(x, y, width, height) {
  return [
    [x + 0.28 * width, y],
    [x + width, y],
    [x + 0.72 * width, y + height],
    [x, y + height],
  ];
}

/**
 * Full icon geometry for a square tile of side `size`: the rounded tile
 * (fill + inset border) and the three slab polygons, centred.
 */
export function computeIconGeometry(size) {
  const radius = size * TILE_RADIUS_FRACTION;
  const borderWidth = size * TILE_BORDER_FRACTION;

  const markHeight = size * MARK_HEIGHT_FRACTION;
  const slabWidth = markHeight * SLAB_WIDTH_FRACTION;
  const slabHeight = markHeight * SLAB_HEIGHT_FRACTION;
  const markWidth = markHeight * 1.1;
  const originX = (size - markWidth) / 2;
  const originY = (size - markHeight) / 2;

  const colors = [SLAB_LIVE, SLAB_LIVE, SLAB_DIM];
  const slabs = SLAB_TOP_FRACTIONS.map((topFraction, i) => {
    const x = originX + SLAB_LEFT_FRACTIONS[i] * markHeight;
    const y = originY + topFraction * markHeight;
    return { points: parallelogramPoints(x, y, slabWidth, slabHeight), color: colors[i] };
  });

  return {
    size,
    tile: { x: 0, y: 0, width: size, height: size, radius, fill: TILE_FILL, borderColor: TILE_BORDER, borderWidth },
    slabs,
  };
}
