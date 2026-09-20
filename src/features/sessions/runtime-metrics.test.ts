import { describe, expect, it, vi } from 'vitest';
import type { RuntimeMetrics, SessionMeta } from '../../../contract/common';
import {
  UNKNOWN_METRIC,
  contextReadout,
  costReadout,
  formatMetricTokens,
  formatUsd,
  modelSwitchUnavailableReason,
  piModelSwitchBlockedReason,
  submitModelSwitch,
} from './runtime-metrics';

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
    const s = session({ effectiveCapabilities: { modelSwitching: { available: true } } as never });
    expect(modelSwitchUnavailableReason(s)).toBeNull();
  });

  it('surfaces the core-supplied reason when one narrows the capability', () => {
    const s = session({ effectiveCapabilities: { modelSwitching: { available: false, reason: 'Compaction is running.' } } as never });
    expect(modelSwitchUnavailableReason(s)).toBe('Compaction is running.');
  });

  it('falls back to the spec copy before any live snapshot has landed', () => {
    // No effectiveCapabilities at all — Pi's baseline ("Runtime is not connected.")
    // still carries a reason, so this exercises the ?? fallback via a capability
    // state that narrows availability without saying why.
    const s = session({ effectiveCapabilities: { modelSwitching: { available: false } } as never });
    expect(modelSwitchUnavailableReason(s)).toBe('Available when this run finishes.');
  });
});

describe('piModelSwitchBlockedReason (FR-5, the run chip live switch)', () => {
  it('blocks on a busy session status even when the capability table has not caught up', () => {
    const s = session({ status: 'running', effectiveCapabilities: { modelSwitching: { available: true } } as never });
    expect(piModelSwitchBlockedReason(s)).toBe('Available when this run finishes.');
  });

  it('falls through to the core-reported reason once the session is settled', () => {
    const s = session({
      status: 'idle',
      effectiveCapabilities: { modelSwitching: { available: false, reason: 'Compaction is running.' } } as never,
    });
    expect(piModelSwitchBlockedReason(s)).toBe('Compaction is running.');
  });

  it('is null when idle and the capability is available', () => {
    const s = session({ status: 'idle', effectiveCapabilities: { modelSwitching: { available: true } } as never });
    expect(piModelSwitchBlockedReason(s)).toBeNull();
  });
});

describe('submitModelSwitch (PiRunModelSwitch, unmount-guard extraction)', () => {
  function harness() {
    return { setSwitching: vi.fn(), setError: vi.fn(), schedule: vi.fn() };
  }

  it('marks switching, clears any stale error, then clears switching again on success', async () => {
    const h = harness();
    const res = await submitModelSwitch({ call: () => Promise.resolve({ ok: true, data: {} as never }), ...h });
    expect(h.setSwitching).toHaveBeenNthCalledWith(1, true);
    expect(h.setError).toHaveBeenNthCalledWith(1, null);
    expect(h.setSwitching).toHaveBeenNthCalledWith(2, false);
    expect(h.setError).toHaveBeenCalledTimes(1); // no failure to show
    expect(h.schedule).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, data: {} });
  });

  it('clears switching AND surfaces the message on a domain failure, scheduling its auto-clear', async () => {
    const h = harness();
    await submitModelSwitch({
      call: () => Promise.resolve({ ok: false, error: { code: 'RUNTIME_UNAVAILABLE', message: 'Pi is not connected' } }),
      ...h,
    });
    expect(h.setSwitching).toHaveBeenLastCalledWith(false);
    expect(h.setError).toHaveBeenLastCalledWith('Pi is not connected');
    expect(h.schedule).toHaveBeenCalledWith(expect.any(Function), 4000);
  });
});
