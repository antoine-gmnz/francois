// useModelCatalog — NewSessionModal.tsx's former :95-115 effect, extracted
// verbatim. Deliberately does NOT guard on a mount ref: the original effect
// never checked one for this fetch (only the project-list fetch and submit()
// do), so this preserves that exactly.

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { ModelInfo } from '../../../contract/common';
import { sessionModels } from '../../lib/api';

export interface UseModelCatalogResult {
  models: ModelInfo[];
  modelsLoading: boolean;
  modelId: string;
  setModelId: Dispatch<SetStateAction<string>>;
}

export function useModelCatalog(): UseModelCatalogResult {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelId, setModelId] = useState('');

  useEffect(() => {
    void sessionModels().then((res) => {
      setModelsLoading(false);
      if (res.ok) {
        setModels(res.data);
        // Seed the picker ONLY while nothing has chosen a model yet. StrictMode
        // fires this fetch twice and the second resolve lands AFTER the project
        // defaults are applied — an unconditional set here silently reverted the
        // project's model back to the catalog's first entry.
        setModelId((cur) => cur || res.data[0]?.id || '');
      }
    });
  }, []);

  return { models, modelsLoading, modelId, setModelId };
}
