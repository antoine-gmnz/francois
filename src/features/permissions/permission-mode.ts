// session-permission-mode — pure logic for the session-row mode badge + its
// popover (FR-8..FR-14). PERMISSION_MODE_OPTIONS itself lives in the contract
// (FR-8: the single source of every mode presentation); this module only
// derives per-render presentation off it plus the session's own state, so the
// component stays a thin renderer.

import type { PermissionMode, SessionStatus } from '../../../contract/common';
import { isBusyStatus } from '../../../contract/fleet-board';
import { PERMISSION_MODE_OPTIONS, type PermissionModeOption } from '../../../contract/session-permission-mode';

/** FR-8: the option row for a mode. Every member of PermissionMode has one. */
export function permissionModeOption(mode: PermissionMode): PermissionModeOption {
  return PERMISSION_MODE_OPTIONS.find((o) => o.mode === mode) ?? PERMISSION_MODE_OPTIONS[0]!;
}

/**
 * FR-9: the badge's class list. Renders in every mode (including `default`,
 * where today's static span was hidden) and carries the danger tone in
 * `bypassPermissions` — reuses `session-row__mode`'s existing geometry.
 */
export function permissionBadgeClass(mode: PermissionMode): string {
  return permissionModeOption(mode).danger ? 'session-row__mode session-row__mode--danger' : 'session-row__mode';
}

/**
 * FR-11: the line the popover shows under the option list while the focused
 * session is busy — options stay enabled, this is annotation only. Null when
 * the session isn't busy, so the popover renders no line at all.
 */
export function permissionModeRunningNote(status: SessionStatus): string | null {
  return isBusyStatus(status) ? 'turn running — applies to the next turn' : null;
}
