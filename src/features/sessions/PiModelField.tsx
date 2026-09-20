// pi-models-metrics FR-1/FR-2/FR-3 — the Pi provider/model field: the shared
// presentational wiring between the runtime catalogue, the generalized
// ModelField/ModelPicker (groupByProvider, searchable) and the UI-preference
// favorites store (runtime-model-favorites.ts, mounted nowhere until this
// feature). Purely presentational — `catalog` is `useRuntimeModelCatalog`'s
// OWN state, passed in rather than fetched here, because the New Session
// form's Create button also needs it (a stale/loading/errored snapshot must
// not authorize Create — FR-2/FR-4) and a hook this component called itself
// would put that state out of the caller's reach. `PiRunModelSwitch` (the run
// chip's live switch) calls the hook itself and hands the same state down.

import { useState } from 'react';
import type { AccountId, RuntimeModelRef } from '../../../contract/common';
import { runtimeModelKey } from '../../../contract/pi-models-metrics';
import { ModelField, type RuntimeModelFieldStatus } from './ModelField';
import type { RuntimeModelCatalogHookState } from './useRuntimeModelCatalog';
import { groupByProvider, runtimeCatalogModels } from './runtime-model';
import { isFavoriteModel, toggleFavoriteModel } from './runtime-model-favorites';

export interface PiModelFieldProps {
  accountId: AccountId;
  catalog: RuntimeModelCatalogHookState;
  /** The exact pair currently selected — a vanished one stays visible, disabled (FR-3). */
  selected: RuntimeModelRef | undefined;
  onSelect: (ref: RuntimeModelRef) => void;
  providerHeading: string;
  /** FR-1: "Open setup" appears only when the caller has somewhere to send it. */
  onOpenSetup?: () => void;
}

/** pi-models-metrics §5/design brief — the Pi model track's one field. */
export function PiModelField({ accountId, catalog, selected, onSelect, providerHeading, onOpenSetup }: PiModelFieldProps): JSX.Element {
  // Favorites live in localStorage, outside React state — this tick forces a
  // re-render so the star reflects a toggle immediately (runtime-model-favorites.ts).
  const [, bumpFavorites] = useState(0);
  const models = runtimeCatalogModels(catalog.models, accountId, selected);
  const modelId = selected ? runtimeModelKey(accountId, selected.providerId, selected.modelId) : '';

  const runtimeStatus: RuntimeModelFieldStatus = {
    stale: catalog.stale,
    error: catalog.error,
    refreshing: catalog.showLoading,
    onRefresh: catalog.refresh,
    onOpenSetup,
  };

  return (
    <ModelField
      models={models}
      modelId={modelId}
      loading={catalog.loading}
      onChange={(id) => {
        const picked = models.find((m) => m.id === id);
        if (picked?.runtimeModel) onSelect(picked.runtimeModel);
      }}
      providerHeading={providerHeading}
      groupBy={groupByProvider}
      searchable
      isFavorite={(m) => (m.runtimeModel ? isFavoriteModel(accountId, m.runtimeModel) : false)}
      onToggleFavorite={(m) => {
        if (!m.runtimeModel) return;
        toggleFavoriteModel(accountId, m.runtimeModel);
        bumpFavorites((t) => t + 1);
      }}
      runtimeStatus={runtimeStatus}
    />
  );
}
