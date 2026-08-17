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
  'skillsInstall',
  'workflows',
  'interactiveCommands',
  'permissions',
  'remoteControl',
  'usageBar',
  'compaction',
];

const RUNTIMES: AgentRuntime[] = ['claude-code', 'francois', 'codex'];

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
      const expected = capability === 'skills' || capability === 'permissions';
      expect(caps[capability].available).toBe(expected);
    }
    expect(caps.skillsInstall.available).toBe(false);
  });

  // multi-provider-codex FR-16.
  it('makes nothing available on the codex runtime', () => {
    const caps = runtimeCapabilities('codex');
    for (const capability of CAPABILITIES) {
      expect(caps[capability].available).toBe(false);
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

  it('does not tell a codex session it bills per token instead of a plan (FR-16)', () => {
    // `codex login` authenticates against a ChatGPT PLAN, so the francois row's
    // usageBar reason would be factually wrong here. This is a gap, not a
    // property of the runtime — and the two rows must not converge by copy.
    const codex = runtimeCapabilities('codex').usageBar.reason!;
    const francois = runtimeCapabilities('francois').usageBar.reason!;
    expect(codex).not.toBe(francois);
    expect(codex).toMatch(/yet/);
    expect(codex).not.toMatch(/per token/);
  });

  // FR-14a: the table keys on the runtime alone. `protocol` is not a key here —
  // a francois-runtime session has the same gaps whichever dialect it speaks.
  it('keys on the runtime, not the protocol', () => {
    expect(runtimeCapabilities('francois')).toBe(runtimeCapabilities('francois'));
  });
});
