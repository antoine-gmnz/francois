import { ChipGroup, type ChipOption } from '../../ui/ChipGroup';
import { STEERING_EXPLAINER, type DeliveryChoice } from './delivery-mode';
import './pi-turn-controls.css';

export interface DeliveryModeControlProps {
  value: DeliveryChoice;
  canSteer: boolean;
  canFollowUp: boolean;
  onChange: (choice: DeliveryChoice) => void;
}

/**
 * pi-turn-controls design brief: the busy-only "Steer now / Follow up" toggle
 * — "status explains delivery". Presentational only; ComposerPane owns the
 * selection state and clamps it to what the session's live capabilities
 * allow (delivery-mode.ts's resolveEffectiveChoice). Renders nothing when
 * neither mode is available — the caller falls back to its disabled-send
 * state instead.
 */
export default function DeliveryModeControl({ value, canSteer, canFollowUp, onChange }: DeliveryModeControlProps) {
  const options: ChipOption<DeliveryChoice>[] = [];
  if (canSteer) options.push({ value: 'steer', label: 'Steer now' });
  if (canFollowUp) options.push({ value: 'followUp', label: 'Follow up' });
  if (options.length === 0) return null;
  return (
    <div className="delivery-mode">
      <span className="delivery-mode__label">Pi is busy —</span>
      <ChipGroup options={options} value={value} onChange={onChange} />
      {value === 'steer' && <span className="delivery-mode__hint">{STEERING_EXPLAINER}</span>}
    </div>
  );
}
