// Run settings popover — the pure half. Redesign "Graphite & Signal", Figma
// "20 · Run settings (model · effort · permissions)" (139:7373, light 142:16053).
// The run chip opens it: the model list with effort inside the selected model's
// row, then the four permission modes as radio rows, `bypass` tinted with a line
// saying how long it has been on and where. RunSettingsPopover.tsx renders this.

import type { ModelInfo, PermissionMode, SessionMeta } from '../../../contract/common';
import { PERMISSION_MODE_OPTIONS } from '../../../contract/session-permission-mode';

export interface PermissionRow {
  mode: PermissionMode;
  label: string;
  /** What the mode means in practice — the design's one-line gloss. */
  note: string;
  danger: boolean;
}

const PERMISSION_COPY: Record<PermissionMode, { label: string; note: string }> = {
  default: { label: 'Default', note: 'ask for risky tools' },
  plan: { label: 'Plan', note: 'read-only, proposes a plan' },
  acceptEdits: { label: 'Accept edits', note: 'edits run, shell asks' },
  bypassPermissions: { label: 'Bypass', note: 'nothing asks' },
};

/** The four modes in the contract's order, with the design's labels. */
export function permissionRows(): PermissionRow[] {
  return PERMISSION_MODE_OPTIONS.map((o) => ({
    mode: o.mode,
    label: PERMISSION_COPY[o.mode]?.label ?? o.label,
    note: PERMISSION_COPY[o.mode]?.note ?? o.hint,
    danger: o.danger === true,
  }));
}

/**
 * The faint note after a model's name: `project default` when it is the model
 * the session's project defaults to, otherwise the catalogue's own brief (the
 * design's `faster, cheaper`), otherwise nothing.
 */
export function modelNote(model: ModelInfo, projectDefaultModelId: string | undefined): string {
  if (projectDefaultModelId !== undefined && model.id === projectDefaultModelId) return 'project default';
  return model.brief ?? '';
}

/** `under a minute` · `14 min` · `2 h 5 min` · `3 d` — how long a mode has been on. */
export function formatSince(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  }
  return `${Math.floor(hours / 24)} d`;
}

/** The tree bypass is live in — the worktree's branch, else the checkout's folder name. */
function whereItRuns(session: SessionMeta): string {
  if (session.worktree?.branch) return session.worktree.branch;
  const parts = session.cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? session.cwd;
}

/**
 * The second line of the bypass row, only while bypass is in force:
 * `On for 14 min in feat/auth-retry · every tool runs without asking`.
 * Null for any other mode, or when the core never stamped the switch.
 */
export function bypassSinceLine(session: SessionMeta, now: number): string | null {
  if (session.permissionMode !== 'bypassPermissions' || !session.permissionModeSince) return null;
  return `On for ${formatSince(now - session.permissionModeSince)} in ${whereItRuns(session)} · every tool runs without asking`;
}

/**
 * Whether switching to `next` keeps the effort in force. A model that does not
 * advertise the current level (or none at all) would leave a level the next turn
 * cannot honour, so the caller clears it after the switch.
 */
export function effortSurvivesSwitch(effort: string | undefined, next: ModelInfo | undefined): boolean {
  if (!effort) return true;
  return (next?.efforts ?? []).includes(effort);
}

/**
 * Where the popover sits: right-aligned to the chip and opening upwards (the chip
 * lives in the composer at the bottom of the pane), below it only when there is
 * no room above, clamped inside the window.
 */
export function runSettingsPlacement(
  chip: { top: number; right: number; bottom: number },
  viewport: { width: number; height: number },
  size: { width: number; height: number },
  gap = 8,
): { right: number; top: number } {
  const right = Math.max(8, viewport.width - chip.right);
  const above = chip.top - gap - size.height;
  const top = above >= 8 ? above : Math.min(chip.bottom + gap, Math.max(8, viewport.height - size.height - 8));
  return { right, top };
}
