// cloud-sessions §5 — the three contract-typed invoke wrappers and the event
// subscription. Each binds francois:cloud:<verb> to the Tauri command
// `cloud_<verb>` (snake_case) and resolves a Result<T>; none of them ever
// rejects for a domain failure. The stream binds francois:cloud:event to
// 'francois://cloud/event'.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudSession } from '../../../contract/cloud-sessions';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import { cloudAdopt, cloudList, cloudResolve, onCloudEvent } from '../../lib/api';

const SESSION: CloudSession = {
  id: 'session_01Mo4r8N2qZBTbU4V647cis4',
  title: 'Fix the login bug',
  repo: 'acme/api',
  branch: 'fix/login',
  updatedAt: 1_700_000_000_000,
};

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
});

describe('cloud invoke wrappers', () => {
  it('cloudList → cloud_list, with no payload when no account was chosen', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { sessions: [SESSION], degraded: false } });
    const res = await cloudList();
    expect(invokeMock).toHaveBeenCalledWith('cloud_list', undefined);
    expect(res).toEqual({ ok: true, data: { sessions: [SESSION], degraded: false } });
  });

  it('cloudList carries an explicit accountId (multi-account)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { sessions: [], degraded: true } });
    await cloudList('acc1');
    expect(invokeMock).toHaveBeenCalledWith('cloud_list', { accountId: 'acc1' });
  });

  it('cloudList surfaces an auth refusal as ok:false rather than throwing', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'CLOUD_AUTH_REQUIRED', message: 'no token' } });
    const res = await cloudList();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('CLOUD_AUTH_REQUIRED');
  });

  it('cloudResolve → cloud_resolve { ref }', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { session: SESSION, matchedProjectId: 'p1' } });
    const res = await cloudResolve({ ref: SESSION.id });
    expect(invokeMock).toHaveBeenCalledWith('cloud_resolve', { ref: SESSION.id });
    expect(res).toEqual({ ok: true, data: { session: SESSION, matchedProjectId: 'p1' } });
  });

  it('cloudAdopt → cloud_adopt with the request verbatim', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { sessionId: 's1' } });
    const req = { ref: SESSION.id, projectId: 'p1', destination: 'checkout' as const, confirmed: true };
    await cloudAdopt(req);
    expect(invokeMock).toHaveBeenCalledWith('cloud_adopt', req);
  });
});

describe('onCloudEvent', () => {
  it('subscribes to francois://cloud/event and unwraps the payload', async () => {
    const unlisten = vi.fn();
    let handler: ((e: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementation((_channel: string, cb: (e: { payload: unknown }) => void) => {
      handler = cb;
      return Promise.resolve(unlisten);
    });
    const seen: unknown[] = [];
    await onCloudEvent((e) => seen.push(e));
    expect(listenMock).toHaveBeenCalledWith('francois://cloud/event', expect.any(Function));
    const event = { type: 'cloud.adopt', ref: SESSION.id, state: { phase: 'hydrating' } };
    handler!({ payload: event });
    expect(seen).toEqual([event]);
  });
});
