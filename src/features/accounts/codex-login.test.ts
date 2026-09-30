import { describe, expect, it, vi } from 'vitest';
import type { AccountEvent } from '../../../contract/multi-account';

const mocks = vi.hoisted(() => ({ login: vi.fn(), subscribe: vi.fn() }));
vi.mock('../../lib/api', () => ({ accountCodexLogin: mocks.login, onAccountEvent: mocks.subscribe }));
import { startCodexLogin } from './codex-login';

function setup() {
  let listener: (event: AccountEvent) => void = () => {};
  const unlisten = vi.fn();
  mocks.subscribe.mockReset().mockImplementation(async (cb) => { listener = cb; return unlisten; });
  mocks.login.mockReset().mockResolvedValue({ ok: true, data: undefined });
  const onError = vi.fn();
  const onSettled = vi.fn();
  const stop = startCodexLogin('codex-account', { onError, onSettled });
  return { emit: (event: AccountEvent) => listener(event), unlisten, onError, onSettled, stop };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('native Codex login lifecycle', () => {
  it('subscribes before starting and keeps the attempt pending after spawn', async () => {
    let registered!: () => void;
    mocks.subscribe.mockReset().mockImplementation(() => new Promise((resolve) => { registered = () => resolve(vi.fn()); }));
    mocks.login.mockReset().mockResolvedValue({ ok: true });
    const onSettled = vi.fn();
    const stop = startCodexLogin('codex-account', { onError: vi.fn(), onSettled });
    expect(mocks.login).not.toHaveBeenCalled();
    registered();
    await flush();
    expect(mocks.login).toHaveBeenCalledWith({ accountId: 'codex-account' });
    expect(onSettled).not.toHaveBeenCalled();
    stop();
  });

  it('surfaces only the pending account failure and clears busy exactly once', async () => {
    const attempt = setup();
    await flush();
    const error = { code: 'INTERNAL' as const, message: 'Login timed out' };
    attempt.emit({ type: 'account.login.failed', loginId: 'claude-pty', error });
    expect(attempt.onError).not.toHaveBeenCalled();
    attempt.emit({ type: 'account.list', accounts: [] });
    expect(attempt.onSettled).not.toHaveBeenCalled();
    attempt.emit({ type: 'account.login.failed', loginId: 'codex-account', error });
    attempt.emit({ type: 'account.login.failed', loginId: 'codex-account', error });
    expect(attempt.onError).toHaveBeenCalledTimes(1);
    expect(attempt.onError).toHaveBeenCalledWith(error);
    expect(attempt.onSettled).toHaveBeenCalledTimes(1);
    expect(attempt.unlisten).toHaveBeenCalledTimes(1);
  });

  it('ends an attempt on matching completion without depending on account.list', async () => {
    const attempt = setup();
    await flush();
    attempt.emit({ type: 'account.login.done', loginId: 'codex-account', account: { id: 'codex-account' } as never });
    expect(attempt.onSettled).toHaveBeenCalledTimes(1);
    expect(attempt.onError).not.toHaveBeenCalled();
    expect(attempt.unlisten).toHaveBeenCalledTimes(1);
  });

  it('surfaces a refused start and clears pending state', async () => {
    const attempt = setup();
    const error = { code: 'SPAWN_FAILED' as const, message: 'Missing CLI' };
    mocks.login.mockResolvedValue({ ok: false, error });
    await flush();
    expect(attempt.onError).toHaveBeenCalledWith(error);
    expect(attempt.onSettled).toHaveBeenCalledTimes(1);
  });

  it('does not spawn after teardown while listener registration is pending', async () => {
    let registered!: () => void;
    const unlisten = vi.fn();
    mocks.subscribe.mockReset().mockImplementation(() => new Promise((resolve) => { registered = () => resolve(unlisten); }));
    mocks.login.mockReset();
    const onSettled = vi.fn();
    const stop = startCodexLogin('codex-account', { onError: vi.fn(), onSettled });
    stop();
    registered();
    await flush();
    expect(mocks.login).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
  });
});
