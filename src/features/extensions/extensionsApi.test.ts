// The contract-typed invoke wrappers for `extensions` (spec §5 Channels): every
// logical channel binds to exactly one Tauri command name, with the request
// payload passed through untouched. A drift here is a silent no-op at runtime,
// so it is pinned rather than reviewed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ cmd: string; args: unknown }> = [];
const listens: string[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    return Promise.resolve({ ok: true, data: null });
  },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (channel: string) => {
    listens.push(channel);
    return Promise.resolve(() => {});
  },
}));

beforeEach(() => {
  calls.length = 0;
  listens.length = 0;
});

describe('extensions channel binding', () => {
  it('maps each logical channel onto its snake_case command', async () => {
    const api = await import('../../lib/api');
    await api.extensionsList({ root: '/repo' });
    await api.extensionsSetEnabled({ extensionId: 'docker', enabled: false, root: '/repo' });
    await api.extensionsDetect({ root: '/repo' });
    await api.extensionsPanel({ panelId: 'git:log', root: '/repo', offset: 100, limit: 100 });
    await api.extensionsOpenStream({ panelId: 'docker:logs', root: '/repo', token: 'web_1' });
    await api.extensionsCloseStream({ streamId: 's1' });
    await api.extensionsProbe();
    await api.extensionsLaunch({ actionId: 'cohorte-dashboard' });

    expect(calls.map((c) => c.cmd)).toEqual([
      'extensions_list',
      'extensions_set_enabled',
      'extensions_detect',
      'extensions_panel',
      'extensions_open_stream',
      'extensions_close_stream',
      'extensions_probe',
      'extensions_launch',
    ]);
    expect(calls[3].args).toEqual({ panelId: 'git:log', root: '/repo', offset: 100, limit: 100 });
    expect(calls[4].args).toEqual({ panelId: 'docker:logs', root: '/repo', token: 'web_1' });
  });

  it('subscribes to the one extensions event channel', async () => {
    const api = await import('../../lib/api');
    await api.onExtensionEvent(() => {});
    expect(listens).toEqual(['francois://extensions/event']);
  });
});
