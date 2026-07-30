// DirectoryField — NewSessionModal.tsx's former :345-364. Exists only for an
// unlinked session (no project selected) — with a project selected the root
// IS the working directory, so an editable path here would be a second
// source of truth for the same value.

import { Button } from '../../ui/Button';
import type { AppError } from '../../../contract/common';

export interface DirectoryFieldProps {
  cwd: string;
  onChange: (path: string) => void;
  onBrowse: () => void;
  picking: boolean;
  pickerError: AppError | null;
}

export function DirectoryField({ cwd, onChange, onBrowse, picking, pickerError }: DirectoryFieldProps): JSX.Element {
  return (
    <div>
      <label className="new-session-modal__label">DIRECTORY</label>
      <div className="new-session-modal__row">
        {/* Editable, not browse-only: on some setups the native picker can't
            reach a location (e.g. WSL's Linux section on older Windows
            builds) — typing/pasting the path must always work as a fallback. */}
        <input
          className="new-session-modal__field new-session-modal__field--flex"
          value={cwd}
          placeholder="type a path or browse…"
          onChange={(e) => onChange(e.target.value)}
        />
        <Button variant="ghost" onClick={onBrowse} disabled={picking}>
          {picking ? '…' : 'Browse…'}
        </Button>
      </div>
      {pickerError && (
        <div className="new-session-modal__hint new-session-modal__hint--error">{pickerError.message}</div>
      )}
    </div>
  );
}
