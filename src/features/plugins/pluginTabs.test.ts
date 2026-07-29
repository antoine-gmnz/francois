// plugin-system FR-81..FR-86 / §8·H — the framed main tab.
//
// Split out of plugins.test.ts because the tab surface is its own concern, and
// the one with the sharpest edges: the url is STATIC manifest data, the scheme
// and host are re-validated in the frontend before anything is framed, and the
// sandbox token set is the whole boundary. Each of those is a test here rather
// than a comment somewhere.

import { describe, expect, it } from 'vitest';
import type { InstalledPlugin, PluginCapabilities, PluginManifest } from '../../../contract/plugin-system';
import {
  DEFAULT_PLUGIN_GLYPH,
  MAX_PLUGIN_TABS,
  PLUGIN_TAB_SANDBOX,
  PLUGIN_TAB_SCHEMES,
  TAB_MAX_TITLE,
  isPluginTabId,
  pluginIdOfTab,
  pluginPaneId,
  pluginTabId,
} from '../../../contract/plugin-system';
import {
  TAB_BLOCKED_HINT,
  TAB_BLOCKED_LINE,
  TAB_ADDRESS_COPIED,
  TAB_COPY_ADDRESS,
  checkTabUrl,
  consentPendingReason,
  isTabStillVisible,
  pluginPaletteEntries,
  pluginPanes,
  pluginRowTags,
  pluginTabs,
  resolvePluginTab,
  resolvedPluginTabs,
  tabAttribution,
  tabLoadingLine,
  tabTitle,
} from './plugins';

// ---------- fixtures (mirrors plugins.test.ts) ----------

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: 1,
    id: 'acme-ci',
    name: 'Acme CI',
    version: '1.2.0',
    description: 'CI status at a glance',
    entry: 'index.js',
    contributes: {},
    capabilities: {},
    ...over,
  };
}

function plugin(
  over: Omit<Partial<InstalledPlugin>, 'manifest'> & { manifest?: Partial<PluginManifest> } = {},
): InstalledPlugin {
  const { manifest: m, ...rest } = over;
  return {
    manifest: manifest(m),
    source: { kind: 'github', spec: 'acme/francois-ci' },
    resolvedRef: '8f2c1a9d3b4e5f60718293a4b5c6d7e8f9012345',
    installPath: '/data/plugins/acme-ci',
    installedAt: 1_000,
    updatedAt: 1_000,
    enablement: { scope: 'all' },
    grantedCapabilities: {},
    consentPending: false,
    settings: {},
    ...rest,
  };
}

describe('plugin main tabs (FR-81..FR-86)', () => {
  const HOST = 'ci.acme.dev';
  const URL_OK = `https://${HOST}/board`;
  const webCaps: PluginCapabilities = { network: { hosts: [HOST] }, webTab: true };
  const contributesTab = (url = URL_OK, title = 'cohorte') => ({ tab: { title, url } });
  const tabbed = (id: string, over: Partial<InstalledPlugin> = {}) =>
    plugin({
      manifest: { id, contributes: contributesTab() },
      grantedCapabilities: webCaps,
      ...over,
    });

  const list = [
    tabbed('a'),
    plugin({ manifest: { id: 'b', contributes: { panel: { title: 'ci' } } } }), // pane only
    tabbed('c', { enablement: { scope: 'off' } }),
    tabbed('d'),
  ];

  it('keeps registry order and drops non-contributors and inactive plugins', () => {
    expect(pluginTabs(list, null).map((p) => p.manifest.id)).toEqual(['a', 'd']);
  });

  it('caps the strip at MAX_PLUGIN_TABS, in registry order (FR-86)', () => {
    expect(MAX_PLUGIN_TABS).toBe(3);
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => tabbed(id));
    expect(pluginTabs(many, null).map((p) => p.manifest.id)).toEqual(['a', 'b', 'c']);
  });

  it('resolves every visible tab exactly once, so a strip entry always HAS one', () => {
    // FR-82a: the core drops a tab whose on-disk url no longer matches the one
    // consented to. The gate and the resolution must therefore be the same
    // decision — two places encoding "does this plugin have a tab?" is how a
    // strip entry ends up pointing at a blank main pane.
    const entries = resolvedPluginTabs([tabbed('a'), plugin({ manifest: { id: 'b' } })], null);
    expect(entries.map((e) => e.plugin.manifest.id)).toEqual(['a']);
    expect(entries[0].tab).toEqual(resolvePluginTab(tabbed('a')));
    expect(pluginTabs([tabbed('a'), plugin({ manifest: { id: 'b' } })], null).map((p) => p.manifest.id)).toEqual([
      'a',
    ]);
  });

  it('leaves a tab-changed plugin working everywhere else (FR-82a)', () => {
    // FR-82a drops ONLY the tab: consentPending stays false, so the panel, the
    // commands and the status item keep working and the row carries a plain
    // `error` tag. That is a different state from a QUARANTINED entry, which is
    // inert everywhere — and the two must not be told apart by `lastError`'s
    // wording or by its `surface`, which is 'panel' for both.
    const tabChanged = plugin({
      manifest: {
        id: 'acme-ci',
        contributes: { panel: { title: 'ci' }, commands: [{ id: 'open-run', title: 'Open run' }] },
        capabilities: { network: { hosts: [HOST] }, webTab: true },
      },
      grantedCapabilities: webCaps,
      consentPending: false,
      lastError: { at: 1, surface: 'panel', message: "this plugin's tab address changed on disk — reinstall it" },
    });

    expect(resolvedPluginTabs([tabChanged], null)).toEqual([]);
    expect(consentPendingReason(tabChanged)).toBeNull();
    expect(pluginRowTags(tabChanged, false).map((t) => t.label)).toEqual(['error']);
    expect(pluginPanes([tabChanged], null)).toHaveLength(1);
    expect(pluginPaletteEntries([tabChanged])).toHaveLength(1);
  });

  it('does not let a dropped tab consume one of the three slots (FR-82a, FR-86)', () => {
    // A plugin the core stripped `contributes.tab` from is not a tab that
    // failed to render — it is not a tab at all, and it must not push a later
    // contributor out of the strip.
    const dropped = plugin({
      manifest: { id: 'dropped', contributes: {} },
      grantedCapabilities: webCaps,
      lastError: { at: 1, surface: 'panel', message: 'tab dropped' },
    });
    const list = [tabbed('a'), dropped, tabbed('b'), tabbed('c'), tabbed('d')];
    expect(resolvedPluginTabs(list, null).map((e) => e.plugin.manifest.id)).toEqual(['a', 'b', 'c']);
  });

  it('contributes no tab while consent is pending (FR-16)', () => {
    // A consentPending plugin's ON-DISK manifest wants more than was granted —
    // which means the url in it is one the user never consented to. Framing it
    // is precisely the thing FR-81 makes impossible after consent.
    expect(pluginTabs([tabbed('a', { consentPending: true })], null)).toEqual([]);
  });

  it('contributes no tab when webTab was never granted (FR-81)', () => {
    const ungranted = tabbed('a', { grantedCapabilities: { network: { hosts: [HOST] } } });
    expect(pluginTabs([ungranted], null)).toEqual([]);
  });

  it('scopes tabs by project exactly as panes are scoped', () => {
    const scoped = [tabbed('a', { enablement: { scope: 'projects', projectIds: ['p1'] } })];
    expect(pluginTabs(scoped, 'p1')).toHaveLength(1);
    expect(pluginTabs(scoped, 'p2')).toHaveLength(0);
  });

  it('uppercases and truncates the title to TAB_MAX_TITLE (§8·H31)', () => {
    expect(tabTitle('cohorte')).toBe('COHORTE');
    expect(TAB_MAX_TITLE).toBe(12);
    expect(tabTitle('a-very-long-plugin-tab-title')).toHaveLength(TAB_MAX_TITLE);
  });

  it('uses a DIFFERENT prefix from pane ids so a bare string is never ambiguous', () => {
    // A plugin may contribute both surfaces; one shared prefix would make
    // 'plugin:acme' mean either at every boundary that takes a string.
    expect(pluginTabId('acme')).not.toBe(pluginPaneId('acme'));
    expect(isPluginTabId(pluginPaneId('acme'))).toBe(false);
    expect(isPluginTabId(pluginTabId('acme'))).toBe(true);
    expect(pluginIdOfTab(pluginTabId('acme'))).toBe('acme');
  });

  it('reports the static tabs as always visible', () => {
    for (const t of ['overview', 'session', 'diff', 'shell']) {
      expect(isTabStillVisible(t, [])).toBe(true);
    }
  });

  it('reports a tab whose plugin disappeared as no longer visible', () => {
    // The regression this pins: disabling a plugin (or filtering to another
    // project) while its tab is selected would otherwise leave the main pane
    // rendering nothing, with no tab selected to get back from.
    const visible = pluginTabs(list, null).map((p) => p.manifest.id);
    expect(isTabStillVisible(pluginTabId('a'), visible)).toBe(true);
    expect(isTabStillVisible(pluginTabId('c'), visible)).toBe(false);
    expect(isTabStillVisible(pluginTabId('gone'), visible)).toBe(false);
  });

  // ---------- FR-81: the url is STATIC manifest data ----------

  it('resolves the tab from the MANIFEST, never from a handler result', () => {
    const resolved = resolvePluginTab(tabbed('acme-ci'));
    expect(resolved).toEqual({
      pluginId: 'acme-ci',
      title: 'COHORTE',
      url: URL_OK,
      glyph: DEFAULT_PLUGIN_GLYPH,
    });
  });

  it('keeps a declared glyph and returns null with no contribution', () => {
    const glyphed = plugin({
      manifest: { id: 'x', contributes: { tab: { title: 't', url: URL_OK, glyph: '★' } } },
      grantedCapabilities: webCaps,
    });
    expect(resolvePluginTab(glyphed)?.glyph).toBe('★');
    expect(resolvePluginTab(plugin())).toBeNull();
  });

  // ---------- FR-85: the frontend re-validates before rendering ----------

  it('accepts an https url whose host is on the plugin OWN allowlist', () => {
    expect(checkTabUrl(URL_OK, webCaps)).toEqual({ ok: true, host: HOST });
    expect(checkTabUrl(`https://${HOST.toUpperCase()}/x`, webCaps)).toEqual({ ok: true, host: HOST });
  });

  it('refuses http:// — loopback INCLUDED (FR-82)', () => {
    // francois.fetch exempts http://127.0.0.1 (FR-31) because a fetch returns
    // inert bytes to the isolate. A frame executes them. Same string, different
    // blast radius.
    const loopback: PluginCapabilities = { network: { hosts: ['127.0.0.1'] }, webTab: true };
    expect(checkTabUrl('http://127.0.0.1:8080/', loopback)).toEqual({ ok: false, reason: 'scheme' });
    expect(checkTabUrl(`http://${HOST}/board`, webCaps)).toEqual({ ok: false, reason: 'scheme' });
    expect(PLUGIN_TAB_SCHEMES).toEqual(['https:']);
  });

  it('refuses a scheme that supplies the DOCUMENT rather than naming one', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<h1>x', 'blob:https://ci.acme.dev/1', 'file:///etc/passwd']) {
      expect(checkTabUrl(url, webCaps).ok).toBe(false);
    }
  });

  it('refuses a host that is not on the allowlist, and a missing allowlist', () => {
    expect(checkTabUrl('https://evil.example/x', webCaps)).toEqual({ ok: false, reason: 'host' });
    expect(checkTabUrl(URL_OK, { webTab: true })).toEqual({ ok: false, reason: 'host' });
  });

  it('refuses a malformed url instead of handing it to the frame', () => {
    expect(checkTabUrl('not a url', webCaps)).toEqual({ ok: false, reason: 'malformed' });
    expect(checkTabUrl('', webCaps)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('matches a wildcard host the way the core does — one label or the apex', () => {
    const wild: PluginCapabilities = { network: { hosts: ['*.acme.dev'] }, webTab: true };
    for (const host of ['a.acme.dev', 'acme.dev', 'WWW.acme.dev']) {
      expect(checkTabUrl(`https://${host}/`, wild).ok).toBe(true);
    }
    for (const host of ['x.y.acme.dev', 'evil-acme.dev', 'acme.dev.evil.com']) {
      expect(checkTabUrl(`https://${host}/`, wild).ok).toBe(false);
    }
  });

  // ---------- FR-83: the sandbox ----------

  it('frames without allow-same-origin and without allow-popups (FR-83)', () => {
    const tokens = PLUGIN_TAB_SANDBOX.split(' ');
    expect(tokens).toContain('allow-scripts');
    expect(tokens).toContain('allow-forms');
    expect(tokens).toContain('allow-popups-to-escape-sandbox');
    // Token equality, not substring: 'allow-popups-to-escape-sandbox' CONTAINS
    // 'allow-popups', so a substring check here would pass while the real
    // boundary was gone.
    expect(tokens).not.toContain('allow-same-origin');
    expect(tokens).not.toContain('allow-popups');
  });

  // ---------- §8 · H copy ----------

  it('words the attribution strip, the loading line and the blocked state', () => {
    expect(tabAttribution('Acme CI', HOST)).toBe(`${DEFAULT_PLUGIN_GLYPH} Acme CI · ${HOST}`);
    expect(tabLoadingLine(HOST)).toBe(`loading ${HOST}…`);
    expect(TAB_COPY_ADDRESS).toBe('copy address');
    expect(TAB_ADDRESS_COPIED).toBe('url copied — paste in your browser');
    expect(TAB_BLOCKED_LINE).toBe("this tab's address is not allowed");
    expect(TAB_BLOCKED_HINT).toBe('the plugin may have been tampered with — review it in ⌘K → Manage plugins');
  });
});
