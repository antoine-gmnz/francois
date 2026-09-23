// New task dialog — the pure half. Redesign "Graphite & Signal", Figma
// "19 · New task" (139:6889; light 142:15513). The dialog is the old create
// sheet regrouped around the task: what the agent should do, where (project +
// model, then "Where it works" — the current checkout or a dedicated worktree),
// and everything else folded under "Advanced", which recaps every value it
// holds so it rarely needs opening. The session name sits outside the fold —
// it is the one setting nearly every task touches. NewTaskDialog.tsx renders it.

import type { ClaudeRuntime, PermissionMode, ResponseMode } from '../../../contract/common';
import { permissionRows } from './run-settings';
import type { WorktreeMode } from './worktree';

/** One entry of the folded Advanced recap: `Account  Work`. */
export interface RecapItem {
  key: string;
  label: string;
  value: string;
  /** Off its default — rendered brighter so a changed setting reads at a glance. */
  changed: boolean;
}

/**
 * The folded Advanced recap — every setting under the fold with its current
 * value, so the section only needs opening to change one. Runtime shows only
 * where there is a choice (Windows), base ref only while a worktree is created.
 */
export function advancedRecap(parts: {
  accountLabel: string | null;
  accountIsDefault: boolean;
  profileName: string | null;
  effort: string;
  defaultEffort: string | null;
  showEffort: boolean;
  runtime: ClaudeRuntime | null;
  permissionMode: PermissionMode;
  responseMode: ResponseMode;
  allowGit: boolean;
  baseRef: string | null;
}): RecapItem[] {
  const items: RecapItem[] = [];
  if (parts.accountLabel) items.push({ key: 'account', label: 'Account', value: parts.accountLabel, changed: !parts.accountIsDefault });
  items.push({ key: 'profile', label: 'Profile', value: parts.profileName ?? 'none', changed: parts.profileName !== null });
  if (parts.showEffort) {
    const value = parts.effort || (parts.defaultEffort ? `default · ${parts.defaultEffort}` : 'default');
    items.push({ key: 'effort', label: 'Effort', value, changed: parts.effort !== '' });
  }
  if (parts.runtime) items.push({ key: 'runtime', label: 'Runtime', value: parts.runtime, changed: parts.runtime !== 'native' });
  const permission = permissionRows().find((r) => r.mode === parts.permissionMode);
  items.push({
    key: 'permissions',
    label: 'Permissions',
    value: (permission?.label ?? parts.permissionMode).toLowerCase(),
    changed: parts.permissionMode !== 'default',
  });
  items.push({ key: 'response', label: 'Response', value: parts.responseMode, changed: parts.responseMode !== 'default' });
  items.push({ key: 'git', label: 'Git', value: parts.allowGit ? 'auto-approve' : 'ask', changed: parts.allowGit });
  if (parts.baseRef !== null) items.push({ key: 'base', label: 'Base', value: parts.baseRef, changed: false });
  return items;
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
