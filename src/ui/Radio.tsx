// Figma "Radio" (New task 139:6923 / Run settings 139:7379): a 16px ring, 1.5px
// line/strong when off; when on the ring and an 8px dot take the text colour, so
// a tinted row (bypass) can recolour it from its own CSS. Presentational only —
// the row that carries it owns the role/aria-checked and the click.

import './radio.css';

export function Radio({ on, className }: { on: boolean; className?: string }): JSX.Element {
  const base = on ? 'radio radio--on' : 'radio';
  return <span aria-hidden className={className ? `${base} ${className}` : base} />;
}
