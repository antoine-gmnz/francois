import type { ModelCatalogState } from '../../lib/hooks/useModelCatalog';
import { ModelCatalogStatus } from '../../ui/ModelCatalogStatus';
// ModelField — NewSessionModal.tsx's former :379-382.

import type { ModelInfo } from '../../../contract/common';
import ModelPicker from './ModelPicker';
import type { ModelFamilyGroup } from './model-picker';

export interface ModelFieldProps {
  /** The legacy (session_models) status readout. Omit when `runtimeStatus` drives the row instead. */
  catalogState?: ModelCatalogState;
  models: ModelInfo[];
  modelId: string;
  loading: boolean;
  onChange: (modelId: string) => void;
  /** multi-provider-openai FR-21: the selected account's own label. */
  providerHeading: string;
  /** pi-models-metrics FR-1: passed straight through to ModelPicker (default: family). */
  groupBy?: (models: ModelInfo[]) => ModelFamilyGroup[];
  searchable?: boolean;
  isFavorite?: (model: ModelInfo) => boolean;
  onToggleFavorite?: (model: ModelInfo) => void;
  /** A6 (review addendum): passed straight through to ModelPicker. */
  recentRank?: (model: ModelInfo) => number | null;
}

export function ModelField({
  catalogState,
  models,
  modelId,
  loading,
  onChange,
  providerHeading,
  groupBy,
  searchable,
  isFavorite,
  onToggleFavorite,
  recentRank,
}: ModelFieldProps): JSX.Element {
  return (
    <div>
      <label className="new-session-modal__label">MODEL</label>
      { (
        catalogState && <ModelCatalogStatus state={catalogState} />
      )}
      {modelId && !models.some(m => m.id === modelId) && <div className="new-session-modal__hint">{modelId} · Not in the current catalogue</div>}
      <ModelPicker
        models={models}
        modelId={modelId}
        loading={loading}
        onChange={onChange}
        providerHeading={providerHeading}
        groupBy={groupBy}
        searchable={searchable}
        isFavorite={isFavorite}
        onToggleFavorite={onToggleFavorite}
        recentRank={recentRank}
      />
    </div>
  );
}
