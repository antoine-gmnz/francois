// session-permission-mode §9 — badge + popover pure logic (FR-8, FR-9, FR-11).

import { describe, expect, it } from 'vitest';
import type { PermissionMode, SessionStatus } from '../../../contract/common';
import { PERMISSION_MODE_OPTIONS } from '../../../contract/session-permission-mode';
import { permissionBadgeClass, permissionModeOption, permissionModeRunningNote } from './permission-mode';

describe('permissionModeOption (FR-8)', () => {
  it('resolves every PermissionMode member to its contract option row', () => {
    const modes: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
    for (const mode of modes) {
      expect(permissionModeOption(mode)).toBe(PERMISSION_MODE_OPTIONS.find((o) => o.mode === mode));
    }
  });
});

describe('permissionBadgeClass (FR-9)', () => {
  it('renders the plain badge class for every non-danger mode', () => {
    expect(permissionBadgeClass('default')).toBe('session-row__mode');
    expect(permissionBadgeClass('plan')).toBe('session-row__mode');
    expect(permissionBadgeClass('acceptEdits')).toBe('session-row__mode');
  });

  it('carries the danger modifier only for bypassPermissions', () => {
    expect(permissionBadgeClass('bypassPermissions')).toBe('session-row__mode session-row__mode--danger');
  });
});

describe('permissionModeRunningNote (FR-11)', () => {
  it('shows the next-turn note for every busy status', () => {
    const busy: SessionStatus[] = ['running', 'starting', 'awaiting_approval', 'awaiting_input'];
    for (const status of busy) {
      expect(permissionModeRunningNote(status)).toBe('turn running — applies to the next turn');
    }
  });

  it('is null for terminal/idle statuses', () => {
    expect(permissionModeRunningNote('idle')).toBeNull();
    expect(permissionModeRunningNote('done')).toBeNull();
    expect(permissionModeRunningNote('error')).toBeNull();
  });
});
