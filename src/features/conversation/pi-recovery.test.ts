import { describe, expect, it, vi } from 'vitest';
import type { RuntimeRecovery } from '../../../contract/common';
import { isBlockingRecovery, recoveryCauseText, submitRecoveryAction } from './pi-recovery';

describe('isBlockingRecovery', () => {
  it.each<RuntimeRecovery['state']>(['missing', 'corrupt', 'incompatible', 'account-missing'])(
    'is true for %s (FR-3 refuses automatic resume)',
    (state) => {
      expect(isBlockingRecovery({ state })).toBe(true);
    },
  );

  it.each<RuntimeRecovery['state']>(['ready', 'disconnected'])('is false for %s — no blocking banner', (state) => {
    expect(isBlockingRecovery({ state })).toBe(false);
  });

  it('is false when recovery is absent (every non-Pi session)', () => {
    expect(isBlockingRecovery(undefined)).toBe(false);
  });
});

describe('recoveryCauseText', () => {
  it('renders the recovery message verbatim — the design brief’s ONE cause', () => {
    expect(recoveryCauseText({ state: 'missing', message: 'native session file is missing' })).toBe(
      'native session file is missing',
    );
  });

  it('falls back to a generic line when the core omits message (defensive only)', () => {
    expect(recoveryCauseText({ state: 'corrupt' })).toContain('cannot be resumed');
  });
});

describe('submitRecoveryAction', () => {
  function harness() {
    return { setBusy: vi.fn(), setError: vi.fn(), schedule: vi.fn() };
  }

  it('marks busy, clears any stale error, then clears busy again on success', async () => {
    const h = harness();
    await submitRecoveryAction({ action: () => Promise.resolve({ ok: true, data: {} as never }), ...h });
    expect(h.setBusy).toHaveBeenNthCalledWith(1, true);
    expect(h.setError).toHaveBeenNthCalledWith(1, null);
    expect(h.setBusy).toHaveBeenNthCalledWith(2, false);
    expect(h.setError).toHaveBeenCalledTimes(1); // never called again — no failure to show
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('clears busy AND surfaces the message on a domain failure, scheduling its auto-clear', async () => {
    const h = harness();
    await submitRecoveryAction({
      action: () => Promise.resolve({ ok: false, error: { code: 'RUNTIME_SESSION_MISSING', message: 'native file is gone' } }),
      ...h,
    });
    expect(h.setBusy).toHaveBeenLastCalledWith(false);
    expect(h.setError).toHaveBeenLastCalledWith('native file is gone');
    expect(h.schedule).toHaveBeenCalledWith(expect.any(Function), 4000);
  });

  it('treats a transport-level rejection the same as a domain failure', async () => {
    const h = harness();
    await submitRecoveryAction({ action: () => Promise.reject(new Error('bridge down')), ...h });
    expect(h.setBusy).toHaveBeenLastCalledWith(false);
    expect(h.setError).toHaveBeenLastCalledWith('bridge down');
  });

  it('re-enables on success too — unlike a permission card, nothing else would ever flip a newFrom’s busy flag', async () => {
    const h = harness();
    await submitRecoveryAction({ action: () => Promise.resolve({ ok: true, data: {} as never }), ...h });
    expect(h.setBusy).toHaveBeenLastCalledWith(false);
  });
});
