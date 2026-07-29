// plugin-system — the one path a plugin command is invoked through.
//
// Every caller (a PanelSpec `action`, a status item's `commandId`, a ⌘K row,
// the FR-40 ⏎ on a selected list item) goes through here so three things are
// true everywhere rather than at three out of four call sites:
//
//  * the plugin is marked BUSY for the duration, which is what FR-50 disables
//    its palette rows on;
//  * a `Result` failure surfaces as a toast instead of vanishing;
//  * a BRIDGE rejection is caught. `plugins_invoke_command` resolves a Result
//    for every domain failure, so a rejection means the bridge itself failed —
//    left floating it would leave `busy` stuck true and every row for that
//    plugin permanently disabled.

import type { PanelActionArgs } from '../../../contract/plugin-system';
import { pluginsInvokeCommand } from '../../lib/api';
import { showToast } from '../palette/palette';
import { usePluginsStore } from './pluginsStore';

export interface PluginCommandInvocation {
  pluginId: string;
  commandId: string;
  args?: PanelActionArgs;
  projectId: string | null;
  sessionId: string | null;
}

/** Resolves true when the handler settled cleanly. Never rejects. */
export async function invokePluginCommand(req: PluginCommandInvocation): Promise<boolean> {
  const { setBusy } = usePluginsStore.getState();
  setBusy(req.pluginId, true);
  try {
    const res = await pluginsInvokeCommand(req);
    if (!res.ok) {
      showToast(res.error.message, 'error');
      return false;
    }
    return true;
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'the plugin command could not be sent', 'error');
    return false;
  } finally {
    setBusy(req.pluginId, false);
  }
}
