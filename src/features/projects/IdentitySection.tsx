// projects — ProjectsModal's IDENTITY group: name/root fields, editable even
// when the project's root is missing (FR-38). Split out of ProjectsModal's
// `{selected && (...)}` block per REFACTOR.md §6c.

import type { ProjectGroup } from '../../../contract/projects';
import { InlineError } from './InlineError';
import { NO_GROUP_LABEL, ROOT_MISSING_LINE } from './projects';

export function IdentitySection({
  nameDraft,
  onNameChange,
  onNameCommit,
  rootDraft,
  onRootChange,
  onRootCommit,
  error,
  rootMissing,
  groups,
  groupId,
  onGroupChange,
}: {
  nameDraft: string;
  onNameChange: (value: string) => void;
  onNameCommit: () => void;
  rootDraft: string;
  onRootChange: (value: string) => void;
  onRootCommit: () => void;
  error: string | null;
  rootMissing: boolean;
  /** project-groups FR-21: every group, listed under "— none —". */
  groups: ProjectGroup[];
  /** '' = ungrouped. */
  groupId: string;
  /** commits immediately — no Save button, like every other Identity field. */
  onGroupChange: (groupId: string | null) => void;
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
      {/* project-groups FR-21: stays enabled while the root is missing, like
          the rest of Identity (projects FR-38). */}
      <div className="pj-row">
        <span className="pj-row-label">group</span>
        <select
          className={`pj-input${groupId === '' ? ' pj-input--unset' : ''}`}
          value={groupId}
          onChange={(e) => onGroupChange(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">{NO_GROUP_LABEL}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
      {error !== null && <InlineError indent>{error}</InlineError>}
      {rootMissing && <InlineError indent>{ROOT_MISSING_LINE}</InlineError>}
    </div>
  );
}
