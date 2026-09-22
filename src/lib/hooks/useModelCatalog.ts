import { useEffect, useState, useSyncExternalStore } from 'react';
import { sessionModels } from '../api';
import { createModelCatalogController, reconcileCatalogModel } from '../model-catalog';
import { PI_UNAVAILABLE, accountIsRetired } from '../runtimeCapability';
import { useStore } from '../store';

export function useModelCatalog(accountId: string, initialModelId = '', unavailable = false) {
  const retiredAccount = useStore((s) => accountIsRetired(s.accounts.find((a) => a.id === accountId)));
  const retired = unavailable || retiredAccount;
  const [controller] = useState(() => createModelCatalogController(sessionModels));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [modelId, setModelId] = useState(initialModelId);
  useEffect(() => {
    if (retired) { controller.cancel(); return; }
    void controller.load(accountId);
    return controller.cancel;
  }, [accountId, controller, retired]);
  const catalog = !retired && state.accountId === accountId ? state.catalog : null;
  useEffect(() => {
    if (catalog) setModelId(current => reconcileCatalogModel(current, catalog));
  }, [catalog]);
  return {
    ...state,
    catalog,
    error: retired ? { code: 'RUNTIME_UNSUPPORTED' as const, message: PI_UNAVAILABLE } : state.accountId === accountId ? state.error : null,
    models: catalog?.models ?? [],
    modelsLoading: !retired && (state.accountId !== accountId || state.loading),
    showLoading: !retired && state.accountId === accountId && state.showLoading,
    modelId,
    setModelId,
    refresh: () => { if (!retired) void controller.load(accountId, true); },
  };
}
export type ModelCatalogState = ReturnType<typeof useModelCatalog>;
