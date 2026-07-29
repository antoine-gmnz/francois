// plugin-system FR-50/FR-52 — plugin commands in ⌘K.
//
// The registry is the source of truth: every `plugin.registry` snapshot (FR-80)
// re-runs `syncPluginPaletteCommands`, which registers what is new and
// unregisters what is gone. Ids are namespaced `plugin:<pluginId>:<commandId>`
// so two plugins declaring the same commandId can never collide (FR-2).
//
// `enabled` and `run` read the stores at CALL time rather than closing over a
// snapshot, so a project-filter switch (FR-76) or an in-flight invocation
// (FR-50) is reflected without re-registering anything — the palette recomputes
// its context immediately before every render pass (command-palette FR-9).

import type { InstalledPlugin } from '../../../contract/plugin-system';
import { useStore } from '../../lib/store';
import { registerPaletteCommand, unregisterPaletteCommand } from '../palette/palette';
import { invokePluginCommand } from './pluginInvoke';
import { paletteSyncPlan, pluginCommandEnabled, pluginPaletteEntries } from './plugins';
import { usePluginsStore } from './pluginsStore';

/** The plugin command ids currently in the palette registry, in sync order. */
let registeredIds: string[] = [];

/** Test seam — the palette registry is module-level, so this one is too. */
export function resetPluginPaletteSync(): void {
  registeredIds = [];
}

/**
 * Reconcile the palette against a registry snapshot. Idempotent: re-syncing an
 * unchanged registry registers nothing (a duplicate id would throw).
 */
export function syncPluginPaletteCommands(plugins: InstalledPlugin[]): void {
  const entries = pluginPaletteEntries(plugins);
  const { add, remove } = paletteSyncPlan(registeredIds, entries);

  for (const id of remove) unregisterPaletteCommand(id);

  for (const entry of add) {
    registerPaletteCommand({
      id: entry.id,
      glyph: entry.glyph,
      name: entry.name,
      // §8·G25: the plugin's own name, right-aligned — every plugin row is
      // attributed without a bespoke treatment.
      hint: () => entry.hint,
      enabled: () => {
        const st = usePluginsStore.getState();
        const plugin = st.plugins.find((p) => p.manifest.id === entry.pluginId);
        if (!plugin) return false;
        return pluginCommandEnabled(
          plugin,
          useStore.getState().activeProjectId,
          st.busy[entry.pluginId] === true,
        );
      },
      run: () => {
        const app = useStore.getState();
        void invokePluginCommand({
          pluginId: entry.pluginId,
          commandId: entry.commandId,
          projectId: app.activeProjectId,
          sessionId: app.activeSessionId,
        });
      },
    });
  }

  registeredIds = entries.map((e) => e.id);
}
