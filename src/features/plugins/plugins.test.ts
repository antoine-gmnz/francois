// plugin-system — unit tests over the pure frontend logic (src/features/plugins/
// plugins.ts) and the zustand slice (pluginsStore.ts). Node env, no DOM: per
// PIPELINE.md §Testing the frontend covers stores, derived selectors and the
// contract-typed wrappers/handlers — layout and visuals are not unit-testable.
//
// Spec: specs/plugin-system.md (§6 state, §8 design brief, §9 acceptance).

import { beforeEach, describe, expect, it } from 'vitest';
import type {
  InstalledPlugin,
  PanelNode,
  PanelSpec,
  PluginEnablement,
  PluginEvent,
  PluginManifest,
  PluginSettingDescriptor,
  PluginSettingsView,
  PluginUpdateInfo,
  StatusItemSpec,
} from '../../../contract/plugin-system';
import {
  DEFAULT_PLUGIN_GLYPH,
  PANEL_INVALID_NODE,
  PANEL_NODE_TYPES,
  PLUGIN_FAILURE_LIMIT,
  PLUGIN_PANE_TITLE_MAX,
  REFRESH_INTERVAL_MAX_MS,
  REFRESH_INTERVAL_MIN_MS,
  SECRET_SENTINEL,
  STATUS_ITEM_MAX_VISIBLE,
  pluginPaletteCommandId,
  pluginPaneId,
} from '../../../contract/plugin-system';
import {
  CONSENT_PENDING_LINE,
  EXFILTRATION_WARNING,
  INJECTION_INTENT_LINE,
  SECRET_PLACEHOLDER,
  activePlugins,
  capabilityRows,
  coerceSettingValue,
  declaredCommandIds,
  enablementMode,
  failureKey,
  findSelectableList,
  formatExpiresIn,
  humanBytes,
  injectionCardClass,
  injectionStateNote,
  installPhaseLabel,
  installedCountLabel,
  isActionInert,
  isPluginEnabled,
  isSecretSet,
  moveListSelection,
  paletteSyncPlan,
  paneCount,
  paneCountLabel,
  paneTitle,
  pluginAttributionLine,
  pluginCommandEnabled,
  pluginPaletteEntries,
  pluginPaneHotkeys,
  pluginPanes,
  pluginRowSubtitle,
  pluginRowTags,
  queuedNote,
  refreshIntervalFor,
  secretDisplay,
  selectionAction,
  settingPatch,
  settingsFormValues,
  shortRef,
  shouldRefresh,
  showsExfiltrationWarning,
  sourceLine,
  statusItemPlugins,
  toggleProjectScope,
  toneColor,
  uninstallConfirmText,
  updateRowLabel,
  validPanelNode,
  visibleStatusItems,
} from './plugins';
import { usePluginsStore } from './pluginsStore';

// ---------- fixtures ----------

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

const spec = (nodes: PanelNode[], over: Partial<PanelSpec> = {}): PanelSpec => ({ version: 1, nodes, ...over });

// ============================================================================
// FR-35 — the frozen v1 vocabulary
// ============================================================================

describe('PanelSpec v1 vocabulary (FR-35)', () => {
  it('names exactly ten node types', () => {
    expect(PANEL_NODE_TYPES.length).toBe(10);
    expect([...PANEL_NODE_TYPES]).toEqual([
      'text',
      'row',
      'stack',
      'list',
      'badge',
      'keyhint',
      'divider',
      'action',
      'progress',
      'spinner',
    ]);
  });

  it('accepts every well-formed node type', () => {
    const nodes: PanelNode[] = [
      { type: 'text', value: 'hi' },
      { type: 'row', children: [] },
      { type: 'stack', children: [] },
      { type: 'list', items: [] },
      { type: 'badge', value: 'ok' },
      { type: 'keyhint', value: '⏎' },
      { type: 'divider' },
      { type: 'action', label: 'open', commandId: 'open-run' },
      { type: 'progress', percent: 40 },
      { type: 'spinner' },
    ];
    for (const n of nodes) expect(validPanelNode(n)).toBe(true);
    expect(nodes.length).toBe(PANEL_NODE_TYPES.length);
  });

  it('rejects an unknown type, a missing field and a wrong field type', () => {
    expect(validPanelNode({ type: 'iframe', src: 'evil' })).toBe(false);
    expect(validPanelNode({ type: 'text' })).toBe(false);
    expect(validPanelNode({ type: 'text', value: 12 })).toBe(false);
    expect(validPanelNode({ type: 'row', children: 'nope' })).toBe(false);
    expect(validPanelNode({ type: 'progress', percent: 'half' })).toBe(false);
    expect(validPanelNode({ type: 'action', label: 'x' })).toBe(false);
    expect(validPanelNode(null)).toBe(false);
    expect(validPanelNode('text')).toBe(false);
  });

  it('names the placeholder an invalid node renders as', () => {
    expect(PANEL_INVALID_NODE).toBe('⟨invalid node⟩');
  });
});

describe('toneColor (FR-37)', () => {
  it('maps every tone to an existing token, defaulting to --text', () => {
    expect(toneColor(undefined)).toBe('var(--text)');
    expect(toneColor('default')).toBe('var(--text)');
    expect(toneColor('dim')).toBe('var(--text-faint)');
    expect(toneColor('accent')).toBe('var(--accent)');
    expect(toneColor('success')).toBe('var(--success)');
    expect(toneColor('warn')).toBe('var(--warn)');
    expect(toneColor('error')).toBe('var(--error)');
  });
});

// ============================================================================
// FR-40 / FR-38 — list selection and inert actions
// ============================================================================

describe('list selection (FR-40)', () => {
  const inner: PanelNode = { type: 'list', items: [{ type: 'text', value: 'a' }], selectable: true };
  const outer = spec([
    { type: 'list', items: [{ type: 'text', value: 'plain' }] },
    { type: 'stack', children: [inner] },
    { type: 'list', items: [], selectable: true },
  ]);

  it('picks the FIRST selectable list in document order, nested included', () => {
    expect(findSelectableList(outer.nodes)).toBe(inner);
  });

  it('returns null when no list is selectable', () => {
    expect(findSelectableList([{ type: 'list', items: [] }])).toBeNull();
    expect(findSelectableList([])).toBeNull();
  });

  it('moves the index clamped, with no wrap', () => {
    expect(moveListSelection(4, 0, -1)).toBe(0);
    expect(moveListSelection(4, 0, 1)).toBe(1);
    expect(moveListSelection(4, 3, 1)).toBe(3);
    expect(moveListSelection(4, 9, 1)).toBe(3);
    expect(moveListSelection(4, -3, -1)).toBe(0);
    expect(moveListSelection(0, 0, 1)).toBe(0);
  });

  it('fires the first `action` node in document order inside the selected item', () => {
    const declared = new Set(['open-run', 'rerun']);
    const list: PanelNode = {
      type: 'list',
      selectable: true,
      items: [
        { type: 'row', children: [{ type: 'text', value: 'run 1' }, { type: 'action', label: 'a', commandId: 'rerun' }] },
        {
          type: 'stack',
          children: [
            { type: 'text', value: 'run 2' },
            { type: 'row', children: [{ type: 'action', label: 'open', commandId: 'open-run', args: { runId: '4821' } }] },
            { type: 'action', label: 'second', commandId: 'rerun' },
          ],
        },
      ],
    };
    const s = spec([list]);
    expect(selectionAction(s, 0, declared)).toEqual({ commandId: 'rerun', args: undefined });
    expect(selectionAction(s, 1, declared)).toEqual({ commandId: 'open-run', args: { runId: '4821' } });
    expect(selectionAction(s, 5, declared)).toBeNull();
    expect(selectionAction(null, 0, declared)).toBeNull();
  });

  it('does not fire an undeclared action (FR-38)', () => {
    const s = spec([
      { type: 'list', selectable: true, items: [{ type: 'action', label: 'x', commandId: 'ghost' }] },
    ]);
    expect(selectionAction(s, 0, new Set(['open-run']))).toBeNull();
  });

  it('returns null when the selected item holds no action at all', () => {
    const s = spec([{ type: 'list', selectable: true, items: [{ type: 'text', value: 'only text' }] }]);
    expect(selectionAction(s, 0, new Set(['open-run']))).toBeNull();
  });
});

describe('inert actions (FR-38)', () => {
  it('treats an action naming an undeclared command as inert', () => {
    const declared = declaredCommandIds(
      manifest({ contributes: { commands: [{ id: 'open-run', title: 'Open run' }] } }),
    );
    expect(isActionInert('open-run', declared)).toBe(false);
    expect(isActionInert('ghost', declared)).toBe(true);
    expect(isActionInert('open-run', declaredCommandIds(manifest()))).toBe(true);
  });
});

// ============================================================================
// FR-46..FR-49, FR-76 — surfaces derived from the registry × the project filter
// ============================================================================

describe('enablement (FR-75/FR-76/FR-77)', () => {
  const cases: [PluginEnablement, string | null, boolean][] = [
    [{ scope: 'off' }, null, false],
    [{ scope: 'off' }, 'p1', false],
    [{ scope: 'all' }, null, true],
    [{ scope: 'all' }, 'p1', true],
    [{ scope: 'projects', projectIds: ['p1'] }, 'p1', true],
    [{ scope: 'projects', projectIds: ['p1'] }, 'p2', false],
    // All projects: the union — any non-empty set is active (FR-76)
    [{ scope: 'projects', projectIds: ['p1'] }, null, true],
    [{ scope: 'projects', projectIds: [] }, null, false],
    [{ scope: 'projects', projectIds: [] }, 'p1', false],
  ];
  for (const [enablement, scope, expected] of cases) {
    it(`${JSON.stringify(enablement)} under ${scope ?? 'All'} → ${expected}`, () => {
      expect(isPluginEnabled(plugin({ enablement }), scope)).toBe(expected);
    });
  }

  it('activePlugins re-evaluates on a scope switch (FR-76)', () => {
    const list = [
      plugin({ manifest: { id: 'a' }, enablement: { scope: 'all' } }),
      plugin({ manifest: { id: 'b' }, enablement: { scope: 'projects', projectIds: ['p2'] } }),
      plugin({ manifest: { id: 'c' }, enablement: { scope: 'off' } }),
    ];
    expect(activePlugins(list, 'p1').map((p) => p.manifest.id)).toEqual(['a']);
    expect(activePlugins(list, 'p2').map((p) => p.manifest.id)).toEqual(['a', 'b']);
    expect(activePlugins(list, null).map((p) => p.manifest.id)).toEqual(['a', 'b']);
  });
});

describe('plugin panes (FR-46/FR-47/FR-48)', () => {
  const panel = { panel: { title: 'ci runs' } };
  const list = [
    plugin({ manifest: { id: 'a', contributes: panel } }),
    plugin({ manifest: { id: 'b', contributes: {} } }), // contributes no panel
    plugin({ manifest: { id: 'c', contributes: panel } }),
    plugin({ manifest: { id: 'd', contributes: panel }, enablement: { scope: 'off' } }),
    plugin({ manifest: { id: 'e', contributes: panel } }),
    plugin({ manifest: { id: 'f', contributes: panel } }),
    plugin({ manifest: { id: 'g', contributes: panel } }),
  ];

  it('keeps registry order and drops non-contributors and inactive plugins', () => {
    expect(pluginPanes(list, null).map((p) => p.manifest.id)).toEqual(['a', 'c', 'e', 'f', 'g']);
  });

  it('keeps a consentPending pane so it can show the FR-16 state', () => {
    const withPending = [plugin({ manifest: { id: 'a', contributes: panel }, consentPending: true })];
    expect(pluginPanes(withPending, null)).toHaveLength(1);
    expect(CONSENT_PENDING_LINE).toBe('new permissions — review to re-enable');
  });

  it('binds 6-9 to the first four visible panes only (FR-47, edge 46)', () => {
    const panes = pluginPanes(list, null);
    const keys = pluginPaneHotkeys(panes);
    expect(keys[pluginPaneId('a')]).toBe('6');
    expect(keys[pluginPaneId('c')]).toBe('7');
    expect(keys[pluginPaneId('e')]).toBe('8');
    expect(keys[pluginPaneId('f')]).toBe('9');
    expect(keys[pluginPaneId('g')]).toBeNull();
  });

  it('uppercases and truncates the pane title to 18 chars (FR-46)', () => {
    expect(paneTitle('ci runs')).toBe('CI RUNS');
    expect(paneTitle('an extremely long panel title')).toHaveLength(PLUGIN_PANE_TITLE_MAX);
    expect(paneTitle('an extremely long panel title')).toBe('AN EXTREMELY LONG ');
  });

  it('counts the first top-level list, else the top-level node count (FR-46)', () => {
    expect(paneCount(null)).toBe(0);
    expect(paneCount(spec([]))).toBe(0);
    expect(paneCount(spec([{ type: 'text', value: 'a' }, { type: 'divider' }]))).toBe(2);
    expect(
      paneCount(
        spec([
          { type: 'text', value: 'header' },
          { type: 'list', items: [{ type: 'text', value: '1' }, { type: 'text', value: '2' }] },
          { type: 'list', items: [] },
        ]),
      ),
    ).toBe(2);
  });

  it('labels the pane header <n> · [<hotkey>], or <n> alone with no hotkey (§8·A1)', () => {
    expect(paneCountLabel(4, '6')).toBe('4 · [6]');
    expect(paneCountLabel(0, null)).toBe('0');
  });
});

describe('status-bar items (FR-49)', () => {
  const statusBar = { statusBar: {} as Record<string, never> };
  const list = [
    plugin({ manifest: { id: 'a', contributes: statusBar } }),
    plugin({ manifest: { id: 'b', contributes: {} } }),
    plugin({ manifest: { id: 'c', contributes: statusBar }, consentPending: true }), // FR-16: hidden
    plugin({ manifest: { id: 'd', contributes: statusBar } }),
    plugin({ manifest: { id: 'e', contributes: statusBar } }),
    plugin({ manifest: { id: 'f', contributes: statusBar } }),
  ];

  it('caps the contributors at three, in registry order (edge 47)', () => {
    expect(STATUS_ITEM_MAX_VISIBLE).toBe(3);
    expect(statusItemPlugins(list, null).map((p) => p.manifest.id)).toEqual(['a', 'd', 'e']);
  });

  it('renders only the contributors whose handler returned an item (FR-43)', () => {
    const item: StatusItemSpec = { version: 1, text: 'ci ok' };
    const items = { a: item, d: null, e: item };
    expect(visibleStatusItems(list, null, items).map((x) => x.pluginId)).toEqual(['a', 'e']);
    expect(visibleStatusItems(list, null, items)[0].item).toBe(item);
  });
});

describe('palette entries (FR-50/FR-51/FR-52)', () => {
  const withCommands = (id: string) =>
    plugin({
      manifest: {
        id,
        name: id.toUpperCase(),
        contributes: {
          commands: [
            { id: 'open-run', title: 'Open run' },
            { id: 'hidden', title: 'Hidden', palette: false },
            { id: 'glyphed', title: 'Glyphed', glyph: '★' },
          ],
        },
      },
    });

  it('namespaces the id and attributes the row with the plugin name', () => {
    const entries = pluginPaletteEntries([withCommands('acme-ci')]);
    expect(entries.map((e) => e.id)).toEqual([
      pluginPaletteCommandId('acme-ci', 'open-run'),
      pluginPaletteCommandId('acme-ci', 'glyphed'),
    ]);
    expect(entries[0].id).toBe('plugin:acme-ci:open-run');
    expect(entries[0].name).toBe('Open run');
    expect(entries[0].hint).toBe('ACME-CI');
    expect(entries[0].glyph).toBe(DEFAULT_PLUGIN_GLYPH);
    expect(entries[1].glyph).toBe('★');
  });

  it('lets two plugins declare the same commandId without collision (edge 48)', () => {
    const entries = pluginPaletteEntries([withCommands('acme-ci'), withCommands('other-ci')]);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });

  it('registers nothing for a consentPending plugin (FR-16, §3·F5)', () => {
    const p = withCommands('acme-ci');
    expect(pluginPaletteEntries([{ ...p, consentPending: true }])).toEqual([]);
  });

  it('disables a row while the plugin is inert, out of scope, or busy (FR-50)', () => {
    const p = withCommands('acme-ci');
    expect(pluginCommandEnabled(p, null, false)).toBe(true);
    expect(pluginCommandEnabled(p, null, true)).toBe(false); // in-flight invocation
    expect(pluginCommandEnabled({ ...p, consentPending: true }, null, false)).toBe(false);
    expect(pluginCommandEnabled({ ...p, enablement: { scope: 'off' } }, null, false)).toBe(false);
  });

  it('plans the registration diff so a scope change re-syncs the registry', () => {
    const entries = pluginPaletteEntries([withCommands('acme-ci')]);
    const fresh = paletteSyncPlan([], entries);
    expect(fresh.add).toEqual(entries);
    expect(fresh.remove).toEqual([]);

    const stale = paletteSyncPlan([entries[0].id, 'plugin:gone:x'], entries);
    expect(stale.add.map((e) => e.id)).toEqual([entries[1].id]);
    expect(stale.remove).toEqual(['plugin:gone:x']);
  });
});

// ============================================================================
// FR-70/FR-72/FR-73 — the frontend-driven refresh timer
// ============================================================================

describe('refresh timer (FR-70/FR-73)', () => {
  it('clamps the declared interval, and treats an absent one as no polling', () => {
    expect(refreshIntervalFor(manifest())).toBeNull();
    expect(refreshIntervalFor(manifest({ refreshIntervalMs: 30_000 }))).toBe(30_000);
    expect(refreshIntervalFor(manifest({ refreshIntervalMs: 1 }))).toBe(REFRESH_INTERVAL_MIN_MS);
    expect(refreshIntervalFor(manifest({ refreshIntervalMs: 9_999_999 }))).toBe(REFRESH_INTERVAL_MAX_MS);
  });

  const base = {
    intervalMs: 30_000,
    documentVisible: true,
    failures: 0,
    consentPending: false,
    enabled: true,
  };

  it('runs only while visible, enabled, consented and under the failure limit', () => {
    expect(shouldRefresh(base)).toBe(true);
    expect(shouldRefresh({ ...base, documentVisible: false })).toBe(false); // FR-70
    expect(shouldRefresh({ ...base, intervalMs: null })).toBe(false);
    expect(shouldRefresh({ ...base, enabled: false })).toBe(false);
    expect(shouldRefresh({ ...base, consentPending: true })).toBe(false); // FR-16
    expect(shouldRefresh({ ...base, failures: PLUGIN_FAILURE_LIMIT - 1 })).toBe(true);
    expect(shouldRefresh({ ...base, failures: PLUGIN_FAILURE_LIMIT })).toBe(false); // FR-73
  });

  it('keys the failure counter per plugin AND surface', () => {
    expect(failureKey('acme-ci', 'panel')).toBe('acme-ci:panel');
    expect(failureKey('acme-ci', 'statusBar')).not.toBe(failureKey('acme-ci', 'panel'));
  });
});

// ============================================================================
// Settings & secrets (FR-61..FR-64)
// ============================================================================

describe('settings form (FR-61/FR-62/FR-63/FR-64)', () => {
  const descriptors: PluginSettingDescriptor[] = [
    { key: 'repo', type: 'string', label: 'owner/repo', default: 'acme/x' },
    { key: 'poll', type: 'number', label: 'poll interval (s)', min: 5, max: 600 },
    { key: 'verbose', type: 'boolean', label: 'verbose', default: true },
    { key: 'branch', type: 'select', label: 'branch', options: [{ value: 'main', label: 'main' }] },
    { key: 'token', type: 'secret', label: 'github token' },
  ];

  it('overlays stored values on declared defaults, in descriptor order', () => {
    const view: PluginSettingsView = { poll: 30, token: SECRET_SENTINEL };
    const form = settingsFormValues(descriptors, view);
    expect(Object.keys(form)).toEqual(['repo', 'poll', 'verbose', 'branch', 'token']);
    expect(form).toEqual({
      repo: 'acme/x',
      poll: '30',
      verbose: true,
      branch: '',
      token: SECRET_SENTINEL,
    });
  });

  it('coerces every descriptor type and rejects invalid values', () => {
    expect(coerceSettingValue(descriptors[0], 'acme/y')).toBe('acme/y');
    expect(coerceSettingValue(descriptors[1], '42')).toBe(42);
    expect(coerceSettingValue(descriptors[1], '2')).toBeNull(); // < min
    expect(coerceSettingValue(descriptors[1], '900')).toBeNull(); // > max
    expect(coerceSettingValue(descriptors[1], 'x')).toBeNull(); // NaN
    expect(coerceSettingValue(descriptors[2], false)).toBe(false);
    expect(coerceSettingValue(descriptors[3], 'main')).toBe('main');
    expect(coerceSettingValue(descriptors[3], 'dev')).toBeNull(); // not in options
  });

  it('renders a secret as •••••• when set and "not set" when unset', () => {
    expect(isSecretSet(SECRET_SENTINEL)).toBe(true);
    expect(isSecretSet('')).toBe(false);
    expect(secretDisplay(SECRET_SENTINEL)).toBe(SECRET_SENTINEL);
    expect(secretDisplay('')).toBe('');
    expect(SECRET_PLACEHOLDER).toBe('not set');
  });

  it('never re-writes the sentinel, and clears with an empty string (FR-64, edge 43)', () => {
    const secret = descriptors[4];
    expect(settingPatch(secret, SECRET_SENTINEL)).toBeNull(); // round-trip is a no-op
    expect(settingPatch(secret, 'ghp_live')).toEqual({ token: 'ghp_live' });
    expect(settingPatch(secret, '')).toEqual({ token: '' }); // explicit clear
  });

  it('emits a one-key patch, or null when the value is invalid', () => {
    expect(settingPatch(descriptors[1], '42')).toEqual({ poll: 42 });
    expect(settingPatch(descriptors[1], '2')).toBeNull();
    expect(settingPatch(descriptors[2], true)).toEqual({ verbose: true });
  });
});

// ============================================================================
// Consent card & modal copy (FR-11/FR-13, §8·C/D)
// ============================================================================

describe('consent card (FR-11, §8·C4/D13)', () => {
  it('lists one row per granted capability, in display order, hosts verbatim', () => {
    const rows = capabilityRows({ readState: true, network: { hosts: ['api.github.com', '*.acme.dev'] } });
    expect(rows.map((r) => r.key)).toEqual(['readState', 'network']);
    expect(rows[0].sentence).toBe('read your sessions, projects, diffs and agent activity');
    expect(rows[1].sentence).toBe('reach the network, limited to the domains below');
    expect(rows[1].hosts).toEqual(['api.github.com', '*.acme.dev']);
  });

  it('marks added capabilities and hosts for the update diff (FR-13, §8·D15)', () => {
    const rows = capabilityRows(
      { readState: true, driveSessions: true, network: { hosts: ['api.github.com', 'telemetry.acme.dev'] } },
      ['driveSessions'],
      ['telemetry.acme.dev'],
    );
    expect(rows.find((r) => r.key === 'driveSessions')?.added).toBe(true);
    expect(rows.find((r) => r.key === 'readState')?.added).toBe(false);
    expect(rows.find((r) => r.key === 'network')?.addedHosts).toEqual(['telemetry.acme.dev']);
  });

  it('shows the standing warning only when readState AND network are both granted', () => {
    expect(showsExfiltrationWarning({ readState: true, network: { hosts: ['a'] } })).toBe(true);
    expect(showsExfiltrationWarning({ readState: true })).toBe(false);
    expect(showsExfiltrationWarning({ network: { hosts: ['a'] } })).toBe(false);
    expect(EXFILTRATION_WARNING).toBe(
      'a plugin that can both read your state and reach the network can send what it reads there. only install plugins you trust.',
    );
  });

  it('renders the source line and abbreviates a 40-char sha to 8', () => {
    expect(sourceLine({ kind: 'github', spec: 'acme/francois-ci' }, '8f2c1a9')).toBe(
      'github · acme/francois-ci @ 8f2c1a9',
    );
    expect(shortRef('8f2c1a9d3b4e5f60718293a4b5c6d7e8f9012345')).toBe('8f2c1a9d');
    expect(shortRef('1.2.0')).toBe('1.2.0');
  });

  it('humanizes the unpacked size', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(1536)).toBe('1.5 KB');
    expect(humanBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('labels each install phase', () => {
    expect(installPhaseLabel('resolving')).toBe('resolving…');
    expect(installPhaseLabel('downloading')).toBe('downloading…');
    expect(installPhaseLabel('verifying')).toBe('verifying…');
    expect(installPhaseLabel('unpacking')).toBe('unpacking…');
    expect(installPhaseLabel('done')).toBe('done');
    expect(installPhaseLabel('failed')).toBe('failed');
  });
});

describe('modal copy (§8·C)', () => {
  it('counts installed plugins and describes a row', () => {
    expect(installedCountLabel(0)).toBe('0 installed');
    expect(installedCountLabel(1)).toBe('1 installed');
    expect(pluginRowSubtitle(plugin())).toBe('1.2.0 · github');
  });

  it('tags a row in §8·C8 order', () => {
    expect(pluginRowTags(plugin(), false)).toEqual([]);
    expect(pluginRowTags(plugin({ enablement: { scope: 'off' } }), false).map((t) => t.label)).toEqual(['off']);
    const busted = plugin({
      enablement: { scope: 'off' },
      consentPending: true,
      lastError: { at: 1, surface: 'panel', message: 'boom' },
    });
    expect(pluginRowTags(busted, true).map((t) => t.label)).toEqual(['off', 'error', 'new permissions', 'update']);
  });

  it('words the update control (§3·F2)', () => {
    const info: PluginUpdateInfo = {
      available: true,
      currentRef: 'a',
      currentVersion: '1.2.0',
      newRef: 'b',
      newVersion: '1.3.0',
      capabilitiesWidened: true,
      addedCapabilities: ['network'],
      addedHosts: ['telemetry.acme.dev'],
    };
    expect(updateRowLabel(info)).toBe('update available · 1.3.0 · new permissions');
    expect(updateRowLabel({ ...info, capabilitiesWidened: false })).toBe('update available · 1.3.0');
    expect(updateRowLabel({ ...info, available: false })).toBeNull();
  });

  it('confirms an uninstall in place (§8·C9)', () => {
    expect(uninstallConfirmText('Acme CI')).toBe(
      'uninstall "Acme CI"? its settings and stored data are deleted.',
    );
  });

  it('reads and edits the enablement control (§8·C9)', () => {
    expect(enablementMode({ scope: 'off' })).toBe('off');
    expect(enablementMode({ scope: 'projects', projectIds: [] })).toBe('projects');
    expect(toggleProjectScope({ scope: 'all' }, 'p1')).toEqual({ scope: 'projects', projectIds: ['p1'] });
    expect(toggleProjectScope({ scope: 'projects', projectIds: ['p1'] }, 'p2')).toEqual({
      scope: 'projects',
      projectIds: ['p1', 'p2'],
    });
    expect(toggleProjectScope({ scope: 'projects', projectIds: ['p1', 'p2'] }, 'p1')).toEqual({
      scope: 'projects',
      projectIds: ['p2'],
    });
  });
});

// ============================================================================
// Injection card & attribution (§8·E/F)
// ============================================================================

describe('injection card (§8·E, FR-58)', () => {
  it('notes the resolved state on the header row', () => {
    expect(injectionStateNote('pending')).toBeNull();
    expect(injectionStateNote('approved')).toBe('— approved');
    expect(injectionStateNote('denied')).toBe('— denied');
    expect(injectionStateNote('expired')).toBe('— expired');
  });

  it('classes the card by state, dimming while in flight', () => {
    expect(injectionCardClass('pending', false)).toBe('picard picard-pending');
    expect(injectionCardClass('pending', true)).toBe('picard picard-pending picard-inflight');
    expect(injectionCardClass('approved', true)).toBe('picard picard-approved');
  });

  it('counts down mm:ss, clamped at zero', () => {
    expect(formatExpiresIn(1_000 + 600_000, 1_000)).toBe('10:00');
    expect(formatExpiresIn(1_000 + 65_000, 1_000)).toBe('01:05');
    expect(formatExpiresIn(1_000, 999_999)).toBe('00:00');
  });

  it('surfaces the queue position only when the send was enqueued (§8·E23)', () => {
    expect(queuedNote(undefined)).toBeNull();
    expect(queuedNote(2)).toBe('queued · #2');
  });

  it('states the intent verbatim', () => {
    expect(INJECTION_INTENT_LINE).toBe('wants to send this prompt to this session');
  });

  it('attributes an approved injection permanently (§8·F24)', () => {
    expect(pluginAttributionLine({ kind: 'plugin', pluginId: 'acme-ci', pluginName: 'Acme CI' })).toBe(
      '↳ via plugin Acme CI',
    );
  });
});

// ============================================================================
// The zustand slice (§6)
// ============================================================================

describe('pluginsStore (§6)', () => {
  beforeEach(() => {
    usePluginsStore.getState().reset();
  });

  it('starts empty', () => {
    const s = usePluginsStore.getState();
    expect(s.plugins).toEqual([]);
    expect(s.renderCache).toEqual({});
    expect(s.modalOpen).toBe(false);
  });

  it('folds plugin.registry as the single source of truth (FR-80)', () => {
    const list = [plugin({ manifest: { id: 'a' } }), plugin({ manifest: { id: 'b' } })];
    usePluginsStore.getState().applyPluginEvent({ type: 'plugin.registry', plugins: list });
    expect(usePluginsStore.getState().plugins.map((p) => p.manifest.id)).toEqual(['a', 'b']);
  });

  it('prunes every per-plugin cache when a plugin is uninstalled (FR-74)', () => {
    const st = usePluginsStore.getState();
    st.applyPluginEvent({ type: 'plugin.registry', plugins: [plugin({ manifest: { id: 'a' } })] });
    st.setPanelSpec('a', spec([]));
    st.setStatusItem('a', { version: 1, text: 'ok' });
    st.setSelection('a', 3);
    st.setBusy('a', true);
    st.applyPluginEvent({
      type: 'plugin.error',
      pluginId: 'a',
      error: { at: 1, surface: 'panel', message: 'boom' },
      consecutive: 2,
    });
    expect(usePluginsStore.getState().failures[failureKey('a', 'panel')]).toBe(2);

    st.applyPluginEvent({ type: 'plugin.registry', plugins: [] });
    const after = usePluginsStore.getState();
    expect(after.renderCache).toEqual({});
    expect(after.statusItems).toEqual({});
    expect(after.selection).toEqual({});
    expect(after.busy).toEqual({});
    expect(after.failures).toEqual({});
    expect(after.panelError).toEqual({});
  });

  it('bumps an invalidation revision per surface (FR-71)', () => {
    const st = usePluginsStore.getState();
    const key = failureKey('a', 'panel');
    expect(usePluginsStore.getState().invalidation[key]).toBeUndefined();
    st.applyPluginEvent({ type: 'plugin.invalidated', pluginId: 'a', surface: 'panel' });
    st.applyPluginEvent({ type: 'plugin.invalidated', pluginId: 'a', surface: 'panel' });
    expect(usePluginsStore.getState().invalidation[key]).toBe(2);
    expect(usePluginsStore.getState().invalidation[failureKey('a', 'statusBar')]).toBeUndefined();
  });

  it('records the core-authoritative consecutive count and the panel error (FR-73)', () => {
    const st = usePluginsStore.getState();
    const e: PluginEvent = {
      type: 'plugin.error',
      pluginId: 'a',
      error: { at: 9, surface: 'panel', message: 'execution deadline exceeded' },
      consecutive: 5,
    };
    st.applyPluginEvent(e);
    expect(usePluginsStore.getState().failures[failureKey('a', 'panel')]).toBe(5);
    expect(usePluginsStore.getState().panelError.a).toBe('execution deadline exceeded');

    // a successful render clears both (FR-73)
    st.setPanelSpec('a', spec([]));
    expect(usePluginsStore.getState().failures[failureKey('a', 'panel')]).toBe(0);
    expect(usePluginsStore.getState().panelError.a).toBeNull();
  });

  it('resets the counter on an explicit retry (FR-73)', () => {
    const st = usePluginsStore.getState();
    st.applyPluginEvent({
      type: 'plugin.error',
      pluginId: 'a',
      error: { at: 9, surface: 'panel', message: 'boom' },
      consecutive: 5,
    });
    st.resetFailures('a', 'panel');
    expect(usePluginsStore.getState().failures[failureKey('a', 'panel')]).toBe(0);
  });

  it('tracks install progress by staging id (FR-5)', () => {
    usePluginsStore.getState().applyPluginEvent({
      type: 'plugin.install.progress',
      stagingId: 'stg1',
      phase: 'downloading',
    });
    expect(usePluginsStore.getState().installProgress).toEqual({
      stagingId: 'stg1',
      phase: 'downloading',
      message: undefined,
    });
  });

  it('clamps a stale list selection when the list shrinks (FR-40)', () => {
    const st = usePluginsStore.getState();
    st.setSelection('a', 7);
    expect(usePluginsStore.getState().selection.a).toBe(7);
    st.setSelection('a', -2);
    expect(usePluginsStore.getState().selection.a).toBe(0);
  });

  it('opens and closes the modal on a chosen plugin (FR-51)', () => {
    const st = usePluginsStore.getState();
    st.openModal('acme-ci');
    expect(usePluginsStore.getState().modalOpen).toBe(true);
    expect(usePluginsStore.getState().selectedPluginId).toBe('acme-ci');
    usePluginsStore.getState().closeModal();
    expect(usePluginsStore.getState().modalOpen).toBe(false);
    expect(usePluginsStore.getState().preview).toBeNull();
  });
});
