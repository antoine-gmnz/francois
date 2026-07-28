// plugin-system — the contract-typed invoke wrappers and the event handler.
// PIPELINE.md §Conventions pins the physical Tauri binding: request
// `francois:plugins:<verb>` → command `plugins_<verb_snake_case>`, event
// `francois:plugins:event` → `francois://plugins/event`. These tests are the
// guard on that mapping — a renamed command breaks here, not at runtime.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above every const in the module, so the spies
// have to be created in a hoisted block too.
// The parameters are declared even though the bodies ignore them: without them
// `mock.calls[n]` types as `[]`, and the assertions below — which exist to pin
// the command name and the event channel — would not typecheck.
const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _payload?: unknown) => ({ ok: true, data: null })),
  listen: vi.fn(async (_event: string, _handler: (e: { payload: unknown }) => void) => () => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

import type { PluginEvent } from '../../../contract/plugin-system';
import {
  onPluginsEvent,
  pluginsCheckUpdate,
  pluginsGetSettings,
  pluginsInstall,
  pluginsInvokeCommand,
  pluginsList,
  pluginsRender,
  pluginsResolve,
  pluginsResolveInjection,
  pluginsSetEnablement,
  pluginsSetSettings,
  pluginsUninstall,
  pluginsUpdate,
} from '../../lib/api';

describe('plugins invoke wrappers (§5.4)', () => {
  beforeEach(() => {
    invoke.mockClear();
    listen.mockClear();
  });

  const call = () => invoke.mock.calls[0] as unknown as [string, unknown];

  it('covers the twelve plugins_* commands', async () => {
    const cases: [() => Promise<unknown>, string, unknown][] = [
      [() => pluginsList(), 'plugins_list', undefined],
      [() => pluginsResolve({ spec: 'acme/ci' }), 'plugins_resolve', { spec: 'acme/ci' }],
      [() => pluginsInstall({ stagingId: 's1' }), 'plugins_install', { stagingId: 's1' }],
      [() => pluginsUninstall({ pluginId: 'acme-ci' }), 'plugins_uninstall', { pluginId: 'acme-ci' }],
      [
        () => pluginsSetEnablement({ pluginId: 'acme-ci', enablement: { scope: 'all' } }),
        'plugins_set_enablement',
        { pluginId: 'acme-ci', enablement: { scope: 'all' } },
      ],
      [() => pluginsGetSettings({ pluginId: 'acme-ci' }), 'plugins_get_settings', { pluginId: 'acme-ci' }],
      [
        () => pluginsSetSettings({ pluginId: 'acme-ci', settings: { repo: 'a/b' } }),
        'plugins_set_settings',
        { pluginId: 'acme-ci', settings: { repo: 'a/b' } },
      ],
      [
        () => pluginsRender({ pluginId: 'acme-ci', surface: 'panel', projectId: null, sessionId: null }),
        'plugins_render',
        { pluginId: 'acme-ci', surface: 'panel', projectId: null, sessionId: null },
      ],
      [
        () => pluginsInvokeCommand({ pluginId: 'acme-ci', commandId: 'open-run', projectId: null, sessionId: null }),
        'plugins_invoke_command',
        { pluginId: 'acme-ci', commandId: 'open-run', projectId: null, sessionId: null },
      ],
      [
        () => pluginsResolveInjection({ sessionId: 's', blockId: 'b', decision: 'approve' }),
        'plugins_resolve_injection',
        { sessionId: 's', blockId: 'b', decision: 'approve' },
      ],
      [() => pluginsCheckUpdate({ pluginId: 'acme-ci' }), 'plugins_check_update', { pluginId: 'acme-ci' }],
      [() => pluginsUpdate({ pluginId: 'acme-ci', consented: true }), 'plugins_update', { pluginId: 'acme-ci', consented: true }],
    ];
    expect(cases).toHaveLength(12);

    // The plugins_* handlers take ONE struct parameter named `req`, and Tauri
    // binds arguments by parameter name — so every payload-carrying command must
    // be wrapped as { req }. Sending it flat leaves `req` unbound and the invoke
    // rejects at the bridge. This assertion is the only thing standing between
    // that mistake and a plugin pane stuck on "rendering…", because a mocked
    // invoke happily accepts either shape.
    for (const [fn, cmd, payload] of cases) {
      invoke.mockClear();
      await fn();
      expect(call()[0]).toBe(cmd);
      expect(call()[1]).toEqual(payload === undefined ? undefined : { req: payload });
    }
  });

  it('subscribes to francois://plugins/event and unwraps the payload', async () => {
    const seen: PluginEvent[] = [];
    await onPluginsEvent((e) => seen.push(e));
    expect(listen.mock.calls[0][0]).toBe('francois://plugins/event');

    const handler = listen.mock.calls[0][1] as unknown as (e: { payload: PluginEvent }) => void;
    const event: PluginEvent = { type: 'plugin.invalidated', pluginId: 'acme-ci', surface: 'panel' };
    handler({ payload: event });
    expect(seen).toEqual([event]);
  });
});
