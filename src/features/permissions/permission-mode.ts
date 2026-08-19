// session-permission-mode — pure logic for the permission mode's presentation.
// PERMISSION_MODE_OPTIONS itself lives in the contract (FR-8: the single source
// of every mode presentation); this module only derives per-render presentation
// off it, so the component stays a thin renderer.
//
// rework-top-bar (design 11c): the session row's standalone mode badge and its
// popover are gone — the mode is now half of the run chip, whose one panel holds
// the model and the permission mode together, "in the chip's own order". What
// went with the badge went from here too: `permissionBadgeClass` styled a chip
// that no longer exists, and `permissionModeRunningNote`'s "applies to the next
// turn" line is now the panel's unconditional footer (`APPLIES_COPY`) rather
// than a note that only appeared mid-turn — the rule was always true, and
// stating it only while busy implied it was not.

import type { PermissionMode } from '../../../contract/common';
import { PERMISSION_MODE_OPTIONS, type PermissionModeOption } from '../../../contract/session-permission-mode';

/** FR-8: the option row for a mode. Every member of PermissionMode has one. */
export function permissionModeOption(mode: PermissionMode): PermissionModeOption {
  return PERMISSION_MODE_OPTIONS.find((o) => o.mode === mode) ?? PERMISSION_MODE_OPTIONS[0]!;
}


