// One glyph from the Graphite icon set (icons.ts / icons.css). Takes
// `currentColor`, so set the tone on the parent in the feature's CSS. `size` is
// the rendered square in px (the design uses 10–16). Size and asset URL are
// runtime values, hence the two inline custom properties.

import type { CSSProperties } from 'react';
import { iconAssetUrl, type IconName } from './icons';
import './icons.css';

export interface IconProps {
  name: IconName;
  /** Square size in px. Defaults to 16 (the set's native size). */
  size?: number;
  className?: string;
  /** Accessible label. Without one the glyph is decorative (aria-hidden). */
  title?: string;
}

export function Icon({ name, size = 16, className, title }: IconProps): JSX.Element {
  return (
    <span
      className={className ? `icon ${className}` : 'icon'}
      style={{ '--icon-size': `${size}px`, '--icon-src': `url("${iconAssetUrl(name)}")` } as CSSProperties}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      title={title}
    />
  );
}
