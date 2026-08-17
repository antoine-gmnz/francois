import { describe, expect, it } from 'vitest';
import type { AppError } from '../../../contract/common';
import type { SessionProfile } from '../../../contract/session-profiles';
import {
  canSaveProfileName,
  flagAdvisoryTokens,
  isExtraArgsInvalidInput,
  newSessionProfileOptions,
  profileArgDeniedDetail,
  profileChipTitle,
  profileFormOverrides,
  projectDefaultProfileResolution,
  removeProfileConfirmText,
  resolveProfile,
  resolveProjectDefaultProfileId,
} from './profiles';

function profile(overrides: Partial<SessionProfile> = {}): SessionProfile {
  return {
    id: 'p1',
    name: 'agent-architect',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('resolveProfile (FR-15/FR-16)', () => {
  it('finds a profile by id', () => {
    const p = profile();
    expect(resolveProfile([p], 'p1')).toBe(p);
  });

  it('returns null for an unknown id, undefined, or null', () => {
    const p = profile();
    expect(resolveProfile([p], 'nope')).toBeNull();
    expect(resolveProfile([p], undefined)).toBeNull();
    expect(resolveProfile([p], null)).toBeNull();
  });
});

describe('resolveProjectDefaultProfileId (FR-21)', () => {
  it('resolves an id present in the registry', () => {
    expect(resolveProjectDefaultProfileId([profile({ id: 'p1' })], 'p1')).toBe('p1');
  });

  it('drops SILENTLY when the id no longer resolves', () => {
    expect(resolveProjectDefaultProfileId([profile({ id: 'p1' })], 'gone')).toBeNull();
  });

  it('is null when the project declares no default', () => {
    expect(resolveProjectDefaultProfileId([profile()], undefined)).toBeNull();
  });
});

describe('profileFormOverrides (FR-15/FR-18)', () => {
  it('is empty for no profile', () => {
    expect(profileFormOverrides(null)).toEqual({});
  });

  it('carries only the fields the profile declares', () => {
    const p = profile({ modelId: 'claude-sonnet-5', permissionMode: 'plan' });
    expect(profileFormOverrides(p)).toEqual({ modelId: 'claude-sonnet-5', permissionMode: 'plan' });
  });

  it('carries effort too when declared', () => {
    const p = profile({ effort: 'high' });
    expect(profileFormOverrides(p)).toEqual({ effort: 'high' });
  });
});

describe('projectDefaultProfileResolution (FR-21 vs palette FR-24 story 4)', () => {
  it('resolves the project default profile and its overrides when nothing is pending', () => {
    const p = profile({ id: 'p1', modelId: 'claude-sonnet-5' });
    expect(projectDefaultProfileResolution([p], 'p1', null)).toEqual({
      profileId: 'p1',
      overrides: { modelId: 'claude-sonnet-5' },
    });
  });

  it('falls back to no profile ("") when the project default no longer resolves', () => {
    expect(projectDefaultProfileResolution([profile({ id: 'p1' })], 'gone', null)).toEqual({
      profileId: '',
      overrides: {},
    });
  });

  it('is null (leave profileId alone) when a palette pick is pending, even with a project default', () => {
    const p = profile({ id: 'p1', modelId: 'claude-sonnet-5' });
    expect(projectDefaultProfileResolution([p], 'p1', 'p2')).toBeNull();
  });
});

describe('newSessionProfileOptions', () => {
  it('prepends the none row', () => {
    const opts = newSessionProfileOptions([profile({ id: 'p1', name: 'a' }), profile({ id: 'p2', name: 'b' })]);
    expect(opts).toEqual([
      { value: '', label: '— none —' },
      { value: 'p1', label: 'a' },
      { value: 'p2', label: 'b' },
    ]);
  });
});

describe('flagAdvisoryTokens (FR-10)', () => {
  it('is empty for no extra args', () => {
    expect(flagAdvisoryTokens(undefined)).toEqual([]);
    expect(flagAdvisoryTokens([])).toEqual([]);
  });

  it('picks out only the flag-shaped tokens, not their values', () => {
    expect(flagAdvisoryTokens(['--add-dir', '/tmp', '--foo'])).toEqual(['--add-dir', '--foo']);
  });
});

describe('profileArgDeniedDetail (FR-9)', () => {
  it('extracts flag + reason for PROFILE_ARG_DENIED', () => {
    const error: AppError = {
      code: 'PROFILE_ARG_DENIED',
      message: 'denied',
      detail: { flag: '--model', reason: 'model is set via the MODEL control' },
    };
    expect(profileArgDeniedDetail(error)).toEqual({ flag: '--model', reason: 'model is set via the MODEL control' });
  });

  it('is null for any other error code', () => {
    expect(profileArgDeniedDetail({ code: 'INVALID_INPUT', message: 'x' })).toBeNull();
  });

  it('is null when the detail shape is malformed', () => {
    expect(profileArgDeniedDetail({ code: 'PROFILE_ARG_DENIED', message: 'x' })).toBeNull();
    expect(profileArgDeniedDetail({ code: 'PROFILE_ARG_DENIED', message: 'x', detail: { flag: 1 } })).toBeNull();
  });
});

describe('isExtraArgsInvalidInput (§7 unterminated quote)', () => {
  it('is true for an unterminated-quote INVALID_INPUT', () => {
    expect(isExtraArgsInvalidInput({ code: 'INVALID_INPUT', message: 'extra args contain an unterminated quote' })).toBe(true);
  });

  it('is true for an over-cap extra args INVALID_INPUT', () => {
    expect(isExtraArgsInvalidInput({ code: 'INVALID_INPUT', message: 'extra args are too long' })).toBe(true);
  });

  it('is false for an INVALID_INPUT naming a different field', () => {
    expect(isExtraArgsInvalidInput({ code: 'INVALID_INPUT', message: 'the system prompt is too long' })).toBe(false);
    expect(isExtraArgsInvalidInput({ code: 'INVALID_INPUT', message: 'a profile name must be 1-60 characters' })).toBe(false);
  });

  it('is false for any other error code', () => {
    expect(isExtraArgsInvalidInput({ code: 'PROFILE_ARG_DENIED', message: 'extra args denied' })).toBe(false);
  });
});

describe('profileChipTitle (FR-17/FR-22)', () => {
  it('states the replace-mode consequence when true', () => {
    expect(profileChipTitle({ name: 'agent-architect', replacesSystemPrompt: true })).toBe(
      'agent-architect — replaces the system prompt',
    );
  });

  it('is just the name otherwise', () => {
    expect(profileChipTitle({ name: 'agent-architect', replacesSystemPrompt: false })).toBe('agent-architect');
  });
});

describe('canSaveProfileName (FR-3)', () => {
  it('rejects empty / whitespace-only names', () => {
    expect(canSaveProfileName('')).toBe(false);
    expect(canSaveProfileName('   ')).toBe(false);
  });

  it('rejects names over MAX_PROFILE_NAME', () => {
    expect(canSaveProfileName('a'.repeat(61))).toBe(false);
  });

  it('accepts a trimmed name within bounds', () => {
    expect(canSaveProfileName('agent-architect')).toBe(true);
    expect(canSaveProfileName('a'.repeat(60))).toBe(true);
  });
});

describe('removeProfileConfirmText (FR-22)', () => {
  it('names the profile and states sessions survive', () => {
    expect(removeProfileConfirmText('agent-architect')).toContain('agent-architect');
    expect(removeProfileConfirmText('agent-architect')).toContain('kept');
  });
});
