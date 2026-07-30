import { describe, expect, it, vi } from 'vitest';
import type { Result } from '../../contract/common';
import { runGuardedAction } from './guarded-action';

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const err = (message: string): Result<never> => ({ ok: false, error: { code: 'INVALID_INPUT', message } });

describe('runGuardedAction', () => {
  it('with no options at all, a bare success just resolves (switchModelFromCard\'s no-op path)', async () => {
    await expect(runGuardedAction(async () => ok(null))).resolves.toBeUndefined();
  });

  it('marks busy before running and clears a stale error', async () => {
    const setBusy = vi.fn();
    const setError = vi.fn();
    await runGuardedAction(async () => ok(null), { setBusy, setError });
    expect(setBusy).toHaveBeenNthCalledWith(1, true);
    expect(setError).toHaveBeenNthCalledWith(1, null);
  });

  it('on success, never resets busy — the card stays in-flight for a live event to settle', async () => {
    const setBusy = vi.fn();
    await runGuardedAction(async () => ok(null), { setBusy });
    expect(setBusy).toHaveBeenCalledTimes(1); // only the initial true
    expect(setBusy).toHaveBeenCalledWith(true);
  });

  it('on a domain failure (ok: false), re-enables and shows the message', async () => {
    const setBusy = vi.fn();
    const setError = vi.fn();
    const schedule = vi.fn();
    await runGuardedAction(async () => err('boom'), { setBusy, setError, schedule });
    expect(setBusy).toHaveBeenLastCalledWith(false);
    expect(setError).toHaveBeenLastCalledWith('boom');
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][1]).toBe(4000); // default errorMs
  });

  it('a transport-level rejection is treated exactly like ok: false', async () => {
    const setError = vi.fn();
    await runGuardedAction(
      async () => {
        throw new Error('network down');
      },
      { setError },
    );
    expect(setError).toHaveBeenLastCalledWith('network down');
  });

  it('a thrown non-Error is stringified', async () => {
    const setError = vi.fn();
    await runGuardedAction(
      async () => {
        throw 'nope';
      },
      { setError },
    );
    expect(setError).toHaveBeenLastCalledWith('nope');
  });

  it('the scheduled fn clears the error when invoked', async () => {
    const setError = vi.fn();
    let scheduled: (() => void) | undefined;
    const schedule = (fn: () => void) => {
      scheduled = fn;
    };
    await runGuardedAction(async () => err('boom'), { setError, schedule });
    setError.mockClear();
    scheduled?.();
    expect(setError).toHaveBeenCalledWith(null);
  });

  it('honors a custom errorMs', async () => {
    const schedule = vi.fn();
    await runGuardedAction(async () => err('boom'), { setError: vi.fn(), schedule, errorMs: 9000 });
    expect(schedule.mock.calls[0][1]).toBe(9000);
  });

  it('without schedule, a failure still updates setError but nothing is scheduled', async () => {
    const setError = vi.fn();
    await runGuardedAction(async () => err('boom'), { setError });
    expect(setError).toHaveBeenLastCalledWith('boom');
  });

  it('race guard: isResolved() true suppresses setBusy(false)/setError/schedule on failure (FR-21)', async () => {
    const setBusy = vi.fn();
    const setError = vi.fn();
    const schedule = vi.fn();
    await runGuardedAction(async () => err('boom'), {
      setBusy,
      setError,
      schedule,
      isResolved: () => true,
    });
    expect(setBusy).toHaveBeenCalledTimes(1); // only the initial true — never false
    expect(setBusy).not.toHaveBeenCalledWith(false);
    expect(setError).toHaveBeenCalledTimes(1); // only the initial clear — never the failure message
    expect(setError).not.toHaveBeenCalledWith('boom');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('race guard: isResolved() false behaves like no guard at all', async () => {
    const setError = vi.fn();
    await runGuardedAction(async () => err('boom'), { setError, isResolved: () => false });
    expect(setError).toHaveBeenLastCalledWith('boom');
  });

  it('logs the raw failure message, letting the caller format it (question-card.ts style)', async () => {
    const log = vi.fn();
    await runGuardedAction(async () => err('boom'), { log });
    expect(log).toHaveBeenCalledWith('boom');
  });

  it('never logs on success', async () => {
    const log = vi.fn();
    await runGuardedAction(async () => ok(null), { log });
    expect(log).not.toHaveBeenCalled();
  });

  it('logs even when isResolved() is true (question-card.ts logs unconditionally on failure)', async () => {
    const log = vi.fn();
    await runGuardedAction(async () => err('boom'), { log, isResolved: () => true });
    expect(log).toHaveBeenCalledWith('boom');
  });

  it('propagates the resolved data type through fn (compile-time — no runtime assertion needed)', async () => {
    const res = await runGuardedAction(async () => ok({ n: 1 }));
    expect(res).toBeUndefined(); // runGuardedAction itself resolves void; fn's data is for the caller's own closure
  });
});
