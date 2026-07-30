// ModelField — NewSessionModal.tsx's former :379-382.

import type { ModelInfo } from '../../../contract/common';
import ModelPicker from './ModelPicker';

export interface ModelFieldProps {
  models: ModelInfo[];
  modelId: string;
  loading: boolean;
  onChange: (modelId: string) => void;
}

export function ModelField({ models, modelId, loading, onChange }: ModelFieldProps): JSX.Element {
  return (
    <div>
      <label className="new-session-modal__label">MODEL</label>
      <ModelPicker models={models} modelId={modelId} loading={loading} onChange={onChange} />
    </div>
  );
}
