// useModelCatalog — NewSessionModal.tsx's former :95-115 effect, extracted
// verbatim. Deliberately does NOT guard on a mount ref: the original effect
// never checked one for this fetch (only the project-list fetch and submit()
// do), so this preserves that exactly.
//
// multi-provider-openai FR-18/FR-21: keyed on `accountId` — session_models is
// now account-scoped (contract/session-engine.ts), so picking an endpoint
// account in the New Session modal refetches and repopulates the catalog
// with THAT account's own models rather than Claude Code's.

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { AccountId, ModelInfo } from '../../../contract/common';
import { sessionModels } from '../../lib/api';
import { reconcileModelId } from './model-picker';

export interface UseModelCatalogResult {
  models: ModelInfo[];
  modelsLoading: boolean;
  modelId: string;
  setModelId: Dispatch<SetStateAction<string>>;
}

export function useModelCatalog(accountId: AccountId): UseModelCatalogResult {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelId, setModelId] = useState('');

  useEffect(() => {
    setModelsLoading(true);
    void sessionModels(accountId).then((res) => {
      setModelsLoading(false);
      if (res.ok) {
        setModels(res.data);
        // reconcileModelId keeps `cur` when it's still in the freshly fetched
        // catalog — which is what makes a StrictMode double-fetch harmless
        // (a project default already applied to `cur` survives the second,
        // later resolve) AND re-seeds the picker when `accountId` just
        // switched to a different provider's catalog (the old id won't be
        // in the new one, so it falls through to the first entry).
        setModelId((cur) => reconcileModelId(cur, res.data));
      }
    });
  }, [accountId]);

  return { models, modelsLoading, modelId, setModelId };
}
