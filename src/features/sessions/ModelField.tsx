import { ModelCatalogStatus } from '../../ui/ModelCatalogStatus';
import type { ModelCatalogState } from '../../lib/hooks/useModelCatalog';
// ModelField — NewSessionModal.tsx's former :379-382.

import type { ModelInfo } from '../../../contract/common';
import ModelPicker from './ModelPicker';
import type { ModelFamilyGroup } from './model-picker';
import { NO_MODELS_MESSAGE } from './runtime-metrics';

/**
 * pi-models-metrics FR-1/FR-2/FR-9: the Pi-specific status row — an
 * account-scoped catalogue with no advertised-provider registry to fall back
 * to, so "no models" and "couldn't load" and "stale" are three DIFFERENT
 * honest states rather than one generic message.
 */
export interface RuntimeModelFieldStatus {
  stale: boolean;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  /** Absent ⇒ no "Open setup" affordance (the caller has nowhere to send it). */
  onOpenSetup?: () => void;
}

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
  /** pi-models-metrics: renders the Pi status row instead of the legacy ModelCatalogStatus. */
  runtimeStatus?: RuntimeModelFieldStatus;
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
  runtimeStatus,
}: ModelFieldProps): JSX.Element {
  return (
    <div>
      <label className="new-session-modal__label">MODEL</label>
      {runtimeStatus ? (
        <div className="model-catalog-status">
          <span role="status">
            {runtimeStatus.error ?? (models.length === 0 ? NO_MODELS_MESSAGE : runtimeStatus.stale ? 'Using cached models' : '')}
          </span>
          {runtimeStatus.onOpenSetup && models.length === 0 && (
            <button type="button" onClick={runtimeStatus.onOpenSetup}>
              Open setup
            </button>
          )}
          <button type="button" disabled={runtimeStatus.refreshing} aria-busy={runtimeStatus.refreshing} onClick={runtimeStatus.onRefresh}>
            {runtimeStatus.error ? 'Retry' : 'Refresh'}
          </button>
        </div>
      ) : (
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
        emptyMessage={runtimeStatus ? NO_MODELS_MESSAGE : undefined}
      />
    </div>
  );
}
