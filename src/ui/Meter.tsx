// The thin 3px meter the design uses for plan usage (app bar) and context (the
// session panel footer): a --bg-selected track with a --text-primary fill.
// `width` is the track length in px; omit it to let the track flex.

import type { CSSProperties } from 'react';
import './ui.css';

/** 0..1 → a clamped percentage with one decimal; non-finite reads as empty. */
export function meterPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.round(clamped * 1000) / 10;
}

export interface MeterProps {
  /** 0..1 */
  fraction: number;
  /** Track width in px; flexes to fill when omitted. */
  width?: number;
  /** Fill tone — defaults to --text-primary. */
  tone?: 'default' | 'danger' | 'attention';
  title?: string;
  className?: string;
}

export function Meter({ fraction, width, tone = 'default', title, className }: MeterProps): JSX.Element {
  const classes = ['meter'];
  if (width === undefined) classes.push('meter--flex');
  if (tone !== 'default') classes.push(`meter--${tone}`);
  if (className) classes.push(className);
  const percent = meterPercent(fraction);
  // Runtime values: the fill fraction and the caller's track width.
  const style = { '--meter-fill': `${percent}%`, ...(width !== undefined ? { width } : null) } as CSSProperties;
  return (
    <span
      className={classes.join(' ')}
      style={style}
      title={title}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span className="meter__fill" />
    </span>
  );
}
