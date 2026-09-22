// process-native-capabilities FR-6/AC-1: the frontend selector agrees with the
// core guard (src-tauri/src/session/adapter/capabilities.rs) for every key,
// runtime and snapshot state — both read the same expected matrix.
import { describe, expect, it } from 'vitest';
import type { AgentRuntime, RuntimeCapabilities, RuntimeCapability, SessionMeta } from '../../contract/common';
import matrix from '../../src-tauri/src/session/adapter/capability-matrix.json';
import { runtimeCapabilities } from '../../contract/multi-provider-seam';
import { CAPABILITY_DISCONNECTED, CAPABILITY_INVALID, sessionCapability } from './runtimeCapability';

const KEYS = Object.keys(runtimeCapabilities('claude-code')) as RuntimeCapability[];

function snapshot(available: boolean): RuntimeCapabilities {
  return Object.fromEntries(
    KEYS.map((key) => [key, available ? { available } : { available, reason: 'Disabled' }]),
  ) as RuntimeCapabilities;
}

function scenario(name: string): Pick<SessionMeta, 'effectiveCapabilities' | 'runtimeGeneration'> {
  switch (name) {
    case 'none':
      return {};
    case 'live-all':
      return { effectiveCapabilities: snapshot(true), runtimeGeneration: 'g1' };
    case 'live-none':
      return { effectiveCapabilities: snapshot(false), runtimeGeneration: 'g1' };
    case 'invalid': {
      const caps: Partial<RuntimeCapabilities> = { ...snapshot(true) };
      delete caps.costMetrics;
      return { effectiveCapabilities: caps as RuntimeCapabilities, runtimeGeneration: 'g1' };
    }
    case 'stale-all':
      return { effectiveCapabilities: snapshot(true) };
    default:
      throw new Error(`unknown scenario ${name}`);
  }
}

function meta(agentRuntime: AgentRuntime, extra: Partial<SessionMeta>): SessionMeta {
  return {
    id: 's1', name: 'session', cwd: '/tmp', model: { id: 'm', label: 'M' }, status: 'running',
    contextUsedTokens: 0, contextLimitTokens: 1, startedAt: 0, lastActivityAt: 0,
    permissionMode: 'default', permissionModeSince: 0, runtime: 'native', accountId: 'default',
    agentRuntime, protocol: agentRuntime === 'claude-code' ? 'anthropic' : 'openai',
    responseMode: 'default', allowGit: false, ...extra,
  };
}

describe('sessionCapability agrees with the core guard matrix', () => {
  const cases = matrix.cases as Record<AgentRuntime, Record<string, string[]>>;

  it('covers every runtime and five snapshot states', () => {
    expect(Object.keys(cases).sort()).toEqual(['claude-code', 'codex', 'francois', 'grok', 'pi']);
    for (const scenarios of Object.values(cases)) expect(Object.keys(scenarios)).toHaveLength(5);
  });

  for (const [runtime, scenarios] of Object.entries(cases) as [AgentRuntime, Record<string, string[]>][]) {
    for (const [name, expected] of Object.entries(scenarios)) {
      it(`${runtime} / ${name}`, () => {
        const session = meta(runtime, scenario(name));
        for (const key of KEYS) {
          const state = sessionCapability(session, key);
          expect(state.available, key).toBe(expected.includes(key));
          // CapabilityState: `reason` is present iff `available` is false.
          expect(state.available ? state.reason : (state.reason?.length ?? 0) > 0, key).toBe(state.available ? undefined : true);
        }
      });
    }
  }

  it('names a disconnected supported control apart from an unsupported one', () => {
    const codex = meta('codex', {});
    expect(sessionCapability(codex, 'permissions')).toEqual({ available: false, reason: CAPABILITY_DISCONNECTED });
    expect(sessionCapability(codex, 'mcp')).toEqual(runtimeCapabilities('codex').mcp);
    expect(sessionCapability(meta('claude-code', scenario('invalid')), 'mcp')).toEqual({ available: false, reason: CAPABILITY_INVALID });
  });

  it('rejects an unsafe reason in a live snapshot as invalid', () => {
    const caps = { ...snapshot(true), steering: { available: false, reason: 'line\nbreak' } };
    const session = meta('claude-code', { effectiveCapabilities: caps, runtimeGeneration: 'g1' });
    expect(sessionCapability(session, 'mcp')).toEqual({ available: false, reason: CAPABILITY_INVALID });
  });
});
