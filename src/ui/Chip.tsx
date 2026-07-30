// A single selectable option pill. Used standalone for a one-off toggle
// (NewSessionModal's "allow git commands" chip, :445-458 — a lone chip, not
// a group) and as ChipGroup's per-option renderer.
//
// `danger` marks the option itself as the destructive/risky one (e.g.
// `bypassPermissions`) — in every call site it only changes appearance while
// also `selected` (an unselected danger chip looks like any other unselected
// chip), which the CSS combines via `.chip--selected.chip--danger`.

import type { ReactNode } from 'react';

export interface ChipProps {
  selected?: boolean;
  danger?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}

export function chipClassName(selected: boolean, danger: boolean, className?: string): string {
  const parts = ['chip'];
  if (selected) parts.push('chip--selected');
  if (danger) parts.push('chip--danger');
  if (className) parts.push(className);
  return parts.join(' ');
}

export function Chip({ selected = false, danger = false, onClick, children, className }: ChipProps): JSX.Element {
  return (
    <span className={chipClassName(selected, danger, className)} onClick={onClick}>
      {children}
    </span>
  );
}
