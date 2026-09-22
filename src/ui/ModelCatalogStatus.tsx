import './model-catalog-status.css';
import type { ModelCatalogState } from '../lib/hooks/useModelCatalog';
import { LoaderCaret } from './Loaders';

export function ModelCatalogStatus({ state }: { state: ModelCatalogState }) {
  const { catalog, error, modelsLoading, showLoading, refresh } = state;
  return <div className="model-catalog-status">
    {/* loaders: model-catalog.ts already gates `showLoading` behind its own
        150ms timer, so `delay={0}` here — a second delay would double it. */}
    <span role="status">{showLoading ? <LoaderCaret label="loading models" delay={0} /> : error ? "Couldn't load models" : catalog?.freshness === 'stale' ? 'Using cached models' : catalog?.models.length === 0 ? 'No models available' : ''}</span>
    {(error || catalog?.warning) && <span className="model-catalog-status__error">{(error ?? catalog?.warning)?.message}</span>}
    <button type="button" disabled={modelsLoading} aria-busy={modelsLoading} onClick={refresh}>{error ? 'Retry' : 'Refresh models'}</button>
  </div>;
}
