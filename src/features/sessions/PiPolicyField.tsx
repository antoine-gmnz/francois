// pi-skills-capabilities FR-5/FR-7 — the New Session form's Pi policy field:
// the one sentence every Pi surface shows, the project-resources choice, and
// the per-session acknowledgment. Rendered only for a Pi account (mounted by
// SessionSettingsSheet's CreateSheet) in place of the plan/accept-edits/bypass
// permission controls, which have nothing to select for this runtime.

import { ChipGroup, type ChipOption } from '../../ui/ChipGroup';
import { Chip } from '../../ui/Chip';
import { PI_UNRESTRICTED_TOOLS_NOTICE } from './pi-resource-policy';

const PROJECT_RESOURCES_OPTIONS: ChipOption<'ignore' | 'allow'>[] = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'allow', label: 'Allow' },
];

export interface PiPolicyFieldProps {
  projectResources: 'ignore' | 'allow';
  acknowledged: boolean;
  onProjectResourcesChange: (value: 'ignore' | 'allow') => void;
  onAcknowledgedChange: (value: boolean) => void;
}

export function PiPolicyField({
  projectResources,
  acknowledged,
  onProjectResourcesChange,
  onAcknowledgedChange,
}: PiPolicyFieldProps): JSX.Element {
  return (
    <div className="pi-policy-field">
      <div className="pi-policy-field__notice">{PI_UNRESTRICTED_TOOLS_NOTICE}</div>

      <label className="new-session-modal__label">PROJECT RESOURCES</label>
      <div className="new-session-modal__chip-row">
        <ChipGroup options={PROJECT_RESOURCES_OPTIONS} value={projectResources} onChange={onProjectResourcesChange} />
      </div>
      {/* FR-7: what "Allow" actually does — and, just as importantly, what it does not. */}
      <div className="new-session-modal__hint new-session-modal__hint--below-chips">
        {projectResources === 'allow'
          ? "this project's instructions, skills and settings may affect Pi's behaviour — this does not enable executable extensions"
          : "this project's instructions, skills and settings are ignored"}
      </div>

      <Chip selected={acknowledged} onClick={() => onAcknowledgedChange(!acknowledged)}>
        {acknowledged ? '✓ ' : ''}I understand — no per-tool approval
      </Chip>
    </div>
  );
}
