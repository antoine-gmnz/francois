import { describe, expect, it } from 'vitest';
import type { SessionRetry } from '../../../contract/common';
import { activeRetry, retryCountdown, retryLabel, retrySubLine } from './retry-status';

const retry: SessionRetry = { attempt: 2, maxRetries: 10, errorStatus: 429, error: 'rate_limit', retryAt: 10_000, since: 6_000 };

describe('retry status (audit C4)', () => {
  it('reads attempt, budget, status and the countdown', () => {
    expect(retryLabel(retry, 6_000)).toBe('Retrying · attempt 2/10 · 429 · in 4s');
    expect(retryLabel(retry, 9_500)).toBe('Retrying · attempt 2/10 · 429 · in 1s');
    expect(retryLabel(retry, 12_000)).toBe('Retrying · attempt 2/10 · 429 · now');
  });

  it('falls back to the CLI category and omits what was not reported', () => {
    expect(retryLabel({ attempt: 1, error: 'server_error', since: 0 }, 0)).toBe('Retrying · attempt 1 · server error');
    expect(retryLabel({ attempt: 3, since: 0 }, 0)).toBe('Retrying · attempt 3');
  });

  it('formats a long delay in minutes', () => {
    expect(retryCountdown({ attempt: 1, retryAt: 95_000, since: 0 }, 0)).toBe(95);
    expect(retryLabel({ attempt: 1, retryAt: 95_000, since: 0 }, 0)).toBe('Retrying · attempt 1 · in 1m 35s');
    expect(retryCountdown({ attempt: 1, since: 0 }, 0)).toBeNull();
  });

  it('only counts while the turn is live', () => {
    expect(activeRetry({ status: 'running', retry })).toBe(retry);
    expect(activeRetry({ status: 'idle', retry })).toBeNull();
    expect(activeRetry({ status: 'error', retry })).toBeNull();
    expect(activeRetry({ status: 'running' })).toBeNull();
  });

  it('the roster line is lower-case', () => {
    expect(retrySubLine(retry, 6_000)).toBe('retrying · attempt 2/10 · 429 · in 4s');
  });
});
