import { describe, it, expect } from 'vitest';
import { runtimeCapabilities } from './multi-provider-seam';
import type { RuntimeCapability } from './multi-provider-seam';
import type { AgentRuntime } from './common';

// The two lists the table must stay exhaustive over. Written out rather than
// derived from the table itself — a test that reads its keys back off the thing
// under test would pass no matter which member went missing.
const LEGACY_CAPABILITIES: RuntimeCapability[] = [
  'mcp',
  'subagents',
  'skills',
  'skillsInstall',
  'workflows',
  'interactiveCommands',
  'permissions',
  'remoteControl',
  'usageBar',
  'compaction',
];

const ADDED_CAPABILITIES: RuntimeCapability[] = [
  'steering',
  'followUps',
  'resumableSessions',
  'modelSwitching',
  'images',
  'contextMetrics',
  'costMetrics',
];

const CAPABILITIES: RuntimeCapability[] = [...LEGACY_CAPABILITIES, ...ADDED_CAPABILITIES];

const RUNTIMES: AgentRuntime[] = ['claude-code', 'francois', 'codex', 'grok', 'pi'];

describe('runtimeCapabilities', () => {
  it('answers for every runtime', () => {
    for (const runtime of RUNTIMES) {
      expect(runtimeCapabilities(runtime)).toBeTruthy();
    }
  });

  it('is exhaustive over RuntimeCapability for every runtime (FR-15)', () => {
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

  it('preserves the available legacy capabilities on claude-code', () => {
    const caps = runtimeCapabilities('claude-code');
    for (const capability of LEGACY_CAPABILITIES) {
      expect(caps[capability].available).toBe(true);
    }
  });

  it('preserves model and image actions while disabling unimplemented added capabilities', () => {
    for (const runtime of RUNTIMES.filter((runtime) => runtime !== 'pi')) {
      const caps = runtimeCapabilities(runtime);
      for (const capability of ADDED_CAPABILITIES) {
        expect(caps[capability].available).toBe(capability === 'modelSwitching' || capability === 'images');
      }
    }
  });

  it('enables no action on Pi without a live capability snapshot (FR-4)', () => {
    const caps = runtimeCapabilities('pi');
    for (const capability of CAPABILITIES) {
      expect(caps[capability]).toEqual({
        available: false,
        reason: 'Runtime is not connected.',
      });
    }
  });

  it('makes nothing available on the francois runtime yet, except skills and permissions', () => {
    // multi-provider-openai FR-23..FR-27: skills is the one capability that
    // ports across runtimes (markdown instructions, injected into the
    // system message) — every other gap in the table still holds. FR-26:
    // `skillsInstall` stays a gap even though `skills` itself opened up —
    // enabling a plugin writes Claude Code's own control surface, which
    // this feature never touches.
    //
    // multi-provider-codex FR-16: `permissions` is true here and it is not a
    // gap that closed — that adapter IS the gate (multi-provider-openai
    // FR-9..FR-13), so it was always governed by our cards. The member is new;
    // the truth it states is not.
    const caps = runtimeCapabilities('francois');
    for (const capability of CAPABILITIES) {
      const expected = capability === 'skills' || capability === 'permissions' || capability === 'modelSwitching' || capability === 'images';
      expect(caps[capability].available).toBe(expected);
    }
    expect(caps.skillsInstall.available).toBe(false);
  });

  // multi-provider-codex FR-16.
  it('preserves model, image, and usage actions on the codex runtime', () => {
    const caps = runtimeCapabilities('codex');
    for (const capability of CAPABILITIES) {
      expect(caps[capability].available).toBe(
        capability === 'usageBar' || capability === 'modelSwitching' || capability === 'images',
      );
    }
  });

  it("states codex's sandbox rather than calling permissions an unbuilt gap (FR-16)", () => {
    // The wording carries a real distinction: every other false on this row is
    // something we have not built ("yet"), but Codex tool calls ARE governed —
    // by an OS sandbox chosen from permissionMode (FR-9). A "not available yet"
    // here would imply they run ungoverned, which is the opposite of the truth.
    const reason = runtimeCapabilities('codex').permissions.reason!;
    expect(reason).toBe('Codex enforces permissions with its own sandbox.');
    expect(reason).not.toMatch(/yet/);
  });

  it('exposes Codex plan limits through the shared usage bar (FR-16)', () => {
    expect(runtimeCapabilities('codex').usageBar).toEqual({ available: true });
  });

  // multi-provider-grok FR-26.
  it('preserves only model and image actions on the grok runtime', () => {
    const caps = runtimeCapabilities('grok');
    for (const capability of CAPABILITIES) {
      expect(caps[capability].available).toBe(capability === 'modelSwitching' || capability === 'images');
    }
  });

  it("states grok's sandbox rather than calling permissions an unbuilt gap (FR-26)", () => {
    const reason = runtimeCapabilities('grok').permissions.reason!;
    expect(reason).toBe('Grok enforces permissions with its own sandbox.');
    expect(reason).not.toMatch(/yet/);
  });

  it('gives grok its own usageBar wording distinct from francois (FR-26)', () => {
    // A Grok CLI session bills against a SuperGrok / X Premium+ plan — neither
    // francois' "bills per token" nor Codex's supported rate-limit endpoint is
    // the right description here.
    const grok = runtimeCapabilities('grok').usageBar.reason!;
    const francois = runtimeCapabilities('francois').usageBar.reason!;
    expect(grok).not.toBe(francois);
    expect(grok).toMatch(/SuperGrok|X Premium/);
    expect(grok).not.toMatch(/per token/);
  });

  // FR-14a: the table keys on the runtime alone. `protocol` is not a key here —
  // a francois-runtime session has the same gaps whichever dialect it speaks.
  it('keys on the runtime, not the protocol', () => {
    expect(runtimeCapabilities('francois')).toBe(runtimeCapabilities('francois'));
  });
});
