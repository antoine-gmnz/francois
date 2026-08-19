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

/** First-seen family order — not alphabetical, not sorted. */
export function groupByFamily(models: ModelInfo[]): ModelFamilyGroup[] {
  const map = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const family = familyOf(m);
    if (!map.has(family)) map.set(family, []);
    map.get(family)!.push(m);
  }
  return Array.from(map, ([family, items]) => ({ family, items }));
}

/**
 * useModelCatalog's account-rekey fetch resolver: which model id the picker
 * should show once a `session_models` fetch resolves. `current` is kept when
 * it is still in the freshly fetched `models` — this is what makes a
 * StrictMode double-fetch harmless (a project default already applied to
 * `current` before the second resolve lands survives, since it is still in
 * the catalog) and what re-seeds the picker when the selected account
 * changed to a different provider (a Claude model id is never in an
 * endpoint's catalog, so it falls through to the new catalog's first entry).
 * Empty for an empty catalog — never a fabricated id.
 */
export function reconcileModelId(current: string, models: ModelInfo[]): string {
  if (current !== '' && models.some((m) => m.id === current)) return current;
  return models[0]?.id ?? '';
}
