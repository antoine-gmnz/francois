// runtimeCapability (multi-provider-openai FR-20) — the one place src/ reads
// contract/multi-provider-seam's runtimeCapabilities() table for a session.
// Every disabled-pane consumer goes through sessionCapability, so no other
// component compares `agentRuntime`/`protocol` to a literal.

import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../contract/common';
import { sessionCapability } from './runtimeCapability';

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
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
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
});
