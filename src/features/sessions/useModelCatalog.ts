// useModelCatalog — NewSessionModal.tsx's former :95-115 effect, extracted
// verbatim. Deliberately does NOT guard on a mount ref: the original effect
// never checked one for this fetch (only the project-list fetch and submit()
// do), so this preserves that exactly.
//
// multi-provider-openai FR-18/FR-21: keyed on `accountId` — session_models is
// now account-scoped (contract/session-engine.ts), so picking an endpoint
// account in the New Session modal refetches and repopulates the catalog
// with THAT account's own models rather than Claude Code's.
//
// review round 2 (HIGH): an endpoint account's real network round-trip can be
// far slower than the default account's local catalog. Switching accounts
// before the slow request resolves let its out-of-order response overwrite
// the newly selected account's already-correct catalog — the endpoint's
// models rendered under the "Default" heading. `startModelCatalogFetch` is
// the framework-free half (fully covered by ./useModelCatalog.test.ts),
// following the same `let cancelled = false` cleanup shape as
// useSessionFleetSync.ts's mount effect: the cleanup returned here runs
// before the NEXT `[accountId]` effect fires, so a request that hasn't
// resolved by the time the account changes again is dropped rather than
// applied.

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { AccountId, ModelInfo, Result } from '../../../contract/common';
import { sessionModels } from '../../lib/api';
import { reconcileModelId } from './model-picker';

export interface UseModelCatalogResult {
  models: ModelInfo[];
  modelsLoading: boolean;
  modelId: string;
  setModelId: Dispatch<SetStateAction<string>>;
}

export interface ModelCatalogCallbacks {
  setModelsLoading: (loading: boolean) => void;
  setModels: (models: ModelInfo[]) => void;
  setModelId: (updater: (cur: string) => string) => void;
}

/**
 * Fires one `session_models` request for `accountId` and applies its result
 * through `callbacks` — unless the returned stop function has already run by
 * the time it resolves, in which case the resolution is dropped. Returns the
 * stop function; calling it after the request already resolved is a no-op.
 */
export function startModelCatalogFetch(
  accountId: AccountId,
  fetchModels: (accountId: AccountId) => Promise<Result<ModelInfo[]>>,
  callbacks: ModelCatalogCallbacks,
): () => void {
  let cancelled = false;
  callbacks.setModelsLoading(true);
  void fetchModels(accountId).then((res) => {
    if (cancelled) return;
    callbacks.setModelsLoading(false);
    if (res.ok) {
      callbacks.setModels(res.data);
      // reconcileModelId keeps `cur` when it's still in the freshly fetched
      // catalog — which is what makes a StrictMode double-fetch harmless
      // (a project default already applied to `cur` survives the second,
      // later resolve) AND re-seeds the picker when `accountId` just
      // switched to a different provider's catalog (the old id won't be
      // in the new one, so it falls through to the first entry).
      callbacks.setModelId((cur) => reconcileModelId(cur, res.data));
    }
  });
  return () => {
    cancelled = true;
  };
}

export function useModelCatalog(accountId: AccountId): UseModelCatalogResult {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelId, setModelId] = useState('');

  useEffect(
    () => startModelCatalogFetch(accountId, sessionModels, { setModelsLoading, setModels, setModelId }),
    [accountId],
  );

  return { models, modelsLoading, modelId, setModelId };
}
