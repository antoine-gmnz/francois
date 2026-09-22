// Shared normalized model-event display projection; no runtime execution.
import type { AccountId, ModelInfo, RuntimeModelDescriptor } from '../../contract/common';
import { formatContextTokens } from '../../contract/conversation-view';
import { runtimeModelKey } from '../../contract/pi-models-metrics';

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
