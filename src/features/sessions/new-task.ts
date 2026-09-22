// New task dialog — the pure half. Redesign "Graphite & Signal", Figma
// "19 · New task" (139:6889; light 142:15513). The dialog is the old create
// sheet regrouped around the task: what the agent should do, where (project +
// model, then "Where it works" — the current checkout or a dedicated worktree),
// and everything else folded under one "Advanced" line that states its current
// values so it rarely needs opening. NewTaskDialog.tsx renders it.

import type { PermissionMode } from '../../../contract/common';
import { permissionRows } from './run-settings';
import type { WorktreeMode } from './worktree';

/**
 * The folded Advanced line: `Advanced · Work account · api-default profile ·
 * accept edits`. Parts that are at their default and say nothing are left out —
 * no profile, the default permission mode.
 */
export function advancedSummary(parts: { accountLabel: string | null; profileName: string | null; permissionMode: PermissionMode }): string {
  const bits = ['Advanced'];
  if (parts.accountLabel) bits.push(parts.accountLabel);
  if (parts.profileName) bits.push(`${parts.profileName} profile`);
  if (parts.permissionMode !== 'default') {
    const row = permissionRows().find((r) => r.mode === parts.permissionMode);
    bits.push((row?.label ?? parts.permissionMode).toLowerCase());
  }
  return bits.join(' · ');
}

/**
 * The two "Where it works" cards map onto the worktree group's modes: the
 * current checkout is `off`, a dedicated worktree is `create`. `attach` (an
 * existing worktree) is not a card — it is the link under them — so neither
 * card reads as chosen while it is in force.
 */
export function whereCard(mode: WorktreeMode): 'checkout' | 'worktree' | null {
  if (mode === 'off') return 'checkout';
  if (mode === 'create') return 'worktree';
  return null;
}

/** ⌘⏎ / Ctrl+⏎ inside the prompt starts the task (a bare ⏎ is a newline there). */
export function isStartChord(e: { key: string; metaKey: boolean; ctrlKey: boolean; isComposing?: boolean }): boolean {
  return e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing;
}

/** The trimmed first message, or null when the task starts idle. */
export function firstPrompt(text: string): string | null {
  const t = text.trim();
  return t === '' ? null : t;
}
