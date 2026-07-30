// projects — ProjectsModal's IDENTITY group: name/root fields, editable even
// when the project's root is missing (FR-38). Split out of ProjectsModal's
// `{selected && (...)}` block per REFACTOR.md §6c.

import { InlineError } from './InlineError';
import { ROOT_MISSING_LINE } from './projects';

export function IdentitySection({
  nameDraft,
  onNameChange,
  onNameCommit,
  rootDraft,
  onRootChange,
  onRootCommit,
  error,
  rootMissing,
}: {
  nameDraft: string;
  onNameChange: (value: string) => void;
  onNameCommit: () => void;
  rootDraft: string;
  onRootChange: (value: string) => void;
  onRootCommit: () => void;
  error: string | null;
  rootMissing: boolean;
}) {
  return (
    <div className="pj-group">
      <span className="pj-group-label">IDENTITY</span>
      <div className="pj-row">
        <span className="pj-row-label">name</span>
        <input
          className="pj-input"
          value={nameDraft}
          onChange={(e) => onNameChange(e.target.value)}
          onBlur={onNameCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <div className="pj-row">
        <span className="pj-row-label">root</span>
        <input
          className="pj-input"
          value={rootDraft}
          onChange={(e) => onRootChange(e.target.value)}
          onBlur={onRootCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      {error !== null && <InlineError indent>{error}</InlineError>}
      {rootMissing && <InlineError indent>{ROOT_MISSING_LINE}</InlineError>}
    </div>
  );
}
