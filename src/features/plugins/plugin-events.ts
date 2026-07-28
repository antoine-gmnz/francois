// plugin-system — the IPC wiring the store deliberately does not own.
//
// `pluginsStore.ts` is a pure, node-testable slice with no Tauri import. This is
// the one place that bridges it to the core: a first `plugins_list`, then the
// `francois://plugins/event` stream. Both feed the SAME action, because a
// `plugin.registry` event carries a full snapshot (FR-80) and the initial list is
// just the first one.

import { onPluginsEvent, pluginsList } from '../../lib/api';
import { usePluginsStore } from './pluginsStore';

/**
 * Start the subscription and load the registry once. Returns the unlisten fn.
 *
 * Order matters: the listener is attached BEFORE the list is fetched, so a
 * registry mutation that lands between the two is not lost. A duplicate snapshot
 * is harmless — `setPlugins` replaces rather than merges.
 */
export async function startPlugins(): Promise<() => void> {
  const store = usePluginsStore.getState();
  const unlisten = await onPluginsEvent((event) => store.applyPluginEvent(event));
  const res = await pluginsList();
  if (res.ok) store.setPlugins(res.data);
  return unlisten;
}
