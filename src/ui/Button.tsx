// Replaces the style-factory anti-pattern at NewSessionModal.tsx:546-573
// (`btn`/`createBtn`, two CSSProperties-returning functions for what is
// really just two variants — Cancel/Browse… are the same "ghost" style
// regardless of the unused `_active` argument, and Create session is the one
// "primary" style with a disabled look). Variants map to .btn--primary /
// .btn--ghost; `is-disabled` is added alongside the native `disabled`
// attribute so a non-native-button element wanting the same look has a class
// to reach for too.
//
// (SkillsPanel.tsx:19-31's `badgeStyle` is cited alongside btn/createBtn in
// the spec as the same anti-pattern, but it renders non-interactive scope/kind
// tags, not a button — it is not covered by this component; see handoff.)

import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'ghost';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  className?: string;
}

export function buttonClassName(variant: ButtonVariant, disabled: boolean | undefined, className?: string): string {
  const parts = ['btn', variant === 'primary' ? 'btn--primary' : 'btn--ghost'];
  if (disabled) parts.push('is-disabled');
  if (className) parts.push(className);
  return parts.join(' ');
}

export function Button({ variant = 'ghost', className, disabled, ...rest }: ButtonProps): JSX.Element {
  return <button className={buttonClassName(variant, disabled, className)} disabled={disabled} {...rest} />;
}
