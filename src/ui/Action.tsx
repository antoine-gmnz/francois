// The small hover-coloured text action — a bare word ("Remove", "cancel") or
// glyph that changes colour on hover, with no button chrome. Used where a
// control must stay quiet enough to sit inside a form section without competing
// with the real buttons: ProjectsModal's rule-row controls and both modals'
// confirm-in-place Remove.
//
// Promoted here from src/features/projects/ once ProfilesModal needed it too —
// a hover-colour span duplicated per feature is how two "identical" controls
// drift apart.

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
      className="action-glyph"
      style={{ fontSize: size, color: hover ? hoverColor : color }}
    >
      {children}
    </span>
  );
}
