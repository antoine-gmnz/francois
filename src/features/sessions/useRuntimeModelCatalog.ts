// useRuntimeModelCatalog (pi-models-metrics §5) — the Pi twin of
// src/lib/hooks/useModelCatalog.ts: the SAME per-view presentation lifecycle
// (loading/showLoading debounce after 150ms, cancel-on-account-change, isolate
// simultaneous consumers), driven by `runtime_models` instead of
// `session_models`. Kept as its OWN hook rather than a branch inside the
// legacy one — the two catalogs are shaped completely differently
// (RuntimeModelCatalog vs ModelCatalog) and the legacy hook is shared with
// runtimes this feature must not touch. Named distinctly (not `useModelCatalog`)
// so nothing in the codebase has two same-named hooks living side by side.

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AccountId, RuntimeModelDescriptor } from '../../../contract/common';
import type { RuntimeModelsInput, RuntimeModelsResult } from '../../../contract/pi-models-metrics';
import { runtimeModels } from '../../lib/api';

export interface RuntimeModelCatalogState {
  accountId: AccountId;
  models: RuntimeModelDescriptor[];
  checkedAt: number | null;
  /** FR-2/FR-9: served from cache past the 60s TTL, or a failed refresh kept
   *  the previous catalogue — still rendered, but never authorizing (FR-4). */
  stale: boolean;
  loading: boolean;
  showLoading: boolean;
  error: string | null;
}

const IDLE: RuntimeModelCatalogState = {
  accountId: '',
  models: [],
  checkedAt: null,
  stale: false,
  loading: false,
  showLoading: false,
  error: null,
};

/** Per-view presentation lifecycle only — the 60s TTL and the stale/refresh
 *  decision belong to the core (FR-2). Takes the fetcher as a parameter (like
 *  model-catalog.ts's createModelCatalogController) so it's testable without
 *  mocking the Tauri bridge. */
export function createRuntimeModelCatalogController(fetchModels: (input: RuntimeModelsInput) => Promise<RuntimeModelsResult>) {
  let state: RuntimeModelCatalogState = IDLE;
  let generation = 0;
  let pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<RuntimeModelCatalogState>) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  return {
    getState: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    cancel: () => {
      generation++;
      clearTimeout(timer);
      pending = null;
    },
    load(accountId: AccountId, refresh = false): Promise<void> {
      if (pending && state.accountId === accountId && !refresh) return pending;
      const request = ++generation;
      clearTimeout(timer);
      publish({
        accountId,
        models: state.accountId === accountId ? state.models : [],
        loading: true,
        showLoading: false,
        error: null,
      });
      timer = setTimeout(() => {
        if (generation === request) publish({ showLoading: true });
      }, 150);
      pending = (async () => {
        try {
          const result = await fetchModels({ accountId, ...(refresh ? { refresh: true } : {}) });
          if (generation !== request) return;
          if (result.ok && result.data.accountId === accountId) {
            publish({ models: result.data.models, checkedAt: result.data.checkedAt, stale: result.data.stale, error: null });
          } else {
            publish({ models: [], error: result.ok ? "Couldn't load models" : result.error.message });
          }
        } catch {
          if (generation === request) publish({ models: [], error: "Couldn't load models" });
        } finally {
          if (generation === request) {
            clearTimeout(timer);
            pending = null;
            publish({ loading: false, showLoading: false });
          }
        }
      })();
      return pending;
    },
  };
}

export function useRuntimeModelCatalog(accountId: AccountId) {
  const [controller] = useState(() => createRuntimeModelCatalogController(runtimeModels));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useEffect(() => {
    void controller.load(accountId);
    return controller.cancel;
  }, [accountId, controller]);
  const current = state.accountId === accountId;
  return {
    ...state,
    models: current ? state.models : [],
    stale: current && state.stale,
    error: current ? state.error : null,
    refresh: () => {
      void controller.load(accountId, true);
    },
  };
}
export type RuntimeModelCatalogHookState = ReturnType<typeof useRuntimeModelCatalog>;
