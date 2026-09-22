// Figma "Kbd" (125:7947): a keycap hint — `⌘K`, `⏎`. Mono, muted, on --bg-raised.

import './ui.css';

export function Kbd({ keys, className }: { keys: string; className?: string }): JSX.Element {
  return <kbd className={className ? `kbd ${className}` : 'kbd'}>{keys}</kbd>;
}
