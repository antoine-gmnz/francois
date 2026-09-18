import './model-catalog-status.css';
import type { ModelCatalogState } from '../lib/hooks/useModelCatalog';

export function ModelCatalogStatus({ state }: { state: ModelCatalogState }) {
  const { catalog, error, modelsLoading, showLoading, refresh } = state;
  return <div className="model-catalog-status">
    <span role="status">{showLoading ? 'Loading models…' : error ? "Couldn't load models" : catalog?.freshness === 'stale' ? 'Using cached models' : catalog?.models.length === 0 ? 'No models available' : ''}</span>
    {(error || catalog?.warning) && <span className="model-catalog-status__error">{(error ?? catalog?.warning)?.message}</span>}
    <button type="button" disabled={modelsLoading} aria-busy={modelsLoading} onClick={refresh}>{error ? 'Retry' : 'Refresh models'}</button>
  </div>;
}
