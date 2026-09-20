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

import { useMemo, useState } from 'react';
import type { AccountId, RuntimeModelRef } from '../../../contract/common';
import { runtimeModelKey } from '../../../contract/pi-models-metrics';
import { ModelField, type RuntimeModelFieldStatus } from './ModelField';
import type { RuntimeModelCatalogHookState } from './useRuntimeModelCatalog';
import { groupByProvider, runtimeCatalogModels } from './runtime-model';
import { favoriteKeys, recentRankByKey, toggleFavoriteModel } from './runtime-model-favorites';

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
  const [favoritesTick, bumpFavorites] = useState(0);
  // A4 (review addendum): one storage read per render (not per option, not per
  // keystroke) via `favoriteKeys`, and `models` rebuilt only when its inputs
  // actually change rather than on every render. `favoriteKeys()` itself takes
  // no args — `accountId`/`favoritesTick` are deliberate invalidation keys
  // (switch account, or toggle a favorite) rather than values the body reads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const favorites = useMemo(() => favoriteKeys(), [accountId, favoritesTick]);
  // A6 (review addendum): recents read the same way — once per render, keyed
  // by account, never invalidated by the favorites tick (recording a recent
  // never happens inside this component; see `recordRecentModel`'s call sites).
  const recentRanks = useMemo(() => recentRankByKey(accountId), [accountId]);
  const models = useMemo(() => runtimeCatalogModels(catalog.models, accountId, selected), [catalog.models, accountId, selected]);
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
      isFavorite={(m) => (m.runtimeModel ? favorites.has(runtimeModelKey(accountId, m.runtimeModel.providerId, m.runtimeModel.modelId)) : false)}
      onToggleFavorite={(m) => {
        if (!m.runtimeModel) return;
        toggleFavoriteModel(accountId, m.runtimeModel);
        bumpFavorites((t) => t + 1);
      }}
      recentRank={(m) => (m.runtimeModel ? recentRanks.get(runtimeModelKey(accountId, m.runtimeModel.providerId, m.runtimeModel.modelId)) ?? null : null)}
      runtimeStatus={runtimeStatus}
    />
  );
}
