// plugin-system FR-81..FR-86 / §8·H — the framed main tab.
//
// This is the one surface where something Francois did not draw ends up in the
// webview, so what bounds it is worth stating where it is enforced:
//
//  * **The URL is static manifest data.** It is resolved from
//    `contributes.tab`, fixed at the moment the user consented. There is no
//    `tab()` handler, no `'tab'` render surface and therefore nothing to poll:
//    a plugin cannot repoint its tab after consent, and a compromised backing
//    service cannot move it. This file must never grow a refresh path — there
//    is nothing that could change.
//  * **The URL is re-validated here** (FR-85). The core is authoritative and
//    already refused anything `checkTabUrl` refuses; the renderer checks anyway
//    because `<iframe src>` is not a place to find out you were wrong. A URL
//    failing either half renders §8·H35 — a refusal — and never a frame.
//  * **The frame is cross-origin and IPC-free** (FR-83/FR-86). The sandbox
//    token set comes from the contract verbatim: no `allow-same-origin`, so the
//    document is forced into an opaque origin and reaches no storage, cookie or
//    postMessage channel of ours; no `allow-popups`, so it cannot spawn a
//    window that outlives the tab. `francois.*` exists only inside the isolate,
//    so script in the page reaches no session, diff or project.

import { useMemo, useRef, useState } from 'react';
import type { InstalledPlugin, PluginTab as PluginTabSpec } from '../../../contract/plugin-system';
import { PLUGIN_TAB_SANDBOX } from '../../../contract/plugin-system';
import {
  TAB_ADDRESS_COPIED,
  TAB_BLOCKED_HINT,
  TAB_BLOCKED_LINE,
  TAB_COPIED_MS,
  TAB_COPY_ADDRESS,
  checkTabUrl,
  tabAttribution,
  tabLoadingLine,
} from './plugins';

const C = {
  faint: 'var(--text-faint)',
  muted: 'var(--text-muted)',
  text: 'var(--text)',
  warn: 'var(--warn)',
};

export default function PluginTab({
  plugin,
  /**
   * Resolved by `resolvedPluginTabs`, which is also what decided this tab
   * exists at all — so this component never has to ask again, and there is no
   * "webTab granted but no tab" case for it to fall through (FR-82a).
   */
  tab,
}: {
  plugin: InstalledPlugin;
  tab: PluginTabSpec;
}) {
  const check = useMemo(
    () => checkTabUrl(tab.url, plugin.grantedCapabilities),
    [tab.url, plugin.grantedCapabilities],
  );
  const [loaded, setLoaded] = useState(false);

  // §8·H35 (FR-85). No frame at all: this is a security state and it reads as a
  // refusal, not as a page that failed to load.
  if (!check.ok) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: 24,
          textAlign: 'center',
        }}
      >
        <span style={{ fontSize: 18, color: C.faint }}>{tab.glyph}</span>
        <span style={{ fontSize: 11.5, color: C.warn }}>{TAB_BLOCKED_LINE}</span>
        {/* The offending URL as a TEXT CHILD — never in an attribute, never in
            a style value, and never as an href. */}
        <span style={{ fontSize: 10, color: C.faint, overflowWrap: 'anywhere', maxWidth: 520 }}>
          {tab.url}
        </span>
        <span style={{ fontSize: 10, color: C.muted }}>{TAB_BLOCKED_HINT}</span>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <AttributionStrip pluginName={plugin.manifest.name} host={check.host} url={tab.url} />
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: 'var(--bg-app)' }}>
        {!loaded && (
          // §8·H34 — the strip is up immediately; the frame area says where it
          // is going while the page loads.
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              color: C.faint,
            }}
          >
            <span className="blink">{tabLoadingLine(check.host)}</span>
          </div>
        )}
        <iframe
          // Keyed by plugin id so switching tabs never reuses a frame across
          // plugins.
          key={tab.pluginId}
          src={tab.url}
          title={plugin.manifest.name}
          onLoad={() => setLoaded(true)}
          // FR-83, verbatim from the contract. `allow-same-origin` and
          // `allow-popups` are absent on purpose — they are the whole boundary,
          // and adding either needs a spec amendment, not a code change.
          sandbox={PLUGIN_TAB_SANDBOX}
          referrerPolicy="no-referrer"
          allow=""
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            border: 'none',
            background: 'var(--bg-app)',
          }}
        />
      </div>
    </div>
  );
}

/**
 * §8·H32 — the 20px bar above the frame. The host shown is the FRAME's actual
 * hostname (from the parsed URL), not the plugin's chosen title: the user
 * should always be able to see *where* they are without trusting the plugin's
 * copy for it.
 */
function AttributionStrip({
  pluginName,
  host,
  url,
}: {
  pluginName: string;
  host: string;
  url: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // §8·H32: COPY, not open. Francois bundles no opener plugin, and
  // `window.open` in a Tauri webview would render the page in a window WITHOUT
  // the FR-83 sandbox — strictly worse than the frame it is meant to escape. So
  // the handoff is the URL itself: one paste opens it in the user's real
  // browser, outside the app.
  const copyAddress = () => {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), TAB_COPIED_MS);
      })
      .catch(() => {
        /* clipboard denied — the host is on screen either way */
      });
  };

  return (
    <div
      style={{
        height: 20,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '0 10px',
        background: 'var(--bg-deep)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: C.faint,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {tabAttribution(pluginName, host)}
      </span>
      <span
        role="button"
        onClick={copyAddress}
        title={url}
        style={{
          fontSize: 10,
          color: copied ? C.text : C.muted,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {copied ? TAB_ADDRESS_COPIED : TAB_COPY_ADDRESS}
      </span>
    </div>
  );
}
