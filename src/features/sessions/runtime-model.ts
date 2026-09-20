// runtime-model (pi-models-metrics §5) — RuntimeModelDescriptor <-> ModelInfo,
// and the pure catalogue pipeline the picker renders: merge in a vanished saved
// selection (FR-3), group by PROVIDER (grouping by family/label would collapse
// two providers advertising the same modelId into one row — FR-1). Reuses
// model-picker.ts's generic `groupModelsBy` so the existing family path
// (multi-provider-openai/codex consumers) is untouched.

import type { AccountId, ModelInfo, RuntimeModelDescriptor, RuntimeModelRef } from '../../../contract/common';
import { formatContextTokens } from '../../../contract/conversation-view';
import { runtimeModelKey } from '../../../contract/pi-models-metrics';
import { groupModelsBy, type ModelFamilyGroup } from './model-picker';

/** Identity is the `(providerId, modelId)` pair — display name is presentation only (FR-1). */
export function sameRuntimeModel(a: RuntimeModelRef, b: RuntimeModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/**
 * FR-3: a saved/default/favorite selection that no longer appears in a fresh
 * snapshot stays visible, disabled, with its EXACT identity — never dropped and
 * never silently replaced by a similarly named model. A no-op when the
 * selection is already listed (which also covers the runtime's own
 * 'unavailable' rows — those already carry their own reason).
 */
export function ensureSelectionVisible(
  models: RuntimeModelDescriptor[],
  selected: RuntimeModelRef | undefined,
): RuntimeModelDescriptor[] {
  if (!selected) return models;
  if (models.some((m) => sameRuntimeModel(m.ref, selected))) return models;
  return [
    ...models,
    {
      ref: selected,
      displayName: selected.modelId,
      input: [],
      contextWindow: null,
      maxOutputTokens: null,
      reasoning: false,
      authState: 'unknown',
      availability: 'unavailable',
      unavailableReason: "No longer in this account's catalogue",
    },
  ];
}

/** FR-1: display grouping is by provider — case as reported, first-seen order. */
export function providerIdOf(model: ModelInfo): string {
  return model.descriptor?.ref.providerId ?? model.runtimeModel?.providerId ?? '';
}

export function groupByProvider(models: ModelInfo[]): ModelFamilyGroup[] {
  return groupModelsBy(models, providerIdOf);
}

/** A short factual line: context window + input modes, or the unavailable reason. */
export function runtimeModelBrief(descriptor: RuntimeModelDescriptor): string {
  if (descriptor.availability === 'unavailable') return descriptor.unavailableReason ?? 'unavailable';
  const parts: string[] = [];
  if (descriptor.contextWindow !== null) parts.push(`${formatContextTokens(descriptor.contextWindow)} context`);
  if (descriptor.input.includes('image')) parts.push('text + image');
  return parts.join(' · ');
}

/**
 * The picker's row shape for one Pi descriptor. `id` is the composite
 * (accountId, providerId, modelId) key — the ONLY thing that disambiguates two
 * providers sharing a modelId in a plain-string-keyed picker (FR-1). `efforts`
 * is deliberately left unset: the descriptor advertises only a `reasoning`
 * boolean, not a discrete level list — see this feature's handoff notes.
 */
export function modelInfoFromRuntimeDescriptor(descriptor: RuntimeModelDescriptor, accountId: AccountId): ModelInfo {
  return {
    id: runtimeModelKey(accountId, descriptor.ref.providerId, descriptor.ref.modelId),
    label: descriptor.displayName,
    brief: runtimeModelBrief(descriptor),
    contextTokens: descriptor.contextWindow ?? undefined,
    runtimeModel: descriptor.ref,
    descriptor,
  };
}

/**
 * The catalogue → picker pipeline: merge the current selection back in if the
 * runtime no longer lists it, then map to the picker's row shape. Search and
 * grouping happen AFTER this, in the component — they act on the user's live
 * query / the current view, not the catalogue itself.
 */
export function runtimeCatalogModels(
  models: RuntimeModelDescriptor[],
  accountId: AccountId,
  selected: RuntimeModelRef | undefined,
): ModelInfo[] {
  return ensureSelectionVisible(models, selected).map((m) => modelInfoFromRuntimeDescriptor(m, accountId));
}

/**
 * FR-2/FR-4: a stale cached catalogue — or one still loading, or one that
 * failed to load — never authorizes a new session/submission on its own, even
 * when the wanted pair happens to still be in the (stale) list.
 */
export function runtimeSelectionIsFresh(
  snapshot: { stale: boolean; loading: boolean; error: string | null; models: RuntimeModelDescriptor[] },
  selected: RuntimeModelRef | undefined,
): boolean {
  if (!selected || snapshot.loading || snapshot.error !== null || snapshot.stale) return false;
  return snapshot.models.some((m) => sameRuntimeModel(m.ref, selected) && m.availability === 'available');
}
