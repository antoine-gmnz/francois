import { describe, expect, it } from 'vitest';
import type { PiSessionProfile, SessionProfile } from '../../../contract/session-profiles';
import {
  DEFAULT_PI_RESOURCE_POLICY,
  resourcePolicyFor,
  seedProjectResources,
} from './pi-resource-policy';

const piProfile = (projectResources: 'ignore' | 'allow'): PiSessionProfile => ({
  id: 'p1',
  name: 'pi profile',
  kind: 'pi',
  settings: {
    systemPromptMode: 'default',
    instructionPaths: [],
    skillPaths: [],
    tools: [],
    projectResources,
  },
  createdAt: 0,
  updatedAt: 0,
});

const legacyProfile: SessionProfile = {
  id: 'p2',
  name: 'legacy',
  kind: 'legacy',
  createdAt: 0,
  updatedAt: 0,
};

describe('DEFAULT_PI_RESOURCE_POLICY (FR-7)', () => {
  it('starts ignored, extensions disabled, unacknowledged — the safe default', () => {
    expect(DEFAULT_PI_RESOURCE_POLICY).toEqual({
      projectResources: 'ignore',
      extensions: 'disabled',
      acknowledgedUnrestrictedTools: false,
    });
  });
});

describe('seedProjectResources (session-profiles FR-16 seeding, never the acknowledgment)', () => {
  it('seeds ignore with no profile selected', () => {
    expect(seedProjectResources(null)).toBe('ignore');
    expect(seedProjectResources(undefined)).toBe('ignore');
  });

  it('seeds from a Pi profile’s own projectResources choice', () => {
    expect(seedProjectResources(piProfile('allow'))).toBe('allow');
    expect(seedProjectResources(piProfile('ignore'))).toBe('ignore');
  });

  it('ignores a legacy (non-Pi) profile — it carries no projectResources at all', () => {
    expect(seedProjectResources(legacyProfile)).toBe('ignore');
  });
});

describe('resourcePolicyFor (FR-5/FR-7)', () => {
  it('builds the exact RuntimeResourcePolicy shape, extensions always disabled', () => {
    expect(resourcePolicyFor('allow', true)).toEqual({
      projectResources: 'allow',
      extensions: 'disabled',
      acknowledgedUnrestrictedTools: true,
    });
    expect(resourcePolicyFor('ignore', false)).toEqual({
      projectResources: 'ignore',
      extensions: 'disabled',
      acknowledgedUnrestrictedTools: false,
    });
  });
});
