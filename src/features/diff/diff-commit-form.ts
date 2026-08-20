// diff-review FR-35/FR-36: pure string/shape builders for the commit form's
// manifest column and stays-behind line. Nothing here crosses IPC (spec §5).

import type { DiffFileSummary } from '../../../contract/diff-view';

export const SUBJECT_LIMIT = 50;
const MANIFEST_LIMIT = 3;

export interface Manifest {
  shown: DiffFileSummary[];
  moreCount: number;
  moreAdd: number;
  moreDel: number;
}

/** FR-35: up to 3 checked files with status/counts, then `+ <m> more` with the
 *  aggregate additions/deletions of the rest. */
export function buildManifest(files: DiffFileSummary[], inCommit: ReadonlySet<string>, limit = MANIFEST_LIMIT): Manifest {
  const checked = files.filter((f) => inCommit.has(f.path));
  const shown = checked.slice(0, limit);
  const rest = checked.slice(limit);
  return {
    shown,
    moreCount: rest.length,
    moreAdd: rest.reduce((sum, f) => sum + f.additions, 0),
    moreDel: rest.reduce((sum, f) => sum + f.deletions, 0),
  };
}

/** FR-36: the explicit line naming the unchecked files, truncated past three.
 *  `''` when every file is checked (nothing stays behind — the caller hides the
 *  line); `'nothing selected'` when nothing is checked at all. */
export function staysBehindLine(files: DiffFileSummary[], inCommit: ReadonlySet<string>): string {
  if (inCommit.size === 0) return 'nothing selected';
  const unchecked = files.filter((f) => !inCommit.has(f.path));
  if (unchecked.length === 0) return '';
  const names = unchecked.map((f) => f.name);
  if (names.length === 1) return `${names[0]} stays in the working tree`;
  if (names.length === 2) return `${names[0]} and ${names[1]} stay in the working tree`;
  const more = names.length - 2;
  return `${names[0]}, ${names[1]} and ${more} more stay in the working tree`;
}

/** FR-35: the subject meter reads `<len>/50`, going `--warn` (not blocking) past it. */
export function subjectMeterState(subject: string): { len: number; warn: boolean } {
  return { len: subject.length, warn: subject.length > SUBJECT_LIMIT };
}
