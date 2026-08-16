import { describe, it, expect } from 'vitest';
import { runtimeCapabilities } from './multi-provider-seam';
import type { RuntimeCapability } from './multi-provider-seam';
import type { AgentRuntime } from './common';

// The two lists the table must stay exhaustive over. Written out rather than
// derived from the table itself — a test that reads its keys back off the thing
// under test would pass no matter which member went missing.
const CAPABILITIES: RuntimeCapability[] = [
  'mcp',
  'subagents',
  'skills',
  'workflows',
  'interactiveCommands',
  'remoteControl',
  'usageBar',
  'compaction',
];

const RUNTIMES: AgentRuntime[] = ['claude-code', 'francois'];

describe('runtimeCapabilities', () => {
  it('answers for every runtime', () => {
    for (const runtime of RUNTIMES) {
      expect(runtimeCapabilities(runtime)).toBeTruthy();
    }
  });

  it('is exhaustive over RuntimeCapability for both runtimes (FR-15)', () => {
    for (const runtime of RUNTIMES) {
      const caps = runtimeCapabilities(runtime);
      expect(Object.keys(caps).sort()).toEqual([...CAPABILITIES].sort());
      for (const capability of CAPABILITIES) {
        expect(typeof caps[capability].available).toBe('boolean');
      }
    }
  });

  it('carries a reason iff the capability is unavailable (FR-14)', () => {
    for (const runtime of RUNTIMES) {
      const caps = runtimeCapabilities(runtime);
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
    const caps = runtimeCapabilities('claude-code');
    for (const capability of CAPABILITIES) {
      expect(caps[capability].available).toBe(true);
    }
  });

  it('makes nothing available on the francois runtime yet, except skills', () => {
    // multi-provider-openai FR-23..FR-27: skills is the one capability that
    // ports across runtimes (markdown instructions, injected into the
    // system message) — every other gap in the table still holds.
    const caps = runtimeCapabilities('francois');
    for (const capability of CAPABILITIES) {
      const expected = capability === 'skills';
      expect(caps[capability].available).toBe(expected);
    }
  });

  // FR-14a: the table keys on the runtime alone. `protocol` is not a key here —
  // a francois-runtime session has the same gaps whichever dialect it speaks.
  it('keys on the runtime, not the protocol', () => {
    expect(runtimeCapabilities('francois')).toBe(runtimeCapabilities('francois'));
  });
});
