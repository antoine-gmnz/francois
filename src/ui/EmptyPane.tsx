// Centered placeholder message, filling its container. Replaces the four
// near-verbatim "select a session…" placeholders in App.tsx's main pane
// (:440-452, :457-460, :469-472, :513-515) and Sidebar's `Centered` helper
// (:544-562, used for "no sessions yet", the project-scoped empty state, and
// "no matches"). Both shapes are a single flex column, centered, filling
// height:100% of their (already flex:1 or otherwise sized) parent — a
// multi-line placeholder (Sidebar's secondary hint line) just stacks as a
// second child.

import type { ReactNode } from 'react';

export interface EmptyPaneProps {
  children: ReactNode;
  className?: string;
}

export function EmptyPane({ children, className }: EmptyPaneProps): JSX.Element {
  return <div className={className ? `empty-pane ${className}` : 'empty-pane'}>{children}</div>;
}
