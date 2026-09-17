import type { AppError } from '../../contract/common';
import type { ModelCatalog, SessionModelsInput, SessionModelsResponse } from '../../contract/session-engine';

export interface CatalogState {
  accountId: string;
  catalog: ModelCatalog | null;
  loading: boolean;
  showLoading: boolean;
  error: AppError | null;
}
export function reconcileCatalogModel(current: string, catalog: ModelCatalog): string {
  return catalog.models.some(m => m.id === current) ? current
    : catalog.models.find(m => m.id === catalog.defaultModelId)?.id ?? catalog.models[0]?.id ?? '';
}

/** Per-view presentation lifecycle. Only core caches data and decides stale eligibility. */
export function createModelCatalogController(fetchModels: (input: SessionModelsInput) => Promise<SessionModelsResponse>) {
  let state: CatalogState = { accountId: '', catalog: null, loading: false, showLoading: false, error: null };
  let generation = 0;
  let pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<CatalogState>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  return {
    getState: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    cancel: () => { generation++; clearTimeout(timer); pending = null; },
    load(accountId: string, refresh = false): Promise<void> {
      if (pending && state.accountId === accountId) return pending;
      const request = ++generation;
      clearTimeout(timer);
      publish({ accountId, catalog: state.accountId === accountId ? state.catalog : null, loading: true, showLoading: false, error: null });
      timer = setTimeout(() => { if (generation === request) publish({ showLoading: true }); }, 150);
      pending = (async () => {
        try {
          const result = await fetchModels({ accountId, ...(refresh ? { refresh: true } : {}) });
          if (generation !== request) return;
          if (result.ok && result.data.accountId === accountId) publish({ catalog: result.data, error: null });
          else publish({ catalog: null, error: result.ok ? { code: 'INTERNAL', message: "Couldn't load models" } : result.error });
        } catch {
          if (generation === request) publish({ catalog: null, error: { code: 'INTERNAL', message: "Couldn't load models" } });
        } finally {
          if (generation === request) { clearTimeout(timer); pending = null; publish({ loading: false, showLoading: false }); }
        }
      })();
      return pending;
    },
  };
}
