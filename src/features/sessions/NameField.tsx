// NameField — NewSessionModal.tsx's former :366-377.

import type { RefObject } from 'react';

export interface NameFieldProps {
  name: string;
  onChange: (name: string) => void;
  /** session-rename FR-9: the rename modal focuses + selects the input on open. */
  inputRef?: RefObject<HTMLInputElement>;
}

export function NameField({ name, onChange, inputRef }: NameFieldProps): JSX.Element {
  return (
    <div>
      <label className="new-session-modal__label">NAME</label>
      <input
        ref={inputRef}
        className="new-session-modal__field"
        value={name}
        placeholder="session name"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
