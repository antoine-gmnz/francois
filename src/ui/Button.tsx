// Figma "Button" (125:7935): Kind = primary · secondary · ghost · attention ·
// danger, Size = md (30px) · sm (26px). Primary is the ONE strong action per view
// (ivory in dark, ink in light); Attention answers a blocked session; Danger is
// destructive. `shortcut` renders the optional mono hint after the label
// (e.g. '⌘⏎'). `is-disabled` is added alongside the native `disabled` attribute
// so a non-button element wanting the same look has a class to reach for.
// Styles live in src/styles.css (§Button) because modals across every feature
// already lean on `.btn`.

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useDelayedFlag } from '../lib/hooks/useDelayedFlag';
import { Caret, LOADER_DELAY_MS } from './Loaders';

export type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'attention' | 'danger';
/** The pre-redesign name for `ButtonKind`. */
export type ButtonVariant = ButtonKind;
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  /** Figma Kind. Defaults to 'secondary'. */
  variant?: ButtonKind;
  size?: ButtonSize;
  /** Mono hint after the label, at 55% opacity (Figma `showShortcut`). */
  shortcut?: string;
  className?: string;
  children?: ReactNode;
  /** Mid-action: a Caret loader (Figma 176:17303) sits before the label, which
   *  stays, and the button is disabled until the action settles. */
  busy?: boolean;
}

export function buttonClassName(kind: ButtonKind, size: ButtonSize, disabled: boolean | undefined, className?: string): string {
  const parts = ['btn', `btn--${kind}`];
  if (size === 'sm') parts.push('btn--sm');
  if (disabled) parts.push('is-disabled');
  if (className) parts.push(className);
  return parts.join(' ');
}

export function Button({
  variant = 'secondary',
  size = 'md',
  shortcut,
  className,
  disabled,
  type = 'button',
  children,
  busy = false,
  ...rest
}: ButtonProps): JSX.Element {
  // Same shape as the hand-gated sites (CodexForm's `<Caret>Save</Caret>`):
  // nothing for the first 300 ms, then the caret leads the kept label.
  const showCaret = useDelayedFlag(busy, LOADER_DELAY_MS);
  return (
    <button
      type={type}
      className={buttonClassName(variant, size, disabled || busy, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {showCaret ? <Caret>{children}</Caret> : children}
      {shortcut && <span className="btn__shortcut">{shortcut}</span>}
    </button>
  );
}
