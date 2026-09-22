// projects — the project settings' General tab form (Figma "Form", 140:7894):
// name + group on one row, the root directory under them. Editable even when the
// project's root is missing (FR-38). Every field commits on blur — there is no
// Save button (FR-35), which the page's footer line says out loud.

import type { ProjectGroup } from '../../../contract/projects';
import { SettingsField, SettingsSelect } from '../../ui/Settings';
import { InlineError } from './InlineError';
import { NO_GROUP_LABEL, ROOT_MISSING_LINE } from './projects';

const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter') e.currentTarget.blur();
};

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
    <>
      <div className="pj-form-row">
        <SettingsField label="Project name">
          <input
            className="settings-input"
            value={nameDraft}
            onChange={(e) => onNameChange(e.target.value)}
            onBlur={onNameCommit}
            onKeyDown={blurOnEnter}
          />
        </SettingsField>
        {/* project-groups FR-21: stays enabled while the root is missing, like
            the rest of Identity (projects FR-38). */}
        <SettingsField label="Group">
          <SettingsSelect
            className={groupId === '' ? 'settings-input--unset' : undefined}
            value={groupId}
            onChange={(e) => onGroupChange(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">{NO_GROUP_LABEL}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </SettingsSelect>
        </SettingsField>
      </div>
      <SettingsField label="Root directory" hint="Sessions start here unless you choose a worktree.">
        <input
          className="settings-input settings-input--mono"
          value={rootDraft}
          spellCheck={false}
          onChange={(e) => onRootChange(e.target.value)}
          onBlur={onRootCommit}
          onKeyDown={blurOnEnter}
        />
      </SettingsField>
      {error !== null && <InlineError>{error}</InlineError>}
      {rootMissing && <InlineError>{ROOT_MISSING_LINE}</InlineError>}
    </>
  );
}
