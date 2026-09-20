// session-settings-sheet — the three plain rows CreateSheet and EditSheet
// render identically (EditSheet wraps each in its own `field()` for the dirty
// highlight + "was" line; CreateSheet renders it bare). Split out of
// SessionSettingsSheet.tsx to keep that file's own size headroom for the
// pi-models-metrics/pi-migration-rollout Pi tracks it now also carries.

import type { PermissionMode, ResponseMode } from '../../../contract/common';
import { RESPONSE_MODE_OPTIONS } from '../../../contract/response-mode';
import { PERMISSION_MODE_OPTIONS } from '../../../contract/session-permission-mode';
import { Chip } from '../../ui/Chip';
import { ChipGroup } from '../../ui/ChipGroup';
import { PERMISSION_CHIP_OPTIONS, RESPONSE_CHIP_OPTIONS } from './session-settings';

export function PermissionsRow({ value, onChange }: { value: PermissionMode; onChange: (mode: PermissionMode) => void }) {
  return (
    <div>
      <label className="new-session-modal__label">PERMISSIONS</label>
      <div className="new-session-modal__chip-row new-session-modal__chip-row--wrap">
        <ChipGroup options={PERMISSION_CHIP_OPTIONS} value={value} onChange={onChange} />
      </div>
      <div className="new-session-modal__hint new-session-modal__hint--below-chips">
        {PERMISSION_MODE_OPTIONS.find((opt) => opt.mode === value)?.hint}
      </div>
    </div>
  );
}

export function ResponseRow({ value, onChange }: { value: ResponseMode; onChange: (mode: ResponseMode) => void }) {
  return (
    <div>
      <label className="new-session-modal__label">RESPONSE</label>
      <div className="new-session-modal__chip-row new-session-modal__chip-row--wrap">
        <ChipGroup options={RESPONSE_CHIP_OPTIONS} value={value} onChange={onChange} />
      </div>
      {/* FR-9: PERMISSIONS and RESPONSE alike get a consequence hint under the row. */}
      <div className="new-session-modal__hint new-session-modal__hint--below-chips">
        {RESPONSE_MODE_OPTIONS.find((opt) => opt.mode === value)?.hint}
      </div>
    </div>
  );
}

export function GitRow({ value, onChange }: { value: boolean; onChange: (allow: boolean) => void }) {
  return (
    <div>
      <label className="new-session-modal__label">GIT</label>
      <div className="new-session-modal__chip-row">
        <Chip selected={value} onClick={() => onChange(!value)}>
          {value ? '✓ ' : ''}allow git commands
        </Chip>
      </div>
      <div className="new-session-modal__hint new-session-modal__hint--below-chips">
        auto-approve git &amp; gh commands (commit, push, PRs) without a prompt — other tools still follow the permission setting above
      </div>
    </div>
  );
}
