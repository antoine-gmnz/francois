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
 * pi-models-metrics (design brief §Flows) / A6 (review addendum): the ONE
 * ranking both the submenu's render and `orderedNavigableModels`'s keyboard
 * order use, so the two can never diverge again (that was A2). Three stable
 * partitions of whatever order the caller already has, never a sort within a
 * partition except recents' own most-recent-first order:
 *   1. favorites (a model that is both favorite and recent sorts as a favorite)
 *   2. this account's recents, most-recent-first (`recentRank`: 0 = most recent)
 *   3. everything else, catalog order
 * No `isFavorite`/`recentRank` at all ⇒ the input array, unchanged (same
 * reference) — every pre-existing non-Pi caller of `ModelPicker` is untouched.
 */
export function rankFavoritesAndRecents<T>(
  items: T[],
  isFavorite?: (item: T) => boolean,
  recentRank?: (item: T) => number | null,
): T[] {
  if (!isFavorite && !recentRank) return items;
  const favorites: T[] = [];
  const recents: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    if (isFavorite?.(item)) favorites.push(item);
    else if ((recentRank?.(item) ?? null) !== null) recents.push(item);
    else rest.push(item);
  }
  if (favorites.length === 0 && recents.length === 0) return items;
  recents.sort((a, b) => (recentRank?.(a) ?? 0) - (recentRank?.(b) ?? 0));
  return [...favorites, ...recents, ...rest];
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
  const left = Math.max(8, Math.min(trigger.left, viewportWidth - width - 8));
  // Opening above anchors the panel's BOTTOM edge to the trigger: the list is
  // usually shorter than `maxHeight`, so a `top` computed from it would leave
  // the panel floating near the top of the window, detached from the trigger.
  return openAbove
    ? { left, bottom: viewportHeight - trigger.top + 4, width, maxHeight }
    : { left, top: trigger.bottom + 4, width, maxHeight };
}

export function revealModelOption(root: HTMLElement): void {
  root.querySelector('.model-picker__family--active')?.scrollIntoView({ block: 'nearest' });
  root.querySelector('.model-picker__option--focused')?.scrollIntoView({ block: 'nearest' });
}

/**
 * A1 (review addendum): `keyboardModel` is state that outlives the list it
 * indexes into — a search keystroke or a catalogue refresh can remove the row
 * it points at. Derive the active id from the CURRENT visible list instead of
 * trusting the stored one, falling back to the first visible model.
 */
export function activeModelId(visibleModels: ModelInfo[], keyboardModel: string): string {
  return visibleModels.some((m) => m.id === keyboardModel) ? keyboardModel : (visibleModels[0]?.id ?? '');
}

/** Same derivation as `activeModelId`, for the hovered family (A1). */
export function activeFamily(families: ModelFamilyGroup[], hovered: string | null): string | null {
  return families.some((f) => f.family === hovered) ? hovered : (families[0]?.family ?? null);
}

/**
 * A2/A6: the flat order arrow keys step through — families in their rendered
 * order, favorites-then-recents WITHIN each family exactly like the
 * submenu's own render order (`rankFavoritesAndRecents`), so ↓/↑ never skips
 * past a row the eye can see next.
 */
export function orderedNavigableModels(
  families: ModelFamilyGroup[],
  isFavorite?: (model: ModelInfo) => boolean,
  recentRank?: (model: ModelInfo) => number | null,
): ModelInfo[] {
  return families.flatMap(({ items }) => rankFavoritesAndRecents(items, isFavorite, recentRank));
}

function isNavigable(model: ModelInfo): boolean {
  return model.descriptor?.availability !== 'unavailable';
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

/**
 * A2: steps `direction` through `ordered`, wrapping around, and skipping any
 * `unavailable` row (Enter there is already a no-op, so landing there with
 * the arrow keys is dead motion). `null` when nothing in `ordered` can be
 * navigated to (empty list, or every row unavailable).
 */
export function stepModel(ordered: ModelInfo[], currentId: string, direction: 1 | -1): ModelInfo | null {
  if (ordered.length === 0) return null;
  const startIndex = ordered.findIndex((m) => m.id === currentId);
  const base = startIndex === -1 ? (direction === 1 ? -1 : 0) : startIndex;
  for (let step = 1; step <= ordered.length; step++) {
    const candidate = ordered[wrapIndex(base + direction * step, ordered.length)];
    if (isNavigable(candidate)) return candidate;
  }
  return null;
}

/** A7: Home/End — the first (or last) navigable row, skipping unavailable ones. */
export function edgeModel(ordered: ModelInfo[], edge: 'start' | 'end'): ModelInfo | null {
  const scan = edge === 'start' ? ordered : [...ordered].reverse();
  return scan.find(isNavigable) ?? null;
}
