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
