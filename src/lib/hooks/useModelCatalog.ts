import { useEffect, useState, useSyncExternalStore } from 'react';
import { sessionModels } from '../api';
import { createModelCatalogController, reconcileCatalogModel } from '../model-catalog';

export function useModelCatalog(accountId: string, initialModelId = '') {
  const [controller] = useState(() => createModelCatalogController(sessionModels));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [modelId, setModelId] = useState(initialModelId);
  useEffect(() => {
    void controller.load(accountId);
    return controller.cancel;
  }, [accountId, controller]);
  const catalog = state.accountId === accountId ? state.catalog : null;
  useEffect(() => {
    if (catalog) setModelId(current => reconcileCatalogModel(current, catalog));
  }, [catalog]);
  return {
    ...state,
    catalog,
    error: state.accountId === accountId ? state.error : null,
    models: catalog?.models ?? [],
    modelsLoading: state.accountId !== accountId || state.loading,
    showLoading: state.accountId === accountId && state.showLoading,
    modelId,
    setModelId,
    refresh: () => { void controller.load(accountId, true); },
  };
}
export type ModelCatalogState = ReturnType<typeof useModelCatalog>;
