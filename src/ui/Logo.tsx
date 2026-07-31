// The app mark: three slanted parallelogram slabs stacked bottom-to-top, each
// stepping right of the one below — design-refresh's replacement for the old
// rotated-square "diamond" glyph. Every size comes from ONE formula (see
// `logoGeometry`); per the specimen sheet ("Francois Logo.dc.html" turn 7a)
// "no size gets a hand-drawn exception". Geometry is genuinely dynamic per
// `size`, so inline `style` is the correct tool here — the CSS contract bans
// inline style only for values that don't vary at runtime (see
// CLAUDE.md/PIPELINE.md §Code layout).
//
// Colour is never a literal: the top two slabs are `var(--logo-slab)`, the
// bottom slab is `var(--logo-slab-dim)` — "the idle session, not a shadow", so
// it never takes the accent. Below the 16px floor (specimen 7b) the two-tone
// treatment breaks down before the shapes do, so the mark drops to single
// tone instead of thinning.
//
// The mark is never rotated, re-spaced, or given a third tone (specimen 7e) —
// this component has no props for any of that on purpose.

export const LOGO_CLIP_PATH = 'polygon(28% 0%, 100% 0%, 72% 100%, 0% 100%)';

/** Two-tone holds at and above this height; below it every slab is single tone. */
export const LOGO_TWO_TONE_MIN_SIZE = 16;

export interface LogoSlabGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LogoGeometry {
  /** Outer box width, `1.1 * size`. */
  width: number;
  /** Outer box height — equal to `size`. */
  height: number;
  /** Top, middle, bottom slabs, in that order. */
  slabs: [LogoSlabGeometry, LogoSlabGeometry, LogoSlabGeometry];
}

/**
 * The one formula that generates the mark at every size (specimen sheet 7a):
 * outer box 1.1×H, each slab 0.9H wide and 0.275H tall, tops at 0 / 0.3625H /
 * 0.725H (an 0.0875H gap between slabs), lefts at 0.2H / 0.1H / 0 — top to
 * bottom, each one stepping left as it steps down.
 */
export function logoGeometry(size: number): LogoGeometry {
  const slabWidth = size * 0.9;
  const slabHeight = size * 0.275;
  const tops = [0, size * 0.3625, size * 0.725];
  const lefts = [size * 0.2, size * 0.1, 0];
  const slabs = tops.map((top, i) => ({ left: lefts[i], top, width: slabWidth, height: slabHeight })) as [
    LogoSlabGeometry,
    LogoSlabGeometry,
    LogoSlabGeometry,
  ];
  return { width: size * 1.1, height: size, slabs };
}

/** Whether `size` is large enough for the two-tone treatment (specimen 7b). */
export function logoIsTwoTone(size: number): boolean {
  return size >= LOGO_TWO_TONE_MIN_SIZE;
}

/** Fill colour for slab `index` (0 = top, 2 = bottom) at `size`. */
export function logoSlabColor(index: number, size: number): string {
  return index === 2 && logoIsTwoTone(size) ? 'var(--logo-slab-dim)' : 'var(--logo-slab)';
}

export interface LogoProps {
  /** The mark's HEIGHT in px — the ramp's single input. Defaults to 16 (tab/titlebar size). */
  size?: number;
  /** Accessible label; the mark renders no visible text of its own. */
  title?: string;
}

export function Logo({ size = 16, title }: LogoProps): JSX.Element {
  const { width, height, slabs } = logoGeometry(size);
  return (
    <span
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className="logo-mark"
      style={{ position: 'relative', display: 'inline-block', flexShrink: 0, width, height }}
    >
      {slabs.map((slab, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            left: slab.left,
            top: slab.top,
            width: slab.width,
            height: slab.height,
            clipPath: LOGO_CLIP_PATH,
            background: logoSlabColor(i, size),
          }}
        />
      ))}
    </span>
  );
}
