// Settings / Accounts — the 28px monogram tile that stands in for a provider in
// the rail (Figma "Mark", 140:7685): `AN`/`OA`/`GO`/… from the catalog, on the
// neutral --bg-strong fill. Identity only — status is the rail row's own glyph.

import type { ProviderSpec } from './providers';
import './accounts-page.css';

export function ProviderTile({ spec }: { spec: ProviderSpec }): JSX.Element {
  return (
    <span className="acc-tile" aria-hidden="true">
      {spec.monogram}
    </span>
  );
}
