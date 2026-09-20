import { describe, expect, it } from 'vitest';
import type { Account } from '../../../contract/multi-account';
import type { SessionProfile } from '../../../contract/session-profiles';
import { basename, modelSelectionMismatch, profileRuntimeMismatch } from './new-session-form';

describe('basename', () => {
  it('returns the last segment of a posix path', () => {
    expect(basename('/home/user/my-project')).toBe('my-project');
  });

  it('returns the last segment of a windows path', () => {
    expect(basename('C:\\Users\\me\\my-project')).toBe('my-project');
  });

  it('handles a mix of separators', () => {
    expect(basename('C:\\Users\\me/my-project')).toBe('my-project');
  });

  it('ignores a trailing separator', () => {
    expect(basename('/home/user/my-project/')).toBe('my-project');
  });

  it('falls back to the input when there are no segments', () => {
    expect(basename('')).toBe('');
    expect(basename('/')).toBe('/');
  });

  it('returns a bare name unchanged', () => {
    expect(basename('my-project')).toBe('my-project');
  });
});

function legacyProfile(): SessionProfile {
  return { id: 'p1', name: 'reviewer', kind: 'legacy', createdAt: 0, updatedAt: 0 };
}

function piProfile(): SessionProfile {
  return {
    id: 'p2',
    name: 'pi-role',
    kind: 'pi',
    createdAt: 0,
    updatedAt: 0,
    settings: { systemPromptMode: 'default', instructionPaths: [], skillPaths: [], tools: [], projectResources: 'ignore' },
  };
}

function account(kind: Account['kind']): Account {
  return { id: 'a1', label: 'Account', configDir: null, builtIn: false, isDefault: false, createdAt: 0, kind };
}

describe('profileRuntimeMismatch (pi-migration-rollout §5/§7)', () => {
  it('is null when nothing is selected', () => {
    expect(profileRuntimeMismatch(null, account('pi'))).toBeNull();
    expect(profileRuntimeMismatch(legacyProfile(), null)).toBeNull();
  });

  it('is null when a legacy profile pairs with a non-Pi account', () => {
    expect(profileRuntimeMismatch(legacyProfile(), account('claude-code-oauth'))).toBeNull();
  });

  it('is null when a Pi profile pairs with a Pi account', () => {
    expect(profileRuntimeMismatch(piProfile(), account('pi'))).toBeNull();
  });

  it('flags a legacy profile on a Pi account, and offers Create Pi copy', () => {
    const mismatch = profileRuntimeMismatch(legacyProfile(), account('pi'));
    expect(mismatch).not.toBeNull();
    expect(mismatch?.offerCreatePiCopy).toBe(true);
  });

  it('flags a Pi profile on a non-Pi account, with no copy offer', () => {
    const mismatch = profileRuntimeMismatch(piProfile(), account('claude-code-oauth'));
    expect(mismatch).not.toBeNull();
    expect(mismatch?.offerCreatePiCopy).toBe(false);
  });
});

const ref = { providerId: 'anthropic', modelId: 'claude-sonnet-5' };

describe('modelSelectionMismatch (pi-models-metrics FR-4)', () => {
  it('is null for a non-Pi account submitting a plain modelId', () => {
    expect(modelSelectionMismatch(account('claude-code-oauth'), 'claude-sonnet-5', undefined)).toBeNull();
  });

  it('is null for a Pi account submitting an exact pair and no modelId', () => {
    expect(modelSelectionMismatch(account('pi'), '', ref)).toBeNull();
  });

  it('flags a Pi account with no pair — modelId alone is invalid for Pi', () => {
    expect(modelSelectionMismatch(account('pi'), 'claude-sonnet-5', undefined)).toBe(
      'a Pi account needs an exact provider/model pair, not a model id',
    );
    expect(modelSelectionMismatch(account('pi'), '', undefined)).toBe(
      'a Pi account needs an exact provider/model pair, not a model id',
    );
  });

  it('flags a non-Pi account carrying a runtimeModel pair', () => {
    expect(modelSelectionMismatch(account('claude-code-oauth'), '', ref)).toBe('runtimeModel is only valid for a Pi account');
  });

  it('flags a Pi account submitting BOTH fields at once', () => {
    expect(modelSelectionMismatch(account('pi'), 'claude-sonnet-5', ref)).toBe(
      'a Pi account cannot submit both modelId and runtimeModel',
    );
  });

  it('is null with no account selected yet (nothing to compare against)', () => {
    expect(modelSelectionMismatch(null, 'claude-sonnet-5', undefined)).toBeNull();
  });
});
