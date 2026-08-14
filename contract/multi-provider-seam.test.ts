import { describe, it, expect } from 'vitest';
import { providerCapabilities } from './multi-provider-seam';
import type { ProviderCapability } from './multi-provider-seam';
import type { SessionProvider } from './common';

// The two lists the table must stay exhaustive over. Written out rather than
// derived from the table itself — a test that reads its keys back off the thing
// under test would pass no matter which member went missing.
const CAPABILITIES: ProviderCapability[] = [
  'mcp',
  'subagents',
  'skills',
  'workflows',
  'interactiveCommands',
  'remoteControl',
  'usageBar',
  'compaction',
];

const PROVIDERS: SessionProvider[] = ['claude-code', 'openai-compatible'];

describe('providerCapabilities', () => {
  it('answers for every provider', () => {
    for (const provider of PROVIDERS) {
      expect(providerCapabilities(provider)).toBeTruthy();
    }
  });

  it('is exhaustive over ProviderCapability for both providers (FR-15)', () => {
    for (const provider of PROVIDERS) {
      const caps = providerCapabilities(provider);
      expect(Object.keys(caps).sort()).toEqual([...CAPABILITIES].sort());
      for (const capability of CAPABILITIES) {
        expect(typeof caps[capability].available).toBe('boolean');
      }
    }
  });

  it('carries a reason iff the capability is unavailable (FR-14)', () => {
    for (const provider of PROVIDERS) {
      const caps = providerCapabilities(provider);
      for (const capability of CAPABILITIES) {
        const state = caps[capability];
        if (state.available) {
          expect(state.reason).toBeUndefined();
        } else {
          expect(state.reason).toBeTruthy();
          expect(state.reason!.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('makes everything available on claude-code', () => {
    const caps = providerCapabilities('claude-code');
    for (const capability of CAPABILITIES) {
      expect(caps[capability].available).toBe(true);
    }
  });

  it('makes nothing available on openai-compatible yet', () => {
    const caps = providerCapabilities('openai-compatible');
    for (const capability of CAPABILITIES) {
      expect(caps[capability].available).toBe(false);
    }
  });
});
