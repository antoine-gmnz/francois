import { describe, expect, it } from 'vitest';
import type { RuntimeModelDescriptor } from '../../contract/common';
import { runtimeModelKey } from '../../contract/pi-models-metrics';
import { modelInfoFromRuntimeDescriptor, runtimeModelBrief } from './runtime-model-info';

function descriptor(over: Partial<RuntimeModelDescriptor> = {}): RuntimeModelDescriptor {
  return {
    ref: { providerId: 'anthropic', modelId: 'claude-sonnet-5' },
    displayName: 'Sonnet 5',
    input: ['text'],
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    reasoning: true,
    authState: 'verified',
    availability: 'available',
    ...over,
  };
}

describe('runtimeModelBrief', () => {
  it('summarizes context window and input modes', () => {
    expect(runtimeModelBrief(descriptor({ contextWindow: 200_000, input: ['text', 'image'] }))).toBe('200K context · text + image');
  });

  it('is just the context window when there is no image input', () => {
    expect(runtimeModelBrief(descriptor({ input: ['text'] }))).toBe('200K context');
  });

  it('is empty when nothing is known', () => {
    expect(runtimeModelBrief(descriptor({ contextWindow: null, input: [] }))).toBe('');
  });

  it('is the unavailable reason for a disabled row, not a context summary', () => {
    expect(runtimeModelBrief(descriptor({ availability: 'unavailable', unavailableReason: 'Removed from models.json' }))).toBe(
      'Removed from models.json',
    );
  });
});

describe('modelInfoFromRuntimeDescriptor', () => {
  it('keys the row by the composite (account, provider, model) identity — not the bare modelId', () => {
    const info = modelInfoFromRuntimeDescriptor(descriptor(), 'acct-1');
    expect(info.id).toBe(runtimeModelKey('acct-1', 'anthropic', 'claude-sonnet-5'));
    expect(info.label).toBe('Sonnet 5');
    expect(info.runtimeModel).toEqual({ providerId: 'anthropic', modelId: 'claude-sonnet-5' });
    expect(info.descriptor).toEqual(descriptor());
  });

  it('does not fabricate an efforts list the descriptor never advertised', () => {
    expect(modelInfoFromRuntimeDescriptor(descriptor({ reasoning: true }), 'acct-1').efforts).toBeUndefined();
  });
});
