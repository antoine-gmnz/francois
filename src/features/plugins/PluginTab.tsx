// plugin-system FR-81 — a plugin's main tab.
//
// The one surface where something Francois did not draw ends up in the webview,
// so the boundaries are worth stating where they are enforced:
//
//  * The plugin supplies a URL, never markup. There is no innerHTML path here,
//    and `TabSpec` has no field that could carry one.
//  * The core already rejected any URL outside the plugin's own
//    `capabilities.network.hosts` (panelspec::validate_tab → net::check_url).
//    This component frames what it is given precisely BECAUSE that check has
//    already happened — it must not become the place that check lives.
//  * The frame cannot reach Francois. `francois.*` exists only inside the
//    isolate, so script in the page has no session, diff or project. A plugin
//    drives sessions through `driveSessions`, where each prompt is confirmed by
//    a human — never through its own page.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstalledPlugin, TabSpec } from '../../../contract/plugin-system';
import { pluginsInvokeCommand, pluginsRender } from '../../lib/api';
import { usePluginsStore } from './pluginsStore';
import { CONSENT_PENDING_LINE, declaredCommandIds, isActionInert, refreshIntervalFor } from './plugins';

const C = {
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  error: 'var(--error)',
};

export default function PluginTab({
  plugin,
  projectId,
  sessionId,
}: {
  plugin: InstalledPlugin;
  projectId: string | null;
  sessionId: string | null;
}) {
  const id = plugin.manifest.id;
  const [spec, setSpec] = useState<TabSpec | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Bumping this remounts the frame. A retry has to force a real reload — an
  // identical `src` would otherwise let the webview serve the failed load from
  // cache and the button would look broken.
  const [reload, setReload] = useState(0);
  const invalidation = usePluginsStore((s) => s.invalidation[`${id}:tab`] ?? 0);

  const render = useCallback(async () => {
    // Same reasoning as PluginPane.render: plugins_render resolves a Result for
    // every domain failure, so a REJECTION is a bridge fault. Uncaught, it would
    // leave the tab on "loading…" with no way out.
    let res;
    try {
      res = await pluginsRender({ pluginId: id, surface: 'tab', projectId, sessionId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (res.ok) {
      if (res.data.surface === 'tab') {
        setSpec(res.data.tab);
        setError(null);
      }
    } else {
      setError(res.error.message);
    }
  }, [id, projectId, sessionId]);

  useEffect(() => {
    if (plugin.consentPending) return;
    void render();
  }, [render, invalidation, plugin.consentPending]);

  // FR-70: re-ask for the URL on the plugin's own interval. A backing service
  // that was down when the tab opened comes back on its own this way, without
  // the user having to press anything.
  const renderRef = useRef(render);
  renderRef.current = render;
  useEffect(() => {
    const interval = refreshIntervalFor(plugin.manifest);
    // No tick once a URL is up: the frame is live and re-rendering it would
    // reload the user's page out from under them mid-interaction.
    if (interval === null || plugin.consentPending || spec?.url) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void renderRef.current();
    };
    const handle = window.setInterval(tick, interval);
    return () => window.clearInterval(handle);
  }, [plugin.manifest, plugin.consentPending, spec?.url]);

  const retry = () => {
    setReload((n) => n + 1);
    void render();
  };

  const runAction = (commandId: string) => {
    if (isActionInert(commandId, declaredCommandIds(plugin.manifest))) return;
    void pluginsInvokeCommand({ pluginId: id, commandId, projectId, sessionId }).then(() => render());
  };

  if (plugin.consentPending) return <Centered>{CONSENT_PENDING_LINE}</Centered>;
  if (error) {
    return (
      <Centered>
        <span style={{ color: C.error }}>{error}</span>
        <Action label="retry" onClick={retry} />
      </Centered>
    );
  }
  if (spec === undefined) return <Centered>loading…</Centered>;
  if (spec === null) return <Centered>{plugin.manifest.name} has nothing to show</Centered>;

  if (spec.url) {
    return (
      <iframe
        // The plugin id is in the key so switching tabs never reuses a frame
        // across plugins; `reload` is what makes retry a real reload.
        key={`${id}:${reload}`}
        src={spec.url}
        title={plugin.manifest.name}
        style={{ flex: 1, border: 'none', background: 'var(--bg-deep)', minHeight: 0 }}
        // allow-same-origin is required: without it the frame gets an opaque
        // origin and cannot call its OWN backend. It does not widen what the
        // frame can reach in Francois — that is bounded by there being no
        // francois.* outside the isolate, not by this attribute.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    );
  }

  return (
    <Centered>
      <span>{spec.message}</span>
      {spec.action && <Action label={spec.action.label} onClick={() => runAction(spec.action!.commandId)} />}
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: 24,
        textAlign: 'center',
        fontSize: 12,
        color: C.dim,
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <span role="button" onClick={onClick} style={{ fontSize: 11.5, color: C.accent, cursor: 'pointer' }}>
      {label}
    </span>
  );
}
