// projects — the small hover-colored action glyph shared by StandardsSection's
// rule-row controls and RemoveControl. Split out of ProjectsModal per
// REFACTOR.md §6c.

import { useState } from 'react';

export function Action({
  children,
  color,
  hoverColor,
  onClick,
  title,
  size = 10.5,
}: {
  children: React.ReactNode;
  color: string;
  hoverColor: string;
  onClick: () => void;
  title?: string;
  size?: number;
}) {
  const [hover, setHover] = useState(false);
  return (
    <span
      role="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="pj-action-glyph"
      style={{ fontSize: size, color: hover ? hoverColor : color }}
    >
      {children}
    </span>
  );
}
