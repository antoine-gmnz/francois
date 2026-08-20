// Shared status-letter -> glyph/tone table (design brief "Tree": status letters
// toned by kind), used by the rail, the body header and the commit manifest — a
// third caller is why this earns its own module instead of a third inline copy.

import type { DiffFileStatus } from '../../../contract/diff-view';

export const DIFF_STATUS: Record<DiffFileStatus, { ch: string; color: string }> = {
  modified: { ch: 'M', color: 'var(--text-hint)' },
  added: { ch: 'A', color: 'var(--success)' },
  deleted: { ch: 'D', color: 'var(--error)' },
  untracked: { ch: 'U', color: 'var(--hue-blue)' },
  renamed: { ch: 'R', color: 'var(--hue-purple)' },
};
