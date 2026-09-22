// A changed file's status letter + tone, and its compact line stat — shared by
// the DIFF tab's tree and the session panel's Changes tree (redesign "Graphite &
// Signal": M in --state-info, A/U in --state-success, D in --state-danger).
// Tones are token suffixes (`--state-<tone>`), never colours.

import type { DiffFileStatus } from '../../../contract/diff-view';

export type FileStatusTone = 'info' | 'success' | 'danger';

export const FILE_STATUS: Record<DiffFileStatus, { ch: string; tone: FileStatusTone }> = {
  modified: { ch: 'M', tone: 'info' },
  added: { ch: 'A', tone: 'success' },
  untracked: { ch: 'U', tone: 'success' },
  deleted: { ch: 'D', tone: 'danger' },
  renamed: { ch: 'R', tone: 'info' },
};

/** `+34 −19`, dropping a zero side; '' when neither side moved. */
export function diffStat(additions: number, deletions: number): string {
  const parts: string[] = [];
  if (additions > 0) parts.push(`+${additions}`);
  if (deletions > 0) parts.push(`−${deletions}`);
  return parts.join(' ');
}
