// code-editor-vsx §5: the contract-typed vsx_* invoke wrappers.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { vsxContributions, vsxDetails, vsxInstall, vsxList, vsxSearch, vsxSetEnabled, vsxUninstall } from '../../lib/api';

beforeEach(() => invokeMock.mockReset());

describe('vsx invoke wrappers', () => {
  it('vsx_search and vsx_details pass their request flat', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { results: [], total: 0 } });
    await expect(vsxSearch({ query: 'toml', offset: 30 })).resolves.toEqual({ ok: true, data: { results: [], total: 0 } });
    await vsxDetails({ id: 'tamasfe.even-better-toml' });
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'vsx_search', { query: 'toml', offset: 30 });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'vsx_details', { id: 'tamasfe.even-better-toml' });
  });

  it('vsx_install / vsx_uninstall / vsx_set_enabled name the extension', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'VSX_UNSUPPORTED', message: 'no' } });
    await expect(vsxInstall({ id: 'a.b' })).resolves.toMatchObject({ ok: false, error: { code: 'VSX_UNSUPPORTED' } });
    await vsxInstall({ id: 'a.b', version: '1.0.0' });
    await vsxUninstall({ id: 'a.b' });
    await vsxSetEnabled({ id: 'a.b', enabled: false });
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'vsx_install', { id: 'a.b' });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'vsx_install', { id: 'a.b', version: '1.0.0' });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'vsx_uninstall', { id: 'a.b' });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'vsx_set_enabled', { id: 'a.b', enabled: false });
  });

  it('vsx_list and vsx_contributions take no arguments', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: [] });
    await vsxList();
    await vsxContributions();
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'vsx_list', undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'vsx_contributions', undefined);
  });
});
