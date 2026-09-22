// Figma "Tag" (125:7945): a quiet mono label on --bg-raised — a project name on a
// roster row, `subagent` / `workflow` on an activity item. `tone="new"` is the
// ivory NEW badge.

import type { ReactNode } from 'react';
import './ui.css';

export interface TagProps {
  children: ReactNode;
  tone?: 'default' | 'new';
  title?: string;
  className?: string;
}

export function Tag({ children, tone = 'default', title, className }: TagProps): JSX.Element {
  const base = tone === 'new' ? 'tag tag--new' : 'tag';
  return (
    <span className={className ? `${base} ${className}` : base} title={title}>
      {children}
    </span>
  );
}
