// session-permission-mode — what survives of the mode's pure presentation after
// rework-top-bar (design 11c) folded the standalone badge into the run chip.
// `permissionBadgeClass` and `permissionModeRunningNote` went with the badge and
// the note they rendered; see permission-mode.ts's header for why.

import { describe, expect, it } from 'vitest';
import type { PermissionMode } from '../../../contract/common';
import { PERMISSION_MODE_OPTIONS } from '../../../contract/session-permission-mode';
import { permissionModeOption } from './permission-mode';

describe('permissionModeOption (FR-8)', () => {
  it('resolves every PermissionMode to its contract row', () => {
    const modes: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
    for (const mode of modes) {
      expect(permissionModeOption(mode)).toBe(PERMISSION_MODE_OPTIONS.find((o) => o.mode === mode));
    }
  });

  it('falls back to the first option for a value outside the union', () => {
    // A core that grew a mode this frontend has not been taught renders as
    // `default` rather than blank — the chip must never lose its label.
    expect(permissionModeOption('dontAsk' as PermissionMode)).toBe(PERMISSION_MODE_OPTIONS[0]);
  });

  it('marks bypass, and only bypass, as dangerous', () => {
    expect(permissionModeOption('bypassPermissions').danger).toBe(true);
    expect(permissionModeOption('default').danger).toBeUndefined();
    expect(permissionModeOption('plan').danger).toBeUndefined();
    expect(permissionModeOption('acceptEdits').danger).toBeUndefined();
  });
});
