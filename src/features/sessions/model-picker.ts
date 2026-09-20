// model-picker (multi-provider-openai FR-21) — the pure grouping ModelPicker's
// popover renders: family first (a model's label up to its first space, e.g.
// "Sonnet 5" → "Sonnet"), extracted so it's covered by vitest instead of
// living inline in the component. `groupByFamily` preserves first-seen family
// order — the order models arrive in the catalog, not alphabetical.
//
// FR-21 (design brief §5): "the session's own provider's group is listed;
// models from other providers are not offered as switch targets" — a caller
// scopes `models` to the session's own provider BEFORE calling this, so
// grouping itself never has to know what a provider is.

import type { ModelInfo } from '../../../contract/common';

export function familyOf(model: ModelInfo): string {
  return model.label.split(' ')[0] || model.label;
}

export interface ModelFamilyGroup {
  family: string;
  items: ModelInfo[];
}

/**
 * pi-models-metrics §5: the generic building block `groupByFamily` is built on
 * top of — first-seen KEY order, not alphabetical, not sorted. `groupByFamily`
 * groups by family (the existing multi-provider-openai/codex consumers, byte
 * for byte); `runtime-model.ts`'s `groupByProvider` groups by `providerId`
 * (FR-1: two providers can share a modelId, so family/label alone would
 * collapse them into one group).
 */
export function groupModelsBy(models: ModelInfo[], keyOf: (model: ModelInfo) => string): ModelFamilyGroup[] {
  const map = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const key = keyOf(m);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(m);
  }
  return Array.from(map, ([family, items]) => ({ family, items }));
}

/** First-seen family order — not alphabetical, not sorted. */
export function groupByFamily(models: ModelInfo[]): ModelFamilyGroup[] {
  return groupModelsBy(models, familyOf);
}

/**
 * pi-models-metrics (design brief §Flows): "Search provider and model labels."
 * Case-insensitive substring match against the label plus, when present, the
 * Pi identity (provider id / model id) so a search for a provider name finds
 * every model under it even when the provider isn't in the display label.
 */
export function filterModelInfos(models: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase();
  if (q === '') return models;
  return models.filter((m) => {
    const ref = m.descriptor?.ref ?? m.runtimeModel;
    const haystack = [m.label, ref?.providerId, ref?.modelId].filter((s): s is string => typeof s === 'string').join(' ');
    return haystack.toLowerCase().includes(q);
  });
}

/**
 * pi-models-metrics (design brief §Flows): favorites float to the top of
 * whatever order the caller already has, without otherwise reordering either
 * half — a stable partition, not a sort.
 */
export function sortFavoritesFirst<T>(items: T[], isFavorite: (item: T) => boolean): T[] {
  const favorites = items.filter(isFavorite);
  const rest = items.filter((item) => !isFavorite(item));
  return favorites.length === 0 ? items : [...favorites, ...rest];
}

export function modelPickerPlacement(
  trigger: { left: number; top: number; bottom: number; width: number },
  viewportWidth: number,
  viewportHeight: number,
) {
  const width = Math.min(trigger.width, viewportWidth - 16);
  const below = viewportHeight - trigger.bottom - 12;
  const above = trigger.top - 12;
  const openAbove = above > below;
  const maxHeight = Math.max(0, Math.min(viewportHeight * 0.6, openAbove ? above : below));
  return {
    left: Math.max(8, Math.min(trigger.left, viewportWidth - width - 8)),
    top: openAbove ? trigger.top - maxHeight - 4 : trigger.bottom + 4,
    width,
    maxHeight,
  };
}

export function revealModelOption(root: HTMLElement): void {
  root.querySelector('.model-picker__family--active')?.scrollIntoView({ block: 'nearest' });
  root.querySelector('.model-picker__option--focused')?.scrollIntoView({ block: 'nearest' });
}
