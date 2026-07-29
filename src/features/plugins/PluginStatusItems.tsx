// plugin-system FR-42/FR-49/FR-72 / §8·B — plugin status-bar items.
//
// Two halves that used to be one and a half: the status bar rendered
// `visibleStatusItems(...)` while NOTHING ever called `plugins_render` for the
// `statusBar` surface, so the map was permanently empty and no plugin could
// ever publish an item. The loader below is that missing half.
//
// One loader per contributor rather than one effect over the list: each owns
// its own invalidation subscription and its own FR-70 tick, and a plugin that
// drops out of scope unmounts its loader with its timer.

import { useCallback, useEffect, useRef } from 'react';
import type { InstalledPlugin } from '../../../contract/plugin-system';
import { pluginsRender } from '../../lib/api';
import { invokePluginCommand } from './pluginInvoke';
import {
  refreshIntervalFor,
  shouldRefresh,
  statusItemPlugins,
  toneColor,
  visibleStatusItems,
} from './plugins';
import { usePluginsStore } from './pluginsStore';

export default function PluginStatusItems({
  projectId,
  sessionId,
}: {
  projectId: string | null;
  sessionId: string | null;
}) {
  const plugins = usePluginsStore((s) => s.plugins);
  const items = usePluginsStore((s) => s.statusItems);

  // FR-49: the contributors are capped at three in REGISTRY order, so the cap
  // is deterministic — it counts contributors, not the ones that happened to
  // return an item this tick.
  const contributors = statusItemPlugins(plugins, projectId);
  const visible = visibleStatusItems(plugins, projectId, items);

  return (
    <>
      {contributors.map((p) => (
        <StatusItemLoader key={p.manifest.id} plugin={p} projectId={projectId} sessionId={sessionId} />
      ))}
      {visible.map(({ pluginId, item }) => (
        <span
          key={pluginId}
          role={item.commandId ? 'button' : undefined}
          onClick={() => {
            if (!item.commandId) return;
            void invokePluginCommand({
              pluginId,
              commandId: item.commandId,
              projectId,
              sessionId,
            });
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 10.5,
            letterSpacing: '0.02em',
            // Tone is the only thing the plugin decides; every size and space
            // here is ours (FR-37).
            color: item.tone ? toneColor(item.tone) : 'var(--text-dim)',
            cursor: item.commandId ? 'pointer' : 'default',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 180,
          }}
        >
          {item.badge && (
            <span
              style={{
                fontSize: 9.5,
                padding: '0 5px',
                border: '1px solid var(--border-2)',
                borderRadius: 3,
              }}
            >
              {item.badge}
            </span>
          )}
          {item.text}
        </span>
      ))}
    </>
  );
}

/** Headless: it renders nothing and only keeps one plugin's item current. */
function StatusItemLoader({
  plugin,
  projectId,
  sessionId,
}: {
  plugin: InstalledPlugin;
  projectId: string | null;
  sessionId: string | null;
}) {
  const id = plugin.manifest.id;
  const invalidation = usePluginsStore((s) => s.invalidation[`${id}:statusBar`] ?? 0);
  const failures = usePluginsStore((s) => s.failures[`${id}:statusBar`] ?? 0);
  const setStatusItem = usePluginsStore((s) => s.setStatusItem);
  const intervalMs = refreshIntervalFor(plugin.manifest);

  const render = useCallback(async () => {
    // As in PluginPane: plugins_render resolves a Result for every domain
    // failure, so a REJECTION is a bridge fault. A status item has no error
    // state of its own (§8·B) — the honest rendering of a broken one is no
    // item at all, and the failure is already counted by the core (FR-73).
    try {
      const res = await pluginsRender({ pluginId: id, surface: 'statusBar', projectId, sessionId });
      if (res.ok && res.data.surface === 'statusBar') setStatusItem(id, res.data.item);
    } catch {
      /* bridge fault — leave the last item in place rather than blanking it */
    }
  }, [id, projectId, sessionId, setStatusItem]);

  // FR-72: mount, first appearance, and every plugin.invalidated for this surface.
  useEffect(() => {
    void render();
  }, [render, invalidation]);

  // FR-70/FR-73: the frontend drives the tick, only while the window is visible,
  // and it stops after PLUGIN_FAILURE_LIMIT consecutive failures.
  const renderRef = useRef(render);
  renderRef.current = render;
  useEffect(() => {
    if (
      !shouldRefresh({
        intervalMs,
        documentVisible: true, // re-checked per tick below; a hidden window costs nothing
        failures,
        consentPending: plugin.consentPending,
        enabled: true, // this loader only exists for an ACTIVE contributor
      })
    ) {
      return;
    }
    const handle = window.setInterval(() => {
      if (document.visibilityState === 'visible') void renderRef.current();
    }, intervalMs as number);
    return () => window.clearInterval(handle);
  }, [intervalMs, failures, plugin.consentPending]);

  return null;
}
