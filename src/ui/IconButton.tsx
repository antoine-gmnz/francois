// A square icon-only control — the app bar's theme / settings (28px), the
// sidebar header's search / + (28px), the session header's panel toggle (30px,
// `framed`). Transparent at rest, --bg-raised on hover, --bg-selected when `on`.

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './ui.css';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'title'> {
  /** Required: an icon-only control has no other accessible name. */
  title: string;
  children: ReactNode;
  /** 24 · 28 · 30 · 34 px. Defaults to 28. */
  size?: 24 | 28 | 30 | 34;
  /** Pressed / current state. */
  on?: boolean;
  /** The session header's bordered variant (line/default edge, raised fill). */
  framed?: boolean;
  className?: string;
}

export function IconButton({
  title,
  children,
  size = 28,
  on = false,
  framed = false,
  className,
  type = 'button',
  ...rest
}: IconButtonProps): JSX.Element {
  const classes = ['icon-btn', `icon-btn--${size}`];
  if (on) classes.push('icon-btn--on');
  if (framed) classes.push('icon-btn--framed');
  if (className) classes.push(className);
  return (
    <button type={type} title={title} aria-label={title} aria-pressed={on || undefined} className={classes.join(' ')} {...rest}>
      {children}
    </button>
  );
}
