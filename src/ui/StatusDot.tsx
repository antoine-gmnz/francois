// Small colored status circle, optionally pulsing. Replaces the repeated
// 6/7/8px `<span style={{ width, height, borderRadius:'50%', background }}>`
// markup in App.tsx (shell-alive dot, agent tab dot), Sidebar.tsx (session
// card dot), McpPanel.tsx (row + detail-popover dots), AgentsPanel.tsx (card
// dot), and OverviewView.tsx (session row dot).
//
// Color is genuinely status-driven (one of several unrelated palettes per
// feature) and size varies 6–8px per call site, so both stay inline —
// per the CSS contract, dynamic values may be inline; only the static shape
// (circle, flex-shrink) and the pulsing keyframes come from the class.

export interface StatusDotProps {
  /** CSS color value for the dot's fill, e.g. `var(--success)`. */
  color: string;
  /** Diameter in pixels. Defaults to 8, the most common call-site size. */
  size?: number;
  /** Adds the pulsing-animation modifier (running / connecting states). */
  pulsing?: boolean;
  className?: string;
}

export function statusDotClassName(pulsing: boolean, className?: string): string {
  const parts = ['status-dot'];
  if (pulsing) parts.push('status-dot--pulsing');
  if (className) parts.push(className);
  return parts.join(' ');
}

export function StatusDot({ color, size = 8, pulsing = false, className }: StatusDotProps): JSX.Element {
  return (
    <span className={statusDotClassName(pulsing, className)} style={{ width: size, height: size, background: color }} />
  );
}
