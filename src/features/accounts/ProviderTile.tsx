// Redesign turn 8b — the small tinted tile that stands in for a provider
// wherever the rail or the detail header needs one: `AN`/`OA`/`GO`/… drawn
// from the catalog's monogram, hued with the same `--acc-hue` custom-property
// trick `AccountRow.tsx` already uses for an account's avatar (accounts.css
// derives fill/edge/glyph from the one runtime value).
//
// A DASHED tile (`acc-tile--dashed`) is the mock's way of marking a provider
// this app cannot drive a CLI login for — `spec.cliLogin === null` — so the
// rail reads "key-only" from the tile alone, before the meta line loads.

import type { CSSProperties } from 'react';
import type { ProviderSpec } from './providers';
import './accounts.css';

export interface ProviderTileProps {
  spec: ProviderSpec;
  size?: 'sm' | 'lg';
}

export function ProviderTile({ spec, size = 'sm' }: ProviderTileProps): JSX.Element {
  const classNames = ['acc-tile'];
  if (size === 'lg') classNames.push('acc-tile--lg');
  if (spec.cliLogin === null) classNames.push('acc-tile--dashed');

  return (
    <span className={classNames.join(' ')} style={{ '--acc-hue': spec.hue } as CSSProperties}>
      {spec.monogram}
    </span>
  );
}
