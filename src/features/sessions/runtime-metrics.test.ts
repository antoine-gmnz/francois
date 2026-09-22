import { describe, expect, it } from 'vitest';
import type { RuntimeMetrics, SessionMeta } from '../../../contract/common';
import {
    UNKNOWN_METRIC,
    contextReadout,
    costReadout,
    formatMetricTokens,
    formatUsd,
    modelSwitchUnavailableReason
} from './runtime-metrics';
import { runtimeCapabilities } from '../../../contract/multi-provider-seam';
import { CAPABILITY_INVALID } from '../../lib/runtimeCapability';

function metrics(over: Partial<RuntimeMetrics> = {}): RuntimeMetrics {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    contextTokens: null,
    contextWindow: null,
    contextBasis: 'unknown',
    costUsd: null,
    costBasis: 'unknown',
    measuredAt: 0,
    stale: false,
    ...over,
  };
}

function session(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    name: 's1',
    cwd: '/repo',
    model: { id: 'm', label: 'M' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    permissionModeSince: 0,
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'pi',
    protocol: null,
    responseMode: 'default',
    allowGit: false,
    ...over,
  } as SessionMeta;
}

describe('formatMetricTokens', () => {
  it('is an em dash for an unknown counter, never 0', () => {
    expect(formatMetricTokens(null)).toBe(UNKNOWN_METRIC);
  });

  it('formats a known counter compactly', () => {
    expect(formatMetricTokens(84_200)).toBe('84.2K');
    expect(formatMetricTokens(0)).toBe('0');
  });
});

describe('contextReadout (FR-7)', () => {
  it('is null when either half is unknown — never a false empty/full bar', () => {
    expect(contextReadout(undefined)).toBeNull();
    expect(contextReadout(metrics({ contextTokens: null, contextWindow: 200_000 }))).toBeNull();
    expect(contextReadout(metrics({ contextTokens: 1_000, contextWindow: null }))).toBeNull();
  });

  it('is null when the runtime reports a non-positive window — nothing to divide by', () => {
    expect(contextReadout(metrics({ contextTokens: 1_000, contextWindow: 0 }))).toBeNull();
  });

  it('divides tokens/window and formats the compact label', () => {
    const readout = contextReadout(metrics({ contextTokens: 84_200, contextWindow: 200_000, contextBasis: 'reported' }));
    expect(readout).toEqual({ fraction: 0.421, label: '84.2K/200K', basis: 'reported' });
  });

  it('clamps an over-full window to 1', () => {
    expect(contextReadout(metrics({ contextTokens: 400_000, contextWindow: 200_000 }))?.fraction).toBe(1);
  });

  it('never uses the four cumulative counters as a substitute for contextTokens', () => {
    // A session with heavy cumulative usage but no reported CURRENT occupancy —
    // still null, never the sum of inputTokens/outputTokens/cache*.
    const m = metrics({ inputTokens: 500_000, outputTokens: 50_000, cacheReadTokens: 10_000, contextTokens: null, contextWindow: 200_000 });
    expect(contextReadout(m)).toBeNull();
  });
});

describe('formatUsd', () => {
  it('shows $0.00 for an exact zero', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('keeps four decimals for sub-cent amounts so they do not round to $0.00', () => {
    expect(formatUsd(0.0042)).toBe('$0.0042');
  });

  it('uses two decimals once the amount clears a cent', () => {
    expect(formatUsd(1.2)).toBe('$1.20');
  });
});

describe('costReadout (FR-8)', () => {
  it('is an em dash when the basis is unknown, even if a stray number is present', () => {
    expect(costReadout(undefined)).toBe(UNKNOWN_METRIC);
    expect(costReadout(metrics({ costBasis: 'unknown', costUsd: 0.5 }))).toBe(UNKNOWN_METRIC);
  });

  it('never reads zero pricing as free execution — still "estimated"', () => {
    expect(costReadout(metrics({ costBasis: 'estimated', costUsd: 0 }))).toBe('$0.00 est.');
  });

  it('formats an estimated cost', () => {
    expect(costReadout(metrics({ costBasis: 'estimated', costUsd: 0.0042 }))).toBe('$0.0042 est.');
    expect(costReadout(metrics({ costBasis: 'estimated', costUsd: 1.2 }))).toBe('$1.20 est.');
  });
});

describe('modelSwitchUnavailableReason (FR-5)', () => {
  it('is null once the core reports the session CAN switch', () => {
    // Pi's static fallback is fully disabled until it connects (multi-provider-seam) —
    // a live snapshot saying otherwise is what turns the picker on.
    const s = session({ agentRuntime: 'claude-code', effectiveCapabilities: { ...runtimeCapabilities('claude-code'), modelSwitching: { available: true } } });
    expect(modelSwitchUnavailableReason(s)).toBeNull();
  });

  it('surfaces the core-supplied reason when one narrows the capability', () => {
    const s = session({ agentRuntime: 'claude-code', effectiveCapabilities: { ...runtimeCapabilities('claude-code'), modelSwitching: { available: false, reason: 'Compaction is running.' } } });
    expect(modelSwitchUnavailableReason(s)).toBe('Compaction is running.');
  });

  it('reads an incomplete snapshot as an invalid report, never as switchable', () => {
    // process-native-capabilities FR-6: the core guard rejects a snapshot that
    // lacks a key or a reason; the picker agrees rather than guessing.
    const s = session({ agentRuntime: 'claude-code', effectiveCapabilities: { modelSwitching: { available: false } } as never });
    expect(modelSwitchUnavailableReason(s)).toBe(CAPABILITY_INVALID);
  });
});
