// plugin-system — the WIRING tests.
//
// The pure helpers in `plugins.ts` were all tested before these existed, and
// every one of them passed while the feature shipped nothing: `pluginPaletteEntries`,
// `paletteSyncPlan`, `pluginCommandEnabled` and `setBusy` had no production
// caller at all, so a plugin's `contributes.commands[]` never reached ⌘K. These
// tests cover the call sites rather than the helpers, so a green suite means the
// surface is actually reachable.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pluginsInvokeCommand, pluginsRender, pluginsList, onPluginsEvent } = vi.hoisted(() => ({
  pluginsInvokeCommand: vi.fn(async (_req: unknown) => ({ ok: true, data: null }) as unknown),
  pluginsRender: vi.fn(async (_req: unknown) => ({ ok: true, data: null }) as unknown),
  pluginsList: vi.fn(async () => ({ ok: true, data: [] }) as unknown),
  onPluginsEvent: vi.fn(async (_cb: (e: unknown) => void) => () => {}),
}));
vi.mock('../../lib/api', () => ({ pluginsInvokeCommand, pluginsRender, pluginsList, onPluginsEvent }));

import type { InstalledPlugin, PluginManifest } from '../../../contract/plugin-system';
import { pluginPaletteCommandId } from '../../../contract/plugin-system';
import { makeContext, paletteCommands, unregisterPaletteCommand } from '../palette/palette';
import { useStore } from '../../lib/store';
import { usePluginsStore } from './pluginsStore';
import { startPlugins } from './plugin-events';
import { invokePluginCommand } from './pluginInvoke';
import { resetPluginPaletteSync, syncPluginPaletteCommands } from './pluginPalette';

function plugin(id: string, over: Partial<InstalledPlugin> = {}): InstalledPlugin {
  const manifest: PluginManifest = {
    manifestVersion: 1,
    id,
    name: id.toUpperCase(),
    version: '1.0.0',
    description: 'd',
    entry: 'index.js',
    contributes: { commands: [{ id: 'open-run', title: 'Open run' }] },
    capabilities: {},
  };
  return {
    manifest,
    source: { kind: 'github', spec: `acme/${id}` },
    resolvedRef: 'ref',
    installPath: `/p/${id}`,
    installedAt: 0,
    updatedAt: 0,
    enablement: { scope: 'all' },
    grantedCapabilities: {},
    consentPending: false,
    settings: {},
    ...over,
  };
}

const ctx = () => makeContext(null, 0);

beforeEach(() => {
  pluginsInvokeCommand.mockClear();
  pluginsRender.mockClear();
  pluginsList.mockClear();
  onPluginsEvent.mockClear();
  onPluginsEvent.mockImplementation(async () => () => {});
  pluginsList.mockImplementation(async () => ({ ok: true, data: [] }));
  pluginsInvokeCommand.mockImplementation(async () => ({ ok: true, data: null }));
  usePluginsStore.getState().reset();
  // Leave the palette registry as we found it.
  for (const c of [...paletteCommands()]) unregisterPaletteCommand(c.id);
  resetPluginPaletteSync();
});

describe('registry seeding (FR-80, MEDIUM 31)', () => {
  it('does not let the initial list overwrite a snapshot that landed first', async () => {
    // The ordering the comment in plugin-events claimed to protect against, but
    // did not: the event is NEWER than the in-flight list response, so applying
    // the response on top rolls the registry back.
    const fresh = [plugin('landed-by-event')];
    onPluginsEvent.mockImplementation(async (cb: (e: unknown) => void) => {
      cb({ type: 'plugin.registry', plugins: fresh });
      return () => {};
    });
    pluginsList.mockImplementation(async () => ({ ok: true, data: [plugin('stale-from-list')] }));

    await startPlugins();
    expect(usePluginsStore.getState().plugins.map((p) => p.manifest.id)).toEqual(['landed-by-event']);
  });

  it('seeds from the list when nothing landed first', async () => {
    onPluginsEvent.mockImplementation(async () => () => {});
    pluginsList.mockImplementation(async () => ({ ok: true, data: [plugin('from-list')] }));
    await startPlugins();
    expect(usePluginsStore.getState().plugins.map((p) => p.manifest.id)).toEqual(['from-list']);
  });
});

describe('plugin command invocation (FR-50, MEDIUM 29)', () => {
  it('marks the plugin busy for the duration and clears it after', async () => {
    let seenBusy = false;
    pluginsInvokeCommand.mockImplementation(async () => {
      seenBusy = usePluginsStore.getState().busy['acme-ci'] === true;
      return { ok: true, data: null };
    });
    await invokePluginCommand({ pluginId: 'acme-ci', commandId: 'open-run', projectId: null, sessionId: null });
    expect(seenBusy).toBe(true);
    expect(usePluginsStore.getState().busy['acme-ci']).toBe(false);
  });

  it('clears busy on a Result failure AND on a bridge rejection', async () => {
    pluginsInvokeCommand.mockImplementation(async () => ({
      ok: false,
      error: { code: 'PLUGIN_RUNTIME_ERROR', message: 'boom' },
    }));
    expect(await invokePluginCommand({ pluginId: 'acme-ci', commandId: 'c', projectId: null, sessionId: null })).toBe(false);
    expect(usePluginsStore.getState().busy['acme-ci']).toBe(false);

    pluginsInvokeCommand.mockImplementation(() => Promise.reject(new Error('bridge down')));
    expect(await invokePluginCommand({ pluginId: 'acme-ci', commandId: 'c', projectId: null, sessionId: null })).toBe(false);
    expect(usePluginsStore.getState().busy['acme-ci']).toBe(false);
  });
});

describe('plugin palette registration (FR-50/FR-52, CRITICAL 6)', () => {
  const id = pluginPaletteCommandId('acme-ci', 'open-run');

  it('registers one row per contributed command, attributed with the plugin name', () => {
    syncPluginPaletteCommands([plugin('acme-ci')]);
    const cmd = paletteCommands().find((c) => c.id === id);
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe('Open run');
    expect(cmd?.hint?.()).toBe('ACME-CI');
    expect(cmd?.glyph).toBe('⌁');
  });

  it('is idempotent — re-syncing the same registry does not re-register', () => {
    const list = [plugin('acme-ci')];
    syncPluginPaletteCommands(list);
    expect(() => syncPluginPaletteCommands(list)).not.toThrow();
    expect(paletteCommands().filter((c) => c.id === id)).toHaveLength(1);
  });

  it('drops the row when the plugin is uninstalled (FR-74)', () => {
    syncPluginPaletteCommands([plugin('acme-ci')]);
    syncPluginPaletteCommands([]);
    expect(paletteCommands().find((c) => c.id === id)).toBeUndefined();
  });

  it('registers nothing for a consentPending plugin (FR-16)', () => {
    syncPluginPaletteCommands([plugin('acme-ci', { consentPending: true })]);
    expect(paletteCommands()).toHaveLength(0);
  });

  it('disables the row out of scope and while an invocation is in flight (FR-50)', () => {
    const scoped = plugin('acme-ci', { enablement: { scope: 'projects', projectIds: ['p1'] } });
    usePluginsStore.getState().setPlugins([scoped]);
    syncPluginPaletteCommands([scoped]);
    const cmd = paletteCommands().find((c) => c.id === id);

    useStore.getState().setActiveProjectId('p1');
    expect(cmd?.enabled?.(ctx())).toBe(true);

    useStore.getState().setActiveProjectId('p2');
    expect(cmd?.enabled?.(ctx())).toBe(false); // FR-76

    useStore.getState().setActiveProjectId('p1');
    usePluginsStore.getState().setBusy('acme-ci', true);
    expect(cmd?.enabled?.(ctx())).toBe(false);
  });

  it('invokes the plugin command through the contract channel', () => {
    const p = plugin('acme-ci');
    usePluginsStore.getState().setPlugins([p]);
    useStore.getState().setActiveProjectId(null);
    syncPluginPaletteCommands([p]);

    paletteCommands().find((c) => c.id === id)?.run(ctx());
    expect(pluginsInvokeCommand).toHaveBeenCalledWith({
      pluginId: 'acme-ci',
      commandId: 'open-run',
      projectId: null,
      sessionId: null,
    });
  });
});
