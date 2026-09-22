// runtimeCapability (multi-provider-openai FR-20) — the one place src/ reads
// contract/multi-provider-seam's runtimeCapabilities() table for a session.
// Every disabled-pane consumer goes through sessionCapability, so no other
// component compares `agentRuntime`/`protocol` to a literal.

import { describe, expect, it } from 'vitest';
import type { RuntimeCapabilities, SessionMeta } from '../../contract/common';
import { runtimeCapabilities } from '../../contract/multi-provider-seam';
import type { SessionProfile } from '../../contract/session-profiles';
import {
  PI_UNAVAILABLE,
  accountIsRetired,
  profileIsRetired,
  requestNeedsLiveGeneration,
  sandboxSelectionCapability,
  sessionCapability,
  sessionIsRetired,
} from './runtimeCapability';
const PI_BASELINE_UNAVAILABLE = Object.keys(runtimeCapabilities('pi')) as (keyof RuntimeCapabilities)[];

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
    expect(sessionCapability(pi, 'skills')).toEqual({ available: false, reason: PI_UNAVAILABLE });
    // `steering`, not `mcp`: outside the FR-3 clamp, Pi's static row is a
    // DISCONNECTED placeholder rather than a ceiling, so the connected
    // snapshot is what grants the capability.
    expect(sessionCapability(pi, 'steering')).toEqual({ available: false, reason: PI_UNAVAILABLE });
  });

  it('keeps a Pi session disabled until the core sends its live snapshot', () => {
    const pi = meta({ agentRuntime: 'pi', protocol: null });
    expect(sessionCapability(pi, 'steering')).toEqual({ available: false, reason: PI_UNAVAILABLE });
  });

  // pi-skills-capabilities FR-4/FR-3: nothing in the baseline the spec pins
  // (skillsInstall, mcp, subagents, workflows, permissions, remoteControl,
  // usageBar) is ever reachable for a Pi session — neither before the core's
  // live snapshot arrives (disconnected default) nor once it does.
  //
  // The snapshot below claims ALL of them, which is the only shape that makes
  // this a test of the clamp rather than of the fixture: pi-runtime-boundary
  // FR-4 lets a live snapshot NARROW the static table, never widen it, and Pi
  // is the one runtime whose static row is a disconnected placeholder rather
  // than a ceiling — so without the clamp the frontend would hand a Pi session
  // whatever an incomplete, optimistic or future core snapshot asserted.
  it('clamps a Pi session away from every PI_BASELINE_UNAVAILABLE capability even when the live snapshot claims it', () => {
    const disconnected = meta({ agentRuntime: 'pi', protocol: null });
    for (const capability of PI_BASELINE_UNAVAILABLE) {
      expect(sessionCapability(disconnected, capability).available).toBe(false);
    }

    const claimsEverything = Object.fromEntries(
      (
        [
          'mcp', 'subagents', 'skills', 'skillsInstall', 'workflows', 'interactiveCommands',
          'permissions', 'remoteControl', 'usageBar', 'compaction', 'steering', 'followUps',
          'resumableSessions', 'modelSwitching', 'images', 'contextMetrics', 'costMetrics',
        ] as const
      ).map((key) => [key, { available: true }]),
    ) as RuntimeCapabilities;
    const connected = meta({ agentRuntime: 'pi', protocol: null, effectiveCapabilities: claimsEverything });
    for (const capability of PI_BASELINE_UNAVAILABLE) {
      const state = sessionCapability(connected, capability);
      expect(state.available).toBe(false);
      // FR-4: "Disabled actions give a reason" — a clamped one is no exception.
      // `CapabilityState` is a flat interface (`reason` is optional, not tied
      // to `available` by a discriminated union), so `available === false`
      // narrows nothing about `reason` — check it directly instead.
      expect((state.reason?.length ?? 0) > 0).toBe(true);
    }
    // and skills — the one baseline capability the spec turns ON — stays reachable.
    expect(sessionCapability(connected, 'skills').available).toBe(false);
    // …as does everything outside the clamped list, which the snapshot still owns.
    expect(sessionCapability(connected, 'steering')).toEqual({ available: false, reason: PI_UNAVAILABLE });
  });

  // A snapshot that narrows a clamped capability keeps its OWN sentence — the
  // core knows why (auth, config, model) and the clamp does not.
  it('prefers the core’s reason over the clamp’s when the snapshot already disables the capability', () => {
    const snapshot = {
      mcp: { available: false, reason: PI_UNAVAILABLE },
    } as unknown as RuntimeCapabilities;
    const pi = meta({ agentRuntime: 'pi', protocol: null, effectiveCapabilities: snapshot });
    expect(sessionCapability(pi, 'mcp')).toEqual({
      available: false,
      reason: PI_UNAVAILABLE,
    });
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
      reason: PI_UNAVAILABLE,
    });
  });
});


it('enables Codex request replies only from a negotiated generation snapshot', () => {
  const native = { agentRuntime: 'codex', effectiveCapabilities: { ...runtimeCapabilities('codex'), permissions: { available: true } } } as import('../../contract/common').SessionMeta;
  expect(sessionCapability(native, 'permissions').available).toBe(false);
  expect(sessionCapability({ ...native, runtimeGeneration: 'live' }, 'permissions').available).toBe(true);
  expect(sessionCapability({ ...native, runtimeGeneration: 'live', effectiveCapabilities: undefined }, 'permissions').available).toBe(false);
  expect(sessionCapability({ ...native, runtimeGeneration: 'live', effectiveCapabilities: { ...native.effectiveCapabilities!, permissions: { available: false, reason: 'Disconnected' } } }, 'permissions')).toEqual({ available: false, reason: 'Disconnected' });
  expect(sessionCapability({ ...native, agentRuntime: 'pi', runtimeGeneration: 'live' }, 'permissions').available).toBe(false);
});

// process-frontend-boundaries: the retired-runtime and live-request predicates
// are the ONE mapping from runtime/kind names to UI behaviour — components and
// stores ask these instead of comparing `agentRuntime`/`kind` to a literal.
describe('runtime-name mapping predicates (process-frontend-boundaries)', () => {
  it('marks only retired Pi sessions read-only', () => {
    expect(sessionIsRetired(meta({ agentRuntime: 'pi' }))).toBe(true);
    for (const agentRuntime of ['claude-code', 'codex', 'grok', 'francois'] as const) {
      expect(sessionIsRetired(meta({ agentRuntime }))).toBe(false);
    }
    expect(sessionIsRetired(null)).toBe(false);
    expect(sessionIsRetired(undefined)).toBe(false);
  });

  it('marks only retired Pi accounts and profiles, narrowing the profile union', () => {
    expect(accountIsRetired({ kind: 'pi' })).toBe(true);
    expect(accountIsRetired({ kind: 'claude-code-oauth' })).toBe(false);
    expect(accountIsRetired({ kind: 'codex-cli' })).toBe(false);
    expect(accountIsRetired(null)).toBe(false);
    const pi: SessionProfile = { kind: 'pi', settings: { tools: [] } } as unknown as SessionProfile;
    const legacy = { kind: 'legacy', name: 'x' } as unknown as SessionProfile;
    expect(profileIsRetired(pi)).toBe(true);
    expect(profileIsRetired(legacy)).toBe(false);
    expect(profileIsRetired(undefined)).toBe(false);
    if (profileIsRetired(pi)) expect(pi.settings.tools).toEqual([]);
  });

  it('derives live-generation request authority from the capability table, not a runtime name', () => {
    expect(requestNeedsLiveGeneration(meta({ agentRuntime: 'codex' }))).toBe(true);
    for (const agentRuntime of ['claude-code', 'grok', 'francois', 'pi'] as const) {
      expect(requestNeedsLiveGeneration(meta({ agentRuntime }))).toBe(false);
    }
    expect(requestNeedsLiveGeneration(null)).toBe(false);
  });
});
