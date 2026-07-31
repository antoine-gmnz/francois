// Small filled count badge, e.g. the DIFF tab's changed-file count (App.tsx
// :385-391) and the sidebar session card's diff-file badge (Sidebar.tsx
// :660-664). Distinct from the outline scope/kind tags in SkillsPanel and
// McpPanel (`badgeStyle`/`scopeBadge`) — those are bordered labels, not
// filled count pills, and are not covered by this component (see handoff).

import type { ReactNode } from 'react';

export interface BadgePillProps {
  children: ReactNode;
  className?: string;
  title?: string;
}

export function BadgePill({ children, className, title }: BadgePillProps): JSX.Element {
  return (
    <span className={className ? `badge-pill ${className}` : 'badge-pill'} title={title}>
      {children}
    </span>
  );
}
