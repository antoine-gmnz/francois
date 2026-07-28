// plugin-system — feature-local PURE logic (spec §6 "Derived", §8 copy).
//
// Everything here is a function of data the core already validated: the frontend
// renders only core-validated `PanelSpec`/`StatusItemSpec` JSON (FR-36) and never
// re-derives the core's caps. It also never executes plugin code in any form —
// there is no HTML, no CSS, no SVG, no iframe and no eval anywhere in this
// feature; `PanelTone` is the only expressible visual variance (FR-37).
//
// Constants, id helpers and the pane/hotkey tables come from
// contract/plugin-system.ts and are imported, never re-derived.

import type { MessageOrigin, ProjectId } from '../../../contract/common';
import type {
  InstalledPlugin,
  PanelActionArgs,
  PanelNode,
  PanelSpec,
  PanelTone,
  PluginCapabilities,
  PluginCapabilityKey,
  PluginEnablement,
  PluginInjectionBlockState,
  PluginInstallPhase,
  PluginManifest,
  PluginPaneId,
  PluginSettingDescriptor,
  PluginSettingsView,
  PluginSource,
  PluginSurface,
  PluginUpdateInfo,
  StatusItemSpec,
} from '../../../contract/plugin-system';
import {
  DEFAULT_PLUGIN_GLYPH,
  PLUGIN_CAPABILITY_KEYS,
  PLUGIN_FAILURE_LIMIT,
  PLUGIN_PANE_TITLE_MAX,
  REFRESH_INTERVAL_MAX_MS,
  REFRESH_INTERVAL_MIN_MS,
  SECRET_SENTINEL,
  SETTING_MAX_STRING,
  STATUS_ITEM_MAX_VISIBLE,
  pluginIdOfTab,
  pluginPaletteCommandId,
  pluginPaneHotkey,
  pluginPaneId,
} from '../../../contract/plugin-system';

// ============================================================================
// FR-37 — tone → token. The ONLY visual variance a plugin can express.
// ============================================================================

const TONE_TOKENS: Record<PanelTone, string> = {
  default: 'var(--text)',
  dim: 'var(--text-faint)',
  accent: 'var(--accent)',
  success: 'var(--success)',
  warn: 'var(--warn)',
  error: 'var(--error)',
};

export function toneColor(tone?: PanelTone): string {
  return (tone && TONE_TOKENS[tone]) ?? TONE_TOKENS.default;
}

// ============================================================================
// FR-35 — node validation. A malformed node renders ⟨invalid node⟩; it never
// fails the panel, and it never widens what the renderer will draw.
// ============================================================================

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBoolOpt = (v: unknown): boolean => v === undefined || typeof v === 'boolean';
const isStrOpt = (v: unknown): boolean => v === undefined || typeof v === 'string';
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isOneOf = (v: unknown, allowed: readonly string[]): boolean =>
  v === undefined || (isStr(v) && allowed.includes(v));

const TONES = Object.keys(TONE_TOKENS);
const GAPS = ['sm', 'md'];
const ALIGNS = ['start', 'center', 'between'];

/**
 * Structural check for ONE node (children are validated as they are rendered, so
 * a bad grandchild never invalidates its ancestor). Returns false for an unknown
 * `type`, a missing required field, or a wrong field type (FR-35).
 */
export function validPanelNode(node: unknown): node is PanelNode {
  if (typeof node !== 'object' || node === null) return false;
  const n = node as Record<string, unknown>;
  switch (n.type) {
    case 'text':
      return isStr(n.value) && isOneOf(n.tone, TONES) && isBoolOpt(n.wrap);
    case 'row':
      return isArr(n.children) && isOneOf(n.gap, GAPS) && isOneOf(n.align, ALIGNS);
    case 'stack':
      return isArr(n.children) && isOneOf(n.gap, GAPS);
    case 'list':
      return isArr(n.items) && isBoolOpt(n.selectable) && isStrOpt(n.emptyText);
    case 'badge':
      return isStr(n.value) && isOneOf(n.tone, TONES);
    case 'keyhint':
      return isStr(n.value);
    case 'divider':
      return true;
    case 'action':
      return isStr(n.label) && isStr(n.commandId) && isStrOpt(n.keyhint) && validActionArgs(n.args);
    case 'progress':
      return isNum(n.percent) && isStrOpt(n.label);
    case 'spinner':
      return isStrOpt(n.label);
    default:
      return false;
  }
}

/** FR-39: flat, primitives only. The core rejects the rest; this is the render guard. */
function validActionArgs(args: unknown): boolean {
  if (args === undefined) return true;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
  return Object.values(args as Record<string, unknown>).every(
    (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
}

/** §8·A4 / FR-34: the body states a panel can be in, worded once. */
export const PANEL_UNSUPPORTED_VERSION = 'unsupported panel version';
export const PANE_LOADING_LINE = 'rendering…';
export const PANE_EMPTY_LINE = 'no content';
export const PANE_ERROR_TITLE = 'plugin error';
export const CONSENT_PENDING_LINE = 'new permissions — review to re-enable';

// ============================================================================
// FR-40 — the keyboard target: the first selectable list, in document order
// ============================================================================

type ListNode = Extract<PanelNode, { type: 'list' }>;
type ActionNode = Extract<PanelNode, { type: 'action' }>;

/** Depth-first children of a container node, in document order. */
function childrenOf(node: PanelNode): PanelNode[] {
  if (node.type === 'row' || node.type === 'stack') return node.children;
  if (node.type === 'list') return node.items;
  return [];
}

/**
 * FR-40: the pane's keyboard target. A panel with more than one selectable list
 * uses the FIRST; the rest render as plain lists. Returns the node itself so the
 * renderer can compare by identity.
 */
export function findSelectableList(nodes: PanelNode[]): ListNode | null {
  for (const node of nodes) {
    if (!validPanelNode(node)) continue;
    if (node.type === 'list' && node.selectable === true) return node;
    const nested = findSelectableList(childrenOf(node));
    if (nested) return nested;
  }
  return null;
}

/** FR-40: clamped, no wrap. An empty list stays at 0. */
export function moveListSelection(length: number, index: number, delta: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index + delta, length - 1));
}

export function clampSelection(length: number, index: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

/** The first `action` node in document order inside `node` (itself included). */
export function firstActionNode(node: PanelNode): ActionNode | null {
  if (!validPanelNode(node)) return null;
  if (node.type === 'action') return node;
  for (const child of childrenOf(node)) {
    const found = firstActionNode(child);
    if (found) return found;
  }
  return null;
}

/**
 * FR-40 + FR-38: what app-shell's delegated `activate` fires for the selected
 * item — the first action inside it, unless that action names a command the
 * manifest never declared (in which case it is inert and nothing happens).
 */
export function selectionAction(
  spec: PanelSpec | null,
  index: number,
  declared: ReadonlySet<string>,
): { commandId: string; args?: PanelActionArgs } | null {
  if (!spec) return null;
  const list = findSelectableList(spec.nodes);
  const item = list?.items[index];
  if (!item) return null;
  const action = firstActionNode(item);
  if (!action || isActionInert(action.commandId, declared)) return null;
  return { commandId: action.commandId, args: action.args };
}

// ============================================================================
// FR-38 — declared commands
// ============================================================================

export function declaredCommandIds(manifest: PluginManifest): Set<string> {
  return new Set((manifest.contributes.commands ?? []).map((c) => c.id));
}

/** FR-38: an action naming an undeclared command renders dimmed and does nothing. */
export function isActionInert(commandId: string, declared: ReadonlySet<string>): boolean {
  return !declared.has(commandId);
}

// ============================================================================
// FR-75/FR-76/FR-77 — enablement against the sidebar's project filter
// ============================================================================

/**
 * FR-76: active when `all`, or `projects` and the set contains the current
 * visibility scope. Under *All projects* (`scope === null`) every plugin with a
 * NON-EMPTY project set is active — the union (FR-77's empty set behaves as off).
 */
export function isPluginEnabled(plugin: InstalledPlugin, scope: ProjectId | null): boolean {
  const e = plugin.enablement;
  if (e.scope === 'off') return false;
  if (e.scope === 'all') return true;
  return scope === null ? e.projectIds.length > 0 : e.projectIds.includes(scope);
}

/**
 * §6 `activePlugins`. Registry order is preserved (FR-46). consentPending
 * plugins stay in the list: they are enabled, merely INERT (FR-16) — their pane
 * still renders, showing the consent state instead of a spec.
 */
export function activePlugins(plugins: InstalledPlugin[], scope: ProjectId | null): InstalledPlugin[] {
  return plugins.filter((p) => isPluginEnabled(p, scope));
}

// ============================================================================
// FR-46/FR-47 — panes
// ============================================================================

export function pluginPanes(plugins: InstalledPlugin[], scope: ProjectId | null): InstalledPlugin[] {
  return activePlugins(plugins, scope).filter((p) => p.manifest.contributes.panel !== undefined);
}

/** FR-47: `6`-`9` for the first four visible panes; null past the fourth. */
export function pluginPaneHotkeys(panes: InstalledPlugin[]): Record<PluginPaneId, string | null> {
  const out: Record<string, string | null> = {};
  panes.forEach((p, i) => {
    out[pluginPaneId(p.manifest.id)] = pluginPaneHotkey(i);
  });
  return out;
}

/** FR-46: `contributes.panel.title`, uppercased and truncated to 18 chars. */
export function paneTitle(title: string): string {
  return title.toUpperCase().slice(0, PLUGIN_PANE_TITLE_MAX);
}

// ============================================================================
// FR-81 — main tabs
// ============================================================================

/**
 * The plugins contributing a main tab, in registry order — the same order and
 * the same enablement rule the panes use, so a project filter adds and removes
 * tabs exactly as it does panes.
 */
export function pluginTabs(plugins: InstalledPlugin[], scope: ProjectId | null): InstalledPlugin[] {
  return activePlugins(plugins, scope).filter((p) => p.manifest.contributes.tab !== undefined);
}

/** FR-81: `contributes.tab.title`, uppercased and truncated like a pane title. */
export function tabTitle(title: string): string {
  return title.toUpperCase().slice(0, PLUGIN_PANE_TITLE_MAX);
}

/**
 * Is `tab` still a tab some visible plugin contributes?
 *
 * The main tab is persisted-ish state that outlives a registry change: disabling
 * a plugin, or switching the project filter, can pull the selected tab out from
 * under the user. Without this the app would render a tab whose plugin is gone —
 * a blank main pane with no way back.
 */
export function isTabStillVisible(tab: string, visible: InstalledPlugin[]): boolean {
  const id = pluginIdOfTab(tab);
  return id === null || visible.some((p) => p.manifest.id === id);
}

/** FR-46: the count the first TOP-LEVEL list reports, else the top-level node count. */
export function paneCount(spec: PanelSpec | null): number {
  if (!spec) return 0;
  const list = spec.nodes.find((n) => validPanelNode(n) && n.type === 'list') as ListNode | undefined;
  return list ? list.items.length : spec.nodes.length;
}

/** §8·A1: `<n> · [<hotkey>]`, or `<n>` alone when the pane has no hotkey. */
export function paneCountLabel(count: number, hotkey: string | null): string {
  return hotkey === null ? String(count) : `${count} · [${hotkey}]`;
}

// ============================================================================
// FR-49 — status-bar items
// ============================================================================

/**
 * The contributors whose item may render, in registry order, capped at three
 * (edge 47 counts CONTRIBUTORS, not non-null items, so the cap is deterministic).
 * A consentPending plugin publishes no status item at all (FR-16).
 */
export function statusItemPlugins(plugins: InstalledPlugin[], scope: ProjectId | null): InstalledPlugin[] {
  return activePlugins(plugins, scope)
    .filter((p) => !p.consentPending && p.manifest.contributes.statusBar !== undefined)
    .slice(0, STATUS_ITEM_MAX_VISIBLE);
}

export interface VisibleStatusItem {
  pluginId: string;
  plugin: InstalledPlugin;
  item: StatusItemSpec;
}

/** FR-43: a handler that returned nothing clears its surface — no item, no error. */
export function visibleStatusItems(
  plugins: InstalledPlugin[],
  scope: ProjectId | null,
  items: Record<string, StatusItemSpec | null | undefined>,
): VisibleStatusItem[] {
  const out: VisibleStatusItem[] = [];
  for (const plugin of statusItemPlugins(plugins, scope)) {
    const item = items[plugin.manifest.id];
    if (item) out.push({ pluginId: plugin.manifest.id, plugin, item });
  }
  return out;
}

// ============================================================================
// FR-50/FR-52 — palette entries
// ============================================================================

export interface PluginPaletteEntry {
  /** `plugin:<pluginId>:<commandId>` — namespaced, so a collision is impossible. */
  id: string;
  pluginId: string;
  commandId: string;
  glyph: string;
  /** The contribution's title. */
  name: string;
  /** FR-50's static hint: the plugin's own name, so every row is attributed. */
  hint: string;
}

/**
 * Every `contributes.commands[]` entry with `palette !== false`, in registry
 * order. A consentPending plugin contributes NOTHING (FR-16 / §3·F5); the rest
 * are registered and gated at run time by `pluginCommandEnabled` (FR-50).
 */
export function pluginPaletteEntries(plugins: InstalledPlugin[]): PluginPaletteEntry[] {
  const out: PluginPaletteEntry[] = [];
  for (const p of plugins) {
    if (p.consentPending) continue;
    for (const c of p.manifest.contributes.commands ?? []) {
      if (c.palette === false) continue;
      out.push({
        id: pluginPaletteCommandId(p.manifest.id, c.id),
        pluginId: p.manifest.id,
        commandId: c.id,
        glyph: c.glyph || DEFAULT_PLUGIN_GLYPH,
        name: c.title,
        hint: p.manifest.name,
      });
    }
  }
  return out;
}

/** FR-50: false while the plugin is inert, out of scope, or already invoking. */
export function pluginCommandEnabled(
  plugin: InstalledPlugin,
  scope: ProjectId | null,
  busy: boolean,
): boolean {
  return !plugin.consentPending && !busy && isPluginEnabled(plugin, scope);
}

/**
 * The registry reconciliation a registry OR scope change needs (FR-76): what to
 * register, and which previously registered plugin ids to drop.
 */
export function paletteSyncPlan(
  registeredIds: readonly string[],
  entries: readonly PluginPaletteEntry[],
): { add: PluginPaletteEntry[]; remove: string[] } {
  const wanted = new Set(entries.map((e) => e.id));
  const have = new Set(registeredIds);
  return {
    add: entries.filter((e) => !have.has(e.id)),
    remove: registeredIds.filter((id) => !wanted.has(id)),
  };
}

// ============================================================================
// FR-70/FR-72/FR-73 — the frontend-driven refresh timer
// ============================================================================

/** FR-70: clamped to [5s, 1h]; absent ⇒ no polling. */
export function refreshIntervalFor(manifest: PluginManifest): number | null {
  const ms = manifest.refreshIntervalMs;
  if (ms === undefined || !Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, REFRESH_INTERVAL_MIN_MS), REFRESH_INTERVAL_MAX_MS);
}

export function failureKey(pluginId: string, surface: PluginSurface): string {
  return `${pluginId}:${surface}`;
}

export interface RefreshConditions {
  /** null ⇒ the manifest declares no interval. */
  intervalMs: number | null;
  /** FR-70: `document.visibilityState === 'visible'`. */
  documentVisible: boolean;
  /** FR-73: consecutive failures for this surface. */
  failures: number;
  consentPending: boolean;
  /** FR-76 for the current scope. */
  enabled: boolean;
}

/**
 * FR-70/FR-72/FR-73. The caller only ever asks for a MOUNTED surface, so
 * mounting is implicit; a hidden window, an inert plugin or a surface that has
 * failed PLUGIN_FAILURE_LIMIT times running costs nothing.
 */
export function shouldRefresh(c: RefreshConditions): boolean {
  return (
    c.intervalMs !== null &&
    c.documentVisible &&
    c.enabled &&
    !c.consentPending &&
    c.failures < PLUGIN_FAILURE_LIMIT
  );
}

// ============================================================================
// FR-61..FR-64 — the settings form
// ============================================================================

/** Form state: every control is a string except `boolean`, which is a checkbox. */
export type PluginSettingsForm = Record<string, string | boolean>;

export const SECRET_PLACEHOLDER = 'not set';
/** FR-66: the one line the modal states beneath the first secret field. */
export const SECRETS_NOTE = 'secrets are obfuscated at rest, not encrypted against local access';
export const SECRETS_UNREADABLE_NOTE = 'stored secrets could not be read';

/** FR-62: descriptor order is form order; stored values overlay declared defaults. */
export function settingsFormValues(
  descriptors: PluginSettingDescriptor[],
  view: PluginSettingsView,
): PluginSettingsForm {
  const form: PluginSettingsForm = {};
  for (const d of descriptors) {
    const stored = view[d.key];
    if (d.type === 'boolean') {
      form[d.key] = typeof stored === 'boolean' ? stored : d.default === true;
    } else if (d.type === 'secret') {
      // FR-64: a secret NEVER arrives in plaintext and never carries a default.
      form[d.key] = stored === undefined ? '' : String(stored);
    } else {
      form[d.key] = stored !== undefined ? String(stored) : d.default !== undefined ? String(d.default) : '';
    }
  }
  return form;
}

export function isSecretSet(value: string | boolean | undefined): boolean {
  return value === SECRET_SENTINEL;
}

/** §8·C9: a set secret shows the sentinel; an unset one shows the placeholder. */
export function secretDisplay(value: string | boolean | undefined): string {
  return isSecretSet(value) ? SECRET_SENTINEL : '';
}

/**
 * FR-63 client-side pre-check — the core validates again and is the authority.
 * Returns null for a value the descriptor cannot accept, so the form can refuse
 * the write instead of round-tripping a guaranteed INVALID_INPUT.
 */
export function coerceSettingValue(
  d: PluginSettingDescriptor,
  raw: string | boolean,
): string | number | boolean | null {
  switch (d.type) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : raw === 'true';
    case 'number': {
      const n = Number(String(raw).trim());
      if (String(raw).trim() === '' || !Number.isFinite(n)) return null;
      if (d.min !== undefined && n < d.min) return null;
      if (d.max !== undefined && n > d.max) return null;
      return n;
    }
    case 'select':
      return (d.options ?? []).some((o) => o.value === raw) ? String(raw) : null;
    case 'string':
    case 'secret':
      return String(raw).slice(0, SETTING_MAX_STRING);
  }
}

/**
 * The one-key patch a field commit sends. FR-64: writing the sentinel back is a
 * no-op that PRESERVES the stored secret, so the form simply does not send it;
 * clearing writes `''`.
 */
export function settingPatch(
  d: PluginSettingDescriptor,
  raw: string | boolean,
): PluginSettingsView | null {
  if (d.type === 'secret' && raw === SECRET_SENTINEL) return null;
  const value = coerceSettingValue(d, raw);
  if (value === null) return null;
  return { [d.key]: value };
}

// ============================================================================
// FR-11 / §8·C/D — consent card and modal copy
// ============================================================================

export const CAPABILITY_SENTENCES: Record<PluginCapabilityKey, string> = {
  readState: 'read your sessions, projects, diffs and agent activity',
  driveSessions: 'ask to send prompts to your sessions — every one needs your approval',
  network: 'reach the network, limited to the domains below',
};

export interface CapabilityRow {
  key: PluginCapabilityKey;
  sentence: string;
  /** Verbatim, unsorted (manifest order) — FR-11. Empty for the non-network rows. */
  hosts: string[];
  /** FR-13 / §8·D15: this capability is NEW relative to what was granted. */
  added: boolean;
  /** The subset of `hosts` that is new. */
  addedHosts: string[];
}

/** FR-11: one row per GRANTED capability, in consent-card display order. */
export function capabilityRows(
  caps: PluginCapabilities,
  addedCapabilities: readonly PluginCapabilityKey[] = [],
  addedHosts: readonly string[] = [],
): CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  for (const key of PLUGIN_CAPABILITY_KEYS) {
    const granted = key === 'network' ? caps.network !== undefined : caps[key] === true;
    if (!granted) continue;
    const hosts = key === 'network' ? (caps.network?.hosts ?? []) : [];
    rows.push({
      key,
      sentence: CAPABILITY_SENTENCES[key],
      hosts,
      added: addedCapabilities.includes(key),
      addedHosts: hosts.filter((h) => addedHosts.includes(h)),
    });
  }
  return rows;
}

/** §8·C4/D14 — the standing warning. A disclosure, not a control (§10). */
export const EXFILTRATION_WARNING =
  'a plugin that can both read your state and reach the network can send what it reads there. only install plugins you trust.';

export function showsExfiltrationWarning(caps: PluginCapabilities): boolean {
  return caps.readState === true && caps.network !== undefined;
}

/** §8·D15 — the one extra line a widening update carries. */
export const WIDENING_LINE = 'this update asks for more than you granted';

/** §8·D12: `<kind> · <spec> @ <ref>`. */
export function sourceLine(source: PluginSource, ref: string): string {
  return `${source.kind} · ${source.spec} @ ${ref}`;
}

/** §8·C9: a 40-char SHA truncates to 8 (full value on hover); a version is verbatim. */
export function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 8) : ref;
}

/** §8·D12: the staged tree's size, humanized. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PHASE_LABELS: Record<PluginInstallPhase, string> = {
  resolving: 'resolving…',
  downloading: 'downloading…',
  verifying: 'verifying…',
  unpacking: 'unpacking…',
  done: 'done',
  failed: 'failed',
};

/** §8·C8: the one-line progress label beneath the install field. */
export function installPhaseLabel(phase: PluginInstallPhase): string {
  return PHASE_LABELS[phase];
}

// ---------- modal copy ----------

/**
 * §8·C6: `FRANCOIS` is load-bearing — it is what separates this modal from the
 * SKILLS pane's Claude Code plugins, which this feature never touches (FR-8).
 */
export const MODAL_TITLE = 'FRANCOIS PLUGINS';
export const MODAL_SUBTITLE = 'not the same as claude code plugins — those live in the SKILLS pane';
export const EMPTY_LIST_LINE = 'no plugins installed';
export const EMPTY_DETAIL_LINE = 'install one from github or npm using the field below';
export const INSTALL_PLACEHOLDER = 'owner/repo, a github url, or an npm package';
export const REGISTRY_RESET_LINE = 'the plugin registry was reset — a backup is at plugins.json.bak';

export function installedCountLabel(n: number): string {
  return `${n} installed`;
}

export function pluginRowSubtitle(plugin: InstalledPlugin): string {
  return `${plugin.manifest.version} · ${plugin.source.kind}`;
}

export type PluginRowTone = 'faint' | 'error' | 'warn' | 'accent';

/** §8·C8 state tags, in the order the brief lists them. */
export function pluginRowTags(
  plugin: InstalledPlugin,
  updateAvailable: boolean,
): { label: string; tone: PluginRowTone }[] {
  const tags: { label: string; tone: PluginRowTone }[] = [];
  if (plugin.enablement.scope === 'off') tags.push({ label: 'off', tone: 'faint' });
  if (plugin.lastError) tags.push({ label: 'error', tone: 'error' });
  if (plugin.consentPending) tags.push({ label: 'new permissions', tone: 'warn' });
  if (updateAvailable) tags.push({ label: 'update', tone: 'accent' });
  return tags;
}

/** §3·F2 — the identity row's update control once a check has found one. */
export function updateRowLabel(info: PluginUpdateInfo): string | null {
  if (!info.available) return null;
  const head = `update available · ${info.newVersion ?? info.newRef ?? ''}`;
  return info.capabilitiesWidened ? `${head} · new permissions` : head;
}

export function uninstallConfirmText(name: string): string {
  return `uninstall "${name}"? its settings and stored data are deleted.`;
}

// ---------- enablement control (§8·C9) ----------

export type EnablementMode = PluginEnablement['scope'];

export const ENABLEMENT_MODES: { mode: EnablementMode; label: string }[] = [
  { mode: 'off', label: 'off' },
  { mode: 'all', label: 'all projects' },
  { mode: 'projects', label: 'these projects…' },
];

export function enablementMode(e: PluginEnablement): EnablementMode {
  return e.scope;
}

/** The checkbox list's toggle. Switching from off/all starts a fresh set. */
export function toggleProjectScope(e: PluginEnablement, projectId: ProjectId): PluginEnablement {
  if (e.scope !== 'projects') return { scope: 'projects', projectIds: [projectId] };
  const has = e.projectIds.includes(projectId);
  return {
    scope: 'projects',
    projectIds: has ? e.projectIds.filter((id) => id !== projectId) : [...e.projectIds, projectId],
  };
}

// ============================================================================
// §8·E/F — the injection card and the transcript attribution
// ============================================================================

export const INJECTION_INTENT_LINE = 'wants to send this prompt to this session';

/** §8·E18: the `— …` note a resolved card appends to its header row. */
export function injectionStateNote(state: PluginInjectionBlockState): string | null {
  switch (state) {
    case 'approved':
      return '— approved';
    case 'denied':
      return '— denied';
    case 'expired':
      return '— expired';
    default:
      return null;
  }
}

/**
 * §8·E17: `.picard` carries a PURPLE left rail while pending — a permission ask
 * is a stop, a plugin injection is an outside voice, and the two must never be
 * confused. Resolved states recolor it; expired dims the whole card.
 */
export function injectionCardClass(state: PluginInjectionBlockState, inFlight: boolean): string {
  const parts = ['picard', `picard-${state}`];
  if (state === 'pending' && inFlight) parts.push('picard-inflight');
  return parts.join(' ');
}

/** §8·E21: `mm:ss` remaining, clamped at zero. */
export function formatExpiresIn(expiresAt: number, now: number): string {
  const total = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** §8·E23: only when an approved prompt landed behind an in-flight turn. */
export function queuedNote(queuePosition?: number): string | null {
  return queuePosition === undefined ? null : `queued · #${queuePosition}`;
}

/** §8·F24 — a footnote, not a decoration, and permanent (FR-58). */
export function pluginAttributionLine(origin: MessageOrigin): string {
  return `↳ via plugin ${origin.pluginName}`;
}
