import { ModelCatalogStatus } from '../../ui/ModelCatalogStatus';
import type { ModelCatalogState } from '../../lib/hooks/useModelCatalog';
// ModelField — NewSessionModal.tsx's former :379-382.

import type { ModelInfo } from '../../../contract/common';
import ModelPicker from './ModelPicker';

export interface ModelFieldProps {
  catalogState: ModelCatalogState;
  models: ModelInfo[];
  modelId: string;
  loading: boolean;
  onChange: (modelId: string) => void;
  /** multi-provider-openai FR-21: the selected account's own label. */
  providerHeading: string;
}

export function ModelField({ catalogState, models, modelId, loading, onChange, providerHeading }: ModelFieldProps): JSX.Element {
  return (
    <div>
      <label className="new-session-modal__label">MODEL</label>
      <ModelCatalogStatus state={catalogState} />
      {modelId && !models.some(m => m.id === modelId) && <div className="new-session-modal__hint">{modelId} · Not in the current catalogue</div>}
      <ModelPicker
        models={models}
        modelId={modelId}
        loading={loading}
        onChange={onChange}
        providerHeading={providerHeading}
      />
    </div>
  );
}
