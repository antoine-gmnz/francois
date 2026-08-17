// session-profiles FR-22 §8 — the profile chip. Shaped like CloudChip (same
// height/radius/StatusDot family): NEUTRAL everywhere except the focused
// session's own welcome header, where it is the one acid accent that view
// gets (design system v2's one-accent-per-view rule). It renders the
// SNAPSHOTTED name only — never resolved against the registry, so a deleted
// profile's chip still reads correctly (FR-22).

import { RotateCcw } from 'lucide-react';
import type { SessionProfileRef } from '../../../contract/common';
import { StatusDot } from '../../ui/StatusDot';
import { profileChipTitle } from './profiles';
import './profiles.css';

export interface ProfileChipProps {
  profile: SessionProfileRef;
  /** `sm` is the pane [1] row's denser variant. */
  size?: 'sm' | 'md';
  /** true ONLY in the focused session's own welcome header (FR-22). */
  accent?: boolean;
}

/** Same size-scoped tone the chip's own label text uses (profiles.css `.pf-chip*`). */
function chipDotColor(size: 'sm' | 'md', accent: boolean): string {
  if (accent) return 'var(--accent)';
  return size === 'sm' ? 'var(--text-faint)' : 'var(--text-dim)';
}

export function ProfileChip({ profile, size = 'md', accent = false }: ProfileChipProps): JSX.Element {
  const classNames = ['pf-chip'];
  if (size === 'sm') classNames.push('pf-chip--sm');
  if (accent) classNames.push('pf-chip--accent');
  return (
    <span className={classNames.join(' ')} title={profileChipTitle(profile)}>
      <StatusDot color={chipDotColor(size, accent)} size={size === 'sm' ? 5 : 6} />
      {profile.name}
      {/* FR-22: a quiet marker distinguishing REPLACE mode, without reading the prompt. */}
      {profile.replacesSystemPrompt && <RotateCcw className="pf-chip__mark" size={size === 'sm' ? 10 : 11} />}
    </span>
  );
}
