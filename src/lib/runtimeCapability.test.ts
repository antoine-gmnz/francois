// runtimeCapability (multi-provider-openai FR-20) — the one place src/ reads
// contract/multi-provider-seam's runtimeCapabilities() table for a session.
// Every disabled-pane consumer goes through sessionCapability, so no other
// component compares `agentRuntime`/`protocol` to a literal.

import { describe, expect, it } from 'vitest';
import type { RuntimeCapabilities, SessionMeta } from '../../contract/common';
import { PI_BASELINE_UNAVAILABLE, PI_UNRESTRICTED_TOOLS_NOTICE } from '../../contract/pi-skills-capabilities';
import { sandboxSelectionCapability, sessionCapability } from './runtimeCapability';

function meta(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: 's1',
    name: 'session',
    cwd: '/tmp',
    model: { id: 'sonnet', label: 'Sonnet' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 200_000,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    permissionModeSince: 0,
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    responseMode: 'default',
    allowGit: false,
    ...overrides,
  };
}

describe('sessionCapability (FR-20)', () => {
  it('reads available: true, no reason, for every capability on a claude-code session', () => {
    const claude = meta({ agentRuntime: 'claude-code' });
    expect(sessionCapability(claude, 'subagents')).toEqual({ available: true });
    expect(sessionCapability(claude, 'usageBar')).toEqual({ available: true });
    expect(sessionCapability(claude, 'interactiveCommands')).toEqual({ available: true });
  });

  it('reads the francois runtime reason verbatim for an unavailable capability', () => {
    const francois = meta({ agentRuntime: 'francois', protocol: 'openai' });
    expect(sessionCapability(francois, 'subagents')).toEqual({
      available: false,
      reason: "Subagents aren't available on this provider yet.",
    });
    expect(sessionCapability(francois, 'mcp').available).toBe(false);
  });

  it('gates skillsInstall separately from skills (FR-26)', () => {
    const francois = meta({ agentRuntime: 'francois', protocol: 'openai' });
    expect(sessionCapability(francois, 'skills')).toEqual({ available: true });
    expect(sessionCapability(francois, 'skillsInstall')).toEqual({
      available: false,
      reason: "Installing skills isn't available on this provider yet.",
    });
    const claude = meta({ agentRuntime: 'claude-code' });
    expect(sessionCapability(claude, 'skillsInstall')).toEqual({ available: true });
  });

  it('reads available: true with no session to check — nothing to gate yet', () => {
    expect(sessionCapability(null, 'mcp')).toEqual({ available: true });
    expect(sessionCapability(undefined, 'workflows')).toEqual({ available: true });
  });

  it('keys on the runtime alone, never the protocol', () => {
    // An 'anthropic' session run through the francois runtime (hypothetical) reads
    // identically to an 'openai' one — the seam's own FR-14a invariant, proven here
    // through the one call site every consumer shares.
    const a = meta({ agentRuntime: 'francois', protocol: 'anthropic' });
    const b = meta({ agentRuntime: 'francois', protocol: 'openai' });
    expect(sessionCapability(a, 'skills')).toEqual(sessionCapability(b, 'skills'));
  });

  it('lets a live core snapshot narrow a static capability without widening it', () => {
    const effective: RuntimeCapabilities = {
      ...Object.fromEntries(Object.keys({
        mcp: null, subagents: null, skills: null, skillsInstall: null, workflows: null,
        interactiveCommands: null, permissions: null, remoteControl: null, usageBar: null,
        compaction: null, steering: null, followUps: null, resumableSessions: null,
        modelSwitching: null, images: null, contextMetrics: null, costMetrics: null,
      }).map((key) => [key, { available: true }])) as RuntimeCapabilities,
      skills: { available: false, reason: 'Disabled by this model.' },
    };
    const pi = meta({ agentRuntime: 'pi', protocol: null, effectiveCapabilities: effective });
    expect(sessionCapability(pi, 'skills')).toEqual({ available: false, reason: 'Disabled by this model.' });
    expect(sessionCapability(pi, 'mcp')).toEqual({ available: true });
  });

  it('keeps a Pi session disabled until the core sends its live snapshot', () => {
    const pi = meta({ agentRuntime: 'pi', protocol: null });
    expect(sessionCapability(pi, 'steering')).toEqual({ available: false, reason: 'Runtime is not connected.' });
  });

  // pi-skills-capabilities FR-4/FR-3: nothing in the baseline the spec pins
  // (skillsInstall, mcp, subagents, workflows, permissions, remoteControl,
  // usageBar) is ever reachable for a Pi session — neither before the core's
  // live snapshot arrives (disconnected default) nor once it does (a
  // connected snapshot shaped exactly like FR-3's baseline).
  it('never lets a Pi session reach any PI_BASELINE_UNAVAILABLE capability, disconnected or connected', () => {
    const disconnected = meta({ agentRuntime: 'pi', protocol: null });
    for (const capability of PI_BASELINE_UNAVAILABLE) {
      expect(sessionCapability(disconnected, capability).available).toBe(false);
    }

    const connectedSnapshot: RuntimeCapabilities = {
      mcp: { available: false, reason: 'no' },
      subagents: { available: false, reason: 'no' },
      skills: { available: true },
      skillsInstall: { available: false, reason: 'no' },
      workflows: { available: false, reason: 'no' },
      interactiveCommands: { available: true },
      permissions: { available: false, reason: 'no' },
      remoteControl: { available: false, reason: 'no' },
      usageBar: { available: false, reason: 'no' },
      compaction: { available: true },
      steering: { available: true },
      followUps: { available: true },
      resumableSessions: { available: true },
      modelSwitching: { available: true },
      images: { available: true },
      contextMetrics: { available: true },
      costMetrics: { available: true },
    };
    const connected = meta({ agentRuntime: 'pi', protocol: null, effectiveCapabilities: connectedSnapshot });
    for (const capability of PI_BASELINE_UNAVAILABLE) {
      expect(sessionCapability(connected, capability).available).toBe(false);
    }
    // and skills — the one baseline capability the spec turns ON — stays reachable.
    expect(sessionCapability(connected, 'skills').available).toBe(true);
  });
});

describe('sandboxSelectionCapability (pi-skills-capabilities FR-5)', () => {
  it('reads available for every non-Pi runtime', () => {
    expect(sandboxSelectionCapability(meta({ agentRuntime: 'claude-code' }))).toEqual({ available: true });
    expect(sandboxSelectionCapability(meta({ agentRuntime: 'codex' }))).toEqual({ available: true });
    expect(sandboxSelectionCapability(null)).toEqual({ available: true });
  });

  it('reads the FR-5 notice verbatim for a Pi session — not a generic "unavailable" line', () => {
    expect(sandboxSelectionCapability(meta({ agentRuntime: 'pi' }))).toEqual({
      available: false,
      reason: PI_UNRESTRICTED_TOOLS_NOTICE,
    });
  });
});
