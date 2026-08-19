// extensionsFeed — the app-wide registry feed (FR-4/FR-11) and the single
// francois://extensions/event subscription. Covers the reqId/staleness guard
// (a stale extensions_list(rootA) must never overwrite a newer rootB answer)
// and detectionRoot's null-with-no-session rule.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { ExtensionInfo } from '../../../contract/extensions';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import { useStore } from '../../lib/store';
import { detectionRoot, refreshExtensions } from './extensionsFeed';

function session(over: Partial<SessionMeta> & { id: string; cwd: string }): SessionMeta {
  return {
    name: over.id,
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
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    ...over,
  };
}

function ext(id: string): ExtensionInfo {
  return {
    id: id as ExtensionInfo['id'],
    label: id,
    enabled: true,
    consent: { state: 'granted' },
    detected: true,
    undetectedReason: null,
    minVersionLabel: null,
    source: { dir: `/home/u/.francois/extensions/${id}`, manifestSha256: `sha-${id}`, declaredCommands: [] },
    predicate: { kind: 'pathExists', path: '.' },
    panels: [],
    manifestError: null,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  useStore.setState({ extensions: [] });
});

describe('detectionRoot (FR-3/FR-11)', () => {
  it("is the active session's cwd, or null with no session", () => {
    expect(detectionRoot(session({ id: 's1', cwd: '/repo' }))).toBe('/repo');
    expect(detectionRoot(null)).toBeNull();
  });
});

describe('refreshExtensions staleness guard', () => {
  it('applies a resolved list to the store', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: [ext('git')] });
    await refreshExtensions('/repo');
    expect(useStore.getState().extensions).toEqual([ext('git')]);
  });

  it('drops a slow answer for an earlier root once a newer root has been requested', async () => {
    let resolveA: ((r: unknown) => void) | undefined;
    invokeMock.mockImplementationOnce(() => new Promise((r) => (resolveA = r)));
    const pendingA = refreshExtensions('/repo-a');

    invokeMock.mockResolvedValueOnce({ ok: true, data: [ext('docker')] });
    const pendingB = refreshExtensions('/repo-b');
    await pendingB;
    expect(useStore.getState().extensions).toEqual([ext('docker')]);

    // The slow /repo-a answer lands AFTER /repo-b already resolved — it must
    // not overwrite the store with stale data.
    resolveA?.({ ok: true, data: [ext('git')] });
    await pendingA;
    expect(useStore.getState().extensions).toEqual([ext('docker')]);
  });

  it('never throws on a rejected probe — the previous list stands', async () => {
    invokeMock.mockRejectedValueOnce(new Error('ipc down'));
    useStore.getState().setExtensions([ext('git')]);
    await refreshExtensions('/repo');
    expect(useStore.getState().extensions).toEqual([ext('git')]);
  });
});
