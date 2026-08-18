// Selectable / hoverable row: the recurring
// `selected ? raised : hovered ? elevated : transparent` background ternary
// duplicated in PaletteView's Row, ProjectSwitcher's Row, SkillsPanel's Row,
// and OverviewView's SessionRow. Each of those degenerates into a subset of
// the same two booleans — PaletteView never tracks a separate `hovered`
// (hovering IS selecting there), ProjectSwitcher never marks `selected` — so
// ListRow exposes both independently and callers pass only what they use.
//
// AgentsPanel's agent Card (:369) is deliberately NOT modeled by ListRow: its
// resting background is `--bg-panel` (not transparent), and selection is
// shown with a left accent border instead of a raised fill — a different
// visual contract, not a degenerate case of this one. See the handoff.

import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className'> {
  selected?: boolean;
  hovered?: boolean;
  className?: string;
  children: ReactNode;
}

export function listRowClassName(selected: boolean, hovered: boolean, className?: string): string {
  const parts = ['list-row'];
  if (selected) parts.push('list-row--selected');
  else if (hovered) parts.push('list-row--hovered');
  if (className) parts.push(className);
  return parts.join(' ');
}

export const ListRow = forwardRef<HTMLDivElement, ListRowProps>(function ListRow({ selected = false, hovered = false, className, children, ...rest }, ref) {
  return (
    <div ref={ref} className={listRowClassName(selected, hovered, className)} {...rest}>
      {children}
    </div>
  );
});
