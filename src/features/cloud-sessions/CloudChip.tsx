// cloud-sessions FR-16 §8 — the `cloud` provenance chip, on the pane [1] row
// and in the SESSION header meta row.
//
// Shaped exactly like the `rc` chip (same height, radius and StatusDot family)
// but NEUTRAL, never accent: provenance is a fact about where this session came
// from, not a live state. The face carries no id and no timestamp — both live in
// the tooltip, which leads with the one-way rule verbatim. That sentence is
// load-bearing (spec §7 #8): if the UI implies the phone still sees this
// session, users lose work believing it does.

import type { CloudProvenance } from '../../../contract/common';
import { StatusDot } from '../../ui/StatusDot';
import { cloudChipTitle } from './cloud-sessions';
import './cloud-sessions.css';

export interface CloudChipProps {
  cloud: CloudProvenance;
  /** `sm` is the pane [1] row's denser variant. */
  size?: 'sm' | 'md';
}

export function CloudChip({ cloud, size = 'md' }: CloudChipProps): JSX.Element {
  return (
    <span className={size === 'sm' ? 'cloud-chip cloud-chip--sm' : 'cloud-chip'} title={cloudChipTitle(cloud)}>
      <StatusDot color="var(--text-muted)" size={size === 'sm' ? 5 : 6} />
      cloud
    </span>
  );
}
