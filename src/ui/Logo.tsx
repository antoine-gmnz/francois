// The app mark — redesign "Graphite & Signal" (Figma App bar 126:158, "Logo"):
// three left-aligned bars that shorten and fade top to bottom, a stack of
// sessions settling. Every size comes from ONE formula (`logoGeometry`), drawn
// at 20px in the app bar. Geometry is genuinely dynamic per `size`, so inline
// `style` is the correct tool here (the CSS contract bans inline style only for
// values that do not vary at runtime).
//
// Colour is never a literal: every bar is `var(--logo-slab)` (text/primary), and
// the fade is opacity — so the mark follows the theme with no second tone.

/** Fractions of the box, from the 20px Figma drawing. */
const BAR_LEFT = 2.7 / 20;
const BAR_HEIGHT = 3.6 / 20;
const BAR_WIDTHS = [14.5 / 20, 10.9 / 20, 7.3 / 20] as const;
const BAR_TOPS = [2.7 / 20, 8.2 / 20, 13.6 / 20] as const;

export const LOGO_BAR_OPACITY = [1, 0.7, 0.4] as const;

export interface LogoBarGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LogoGeometry {
  /** The square box, px. */
  size: number;
  /** Top, middle, bottom bar. */
  bars: [LogoBarGeometry, LogoBarGeometry, LogoBarGeometry];
}

export function logoGeometry(size: number): LogoGeometry {
  const bars = BAR_WIDTHS.map((w, i) => ({
    left: BAR_LEFT * size,
    top: BAR_TOPS[i] * size,
    width: w * size,
    height: BAR_HEIGHT * size,
  })) as [LogoBarGeometry, LogoBarGeometry, LogoBarGeometry];
  return { size, bars };
}

export interface LogoProps {
  /** The mark's box size in px. Defaults to 20 (the app bar). */
  size?: number;
  /** Accessible label; the mark renders no visible text of its own. */
  title?: string;
}

export function Logo({ size = 20, title }: LogoProps): JSX.Element {
  const { bars } = logoGeometry(size);
  const radius = Math.max(1, size / 20);
  return (
    <span
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className="logo-mark"
      // eslint-disable-next-line no-restricted-syntax -- runtime geometry: the box is `size`, which is a prop
      style={{ position: 'relative', display: 'inline-block', flexShrink: 0, width: size, height: size }}
    >
      {bars.map((bar, i) => (
        <span
          key={i}
          // eslint-disable-next-line no-restricted-syntax -- runtime geometry from logoGeometry(size)
          style={{
            position: 'absolute',
            left: bar.left,
            top: bar.top,
            width: bar.width,
            height: bar.height,
            borderRadius: radius,
            background: 'var(--logo-slab)',
            opacity: LOGO_BAR_OPACITY[i],
          }}
        />
      ))}
    </span>
  );
}
