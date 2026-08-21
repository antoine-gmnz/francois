// transcript-scale FR-12: the earlier-blocks row — the first child of the
// reading column, above the oldest rendered block. Flat treatment (design 9a,
// specs/design/transcript-scale.md): no accent, no stroke, no shadow — this is
// navigation, not the live thing.

import { earlierRowLabel } from './conversation-blocks';

export interface EarlierBlocksRowProps {
  /** null = indefinite (hasMore, exact remaining unknown — FR-12). */
  count: number | null;
  onActivate: () => void;
  /** split-session: an unfocused pane renders the row but does not activate it,
   *  matching the composer's own inert gate. */
  inert?: boolean;
}

export default function EarlierBlocksRow({ count, onActivate, inert = false }: EarlierBlocksRowProps) {
  const label = earlierRowLabel(count);
  return (
    <button type="button" className="conv-earlier-row" aria-label={label} disabled={inert} onClick={onActivate}>
      {label}
    </button>
  );
}
