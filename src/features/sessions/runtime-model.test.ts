import { describe, expect, it } from 'vitest';
import type { RuntimeModelDescriptor } from '../../../contract/common';
import { runtimeModelKey } from '../../../contract/pi-models-metrics';
import { modelInfoFromRuntimeDescriptor } from '../../lib/runtime-model-info';
import {
  ensureSelectionVisible,
  groupByProvider,
  providerIdOf,
  runtimeCatalogModels,
  runtimeSelectionIsFresh,
  sameRuntimeModel,
} from './runtime-model';

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

describe('sameRuntimeModel', () => {
  it('is identity by (providerId, modelId) — FR-1', () => {
    expect(sameRuntimeModel({ providerId: 'a', modelId: 'm' }, { providerId: 'a', modelId: 'm' })).toBe(true);
    expect(sameRuntimeModel({ providerId: 'a', modelId: 'm' }, { providerId: 'b', modelId: 'm' })).toBe(false);
    expect(sameRuntimeModel({ providerId: 'a', modelId: 'm' }, { providerId: 'a', modelId: 'n' })).toBe(false);
  });
});

describe('ensureSelectionVisible (FR-3)', () => {
  it('is a no-op when there is no selection to protect', () => {
    const models = [descriptor()];
    expect(ensureSelectionVisible(models, undefined)).toBe(models);
  });

  it('is a no-op when the selection is already listed', () => {
    const models = [descriptor()];
    expect(ensureSelectionVisible(models, { providerId: 'anthropic', modelId: 'claude-sonnet-5' })).toBe(models);
  });

  it('appends a disabled row with the EXACT identity when the selection vanished — never a Sonnet fallback', () => {
    const selected = { providerId: 'ollama', modelId: 'llama3-removed' };
    const result = ensureSelectionVisible([descriptor()], selected);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ ref: selected, availability: 'unavailable' });
    expect(result[1].unavailableReason).toBeTruthy();
  });
});

describe('groupByProvider / providerIdOf (FR-1)', () => {
  it('keeps two providers sharing a modelId as distinct groups', () => {
    const a = modelInfoFromRuntimeDescriptor(descriptor({ ref: { providerId: 'anthropic', modelId: 'sonnet' } }), 'acct');
    const b = modelInfoFromRuntimeDescriptor(descriptor({ ref: { providerId: 'ollama', modelId: 'sonnet' } }), 'acct');
    expect(providerIdOf(a)).toBe('anthropic');
    expect(providerIdOf(b)).toBe('ollama');
    expect(groupByProvider([a, b])).toEqual([
      { family: 'anthropic', items: [a] },
      { family: 'ollama', items: [b] },
    ]);
  });

  it('falls back to the bare runtimeModel ref when there is no descriptor (a legacy-projected row)', () => {
    const row = { id: 'x', label: 'X', runtimeModel: { providerId: 'openai-compat', modelId: 'x' } };
    expect(providerIdOf(row)).toBe('openai-compat');
  });
});

// runtimeModelBrief / modelInfoFromRuntimeDescriptor's own tests moved to
// src/lib/runtime-model-info.test.ts with the functions (frontend fix loop §7
// item 5). `modelInfoFromRuntimeDescriptor` is still imported here to build
// ModelInfo fixtures for the groupByProvider/providerIdOf test below.

describe('runtimeCatalogModels (the catalogue → picker pipeline)', () => {
  it('merges the vanished selection in, then maps every row', () => {
    const models = runtimeCatalogModels([descriptor()], 'acct-1', { providerId: 'ollama', modelId: 'gone' });
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe(runtimeModelKey('acct-1', 'anthropic', 'claude-sonnet-5'));
    expect(models[1]).toMatchObject({ id: runtimeModelKey('acct-1', 'ollama', 'gone'), descriptor: { availability: 'unavailable' } });
  });
});

describe('runtimeSelectionIsFresh (FR-2/FR-4)', () => {
  const fresh = { stale: false, loading: false, error: null, models: [descriptor()] };
  const selected = { providerId: 'anthropic', modelId: 'claude-sonnet-5' };

  it('authorizes only a listed, AVAILABLE pair off a fresh, settled snapshot', () => {
    expect(runtimeSelectionIsFresh(fresh, selected)).toBe(true);
  });

  it('refuses a stale snapshot even when the pair is still (stale-)listed', () => {
    expect(runtimeSelectionIsFresh({ ...fresh, stale: true }, selected)).toBe(false);
  });

  it('refuses while loading, on error, or with no selection', () => {
    expect(runtimeSelectionIsFresh({ ...fresh, loading: true }, selected)).toBe(false);
    expect(runtimeSelectionIsFresh({ ...fresh, error: 'boom' }, selected)).toBe(false);
    expect(runtimeSelectionIsFresh(fresh, undefined)).toBe(false);
  });

  it('refuses a pair that is listed but marked unavailable', () => {
    const models = [descriptor({ availability: 'unavailable', unavailableReason: 'gone' })];
    expect(runtimeSelectionIsFresh({ ...fresh, models }, selected)).toBe(false);
  });
});
