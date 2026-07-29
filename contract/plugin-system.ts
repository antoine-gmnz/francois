// contract/plugin-system.ts — plugin-system: capability-sandboxed UI extensions.
// Authored from specs/plugin-system.md §5. Imports shared vocabulary from
// common.ts and never redefines it.
//
// Physical Tauri binding (PIPELINE.md §Conventions):
//   request  `francois:plugins:<verb>` → command `plugins_<verb_snake_case>`,
//            called via invoke('plugins_<verb>', payload) → Promise<Result<T>>
//   events   `francois:plugins:event`  → Tauri event `francois://plugins/event`
// No command ever rejects across the bridge — every fallible call resolves Result<T>.
//
// PLACEMENT NOTES
//  - MessageOrigin / PluginInjectionRequest / PluginInjectionState are DECLARED in
//    common.ts (the SessionEvent union needs them and common.ts never imports from
//    feature files) and re-exported here — the same rule session-questions §5.3 and
//    permission-guardrails follow.
//  - Spec §5.6 amends `contract/app-shell.ts`. That file was never created in this
//    repo (app-shell's PaneId lives in `src/lib/store.ts` as `Pane`), so the plugin
//    half of those amendments lives HERE, under "app-shell amendments" below. The
//    frontend widens its own `Pane` union to include `PluginPaneId` and imports the
//    helpers/tables from this file rather than re-deriving them.
//  - Nothing in §5.5 ("the in-isolate API") crosses the Tauri bridge. Those types are
//    the public contract for PLUGIN AUTHORS, exported so the core's host bindings and
//    the docs cannot drift.

import type {
  Result,
  SessionId,
  ProjectId,
  BlockId,
  SessionMeta,
  AgentInfo,
  PluginInjectionRequest,
  PluginInjectionState,
} from './common';
import type { DiffSummary } from './diff-view';
import type { UsageSnapshot } from './usage-bar';

export type { MessageOrigin, PluginInjectionRequest, PluginInjectionState } from './common';

// ============================================================================
// §5.2  Manifest & registry
// ============================================================================

/** The literal file name at a plugin tree's root (FR-1). */
export const MANIFEST_FILENAME = 'francois-plugin.json';

/** FR-2. Also the install-directory name, the registry key, and the PaneId suffix. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** FR-61. */
export const SETTING_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * Granted as a SET, all-or-nothing (FR-9) — so `grantedCapabilities` always equals
 * the consented manifest's `capabilities`, and a host function is either injected or
 * ABSENT. There is never a throwing stub.
 */
export interface PluginCapabilities {
  /** sessions, agents, diff summary, projects, usage (FR-29). */
  readState?: boolean;
  /** francois.session.prompt — always human-confirmed (FR-30, FR-53). */
  driveSessions?: boolean;
  /** core-proxied fetch, allowlisted (FR-31). Absent ⇒ no network at all. */
  network?: { hosts: string[] };
  /**
   * Frame ONE https:// origin as a main tab (FR-81..FR-86).
   *
   * Deliberately separate from `network`, and consented on its own line: a fetch
   * returns inert bytes to the isolate, a frame EXECUTES them next to the app.
   * It narrows rather than widens — the tab's host must also be in
   * `network.hosts` — but it is never implied by it.
   */
  webTab?: boolean;
}

/**
 * The four capability flags, in consent-card display order (§8 · D, §8 · H36).
 *
 * `webTab` sorts LAST because it is the strongest grant on the card. It must be
 * a member here, not merely a field on PluginCapabilities: `PluginUpdateInfo
 * .addedCapabilities` is typed by this tuple, so a key missing from it is a
 * widening the core cannot report — and an unreportable widening is one that
 * never triggers PLUGIN_CONSENT_REQUIRED (FR-13, FR-81).
 */
export const PLUGIN_CAPABILITY_KEYS = [
  'readState',
  'driveSessions',
  'network',
  'webTab',
] as const;
export type PluginCapabilityKey = (typeof PLUGIN_CAPABILITY_KEYS)[number];

export interface PluginCommandContribution {
  id: string; // kebab-case, unique within the plugin
  title: string; // palette row / action label, ≤ 64 chars
  glyph?: string; // single grapheme; defaults to DEFAULT_PLUGIN_GLYPH
  /** false ⇒ invocable only from a PanelSpec `action`, never listed in ⌘K (FR-50). */
  palette?: boolean;
}

export interface PluginContributes {
  commands?: PluginCommandContribution[];
  /** Claims a numbered pane [6]+ (FR-46). */
  panel?: { title: string }; // ≤ 18 chars after uppercasing/truncation
  /** Claims a status-bar item (FR-49). */
  statusBar?: Record<string, never>;
  /**
   * Claims a MAIN TAB that frames one web page (FR-81..FR-86).
   *
   * This is the one contribution that puts something in the webview which
   * Francois did not draw, so it is the one to be careful about. What bounds it:
   *
   *  * **The URL is static.** It lives here, in the manifest, and is fixed at
   *    the moment the user consents. There is no `tab()` handler and the isolate
   *    never runs for this surface — so a plugin cannot repoint its tab after
   *    consent, and a compromised backing service cannot move it.
   *  * **`webTab` is its own capability** (FR-81), consented on its own line. It
   *    is NOT implied by `network`: a fetch returns inert bytes to the isolate,
   *    a frame executes them next to the app. The tab's host must ALSO be in
   *    `capabilities.network.hosts` — `webTab` narrows that allowlist, never
   *    widens it.
   *  * **`https:` only** (FR-82), loopback included. The `http://127.0.0.1`
   *    exemption `francois.fetch` grants (FR-31) does not extend to frames.
   *  * **Cross-origin, IPC-free** (FR-83, FR-86): rendered without
   *    `allow-same-origin`, so the page is forced into an opaque origin, and
   *    Tauri's bridge is not injected into sub-frames. `francois.*` exists only
   *    inside the isolate, so script in the frame reaches no session, diff, or
   *    project.
   */
  tab?: {
    title: string; // ≤ TAB_MAX_TITLE chars after uppercasing/truncation
    /** https:// only, host ∈ capabilities.network.hosts (FR-82). */
    url: string;
    glyph?: string; // single grapheme; defaults to DEFAULT_PLUGIN_GLYPH
  };
}

export type PluginSettingType = 'string' | 'number' | 'boolean' | 'select' | 'secret';

export interface PluginSettingDescriptor {
  key: string; // SETTING_KEY_PATTERN, unique within the plugin
  type: PluginSettingType;
  label: string; // ≤ 48 chars
  description?: string; // ≤ 200 chars, rendered beneath the field
  /** Never allowed for type 'secret'. */
  default?: string | number | boolean;
  placeholder?: string; // ≤ 48 chars
  options?: { value: string; label: string }[]; // type 'select' only, non-empty
  min?: number; // type 'number' only
  max?: number; // type 'number' only
}

export interface PluginManifest {
  manifestVersion: 1;
  id: string; // PLUGIN_ID_PATTERN
  name: string; // display name, ≤ 48 chars
  version: string; // free-form, displayed verbatim
  description: string; // one line, ≤ 200 chars
  author?: string; // ≤ 64 chars
  entry: string; // relative POSIX path inside the tree, *.js (FR-7)
  contributes: PluginContributes;
  configuration?: PluginSettingDescriptor[];
  capabilities: PluginCapabilities;
  /** Clamped to [REFRESH_INTERVAL_MIN_MS, REFRESH_INTERVAL_MAX_MS] (FR-70). Absent ⇒ no polling. */
  refreshIntervalMs?: number;
}

/** FR-70. */
export const REFRESH_INTERVAL_MIN_MS = 5_000;
export const REFRESH_INTERVAL_MAX_MS = 3_600_000;

// ---------- installed state ----------

export type PluginSourceKind = 'github' | 'npm';

export interface PluginSource {
  kind: PluginSourceKind;
  /** Verbatim as the user typed it, e.g. 'acme/francois-ci@main' or '@acme/fr-ci@1.2.0'. */
  spec: string;
}

export type PluginEnablement =
  | { scope: 'off' }
  | { scope: 'all' }
  | { scope: 'projects'; projectIds: ProjectId[] };

/**
 * The surfaces plugin CODE can produce. `tab` is deliberately absent: a tab is
 * static manifest data (FR-81), never a handler result, so it is never rendered,
 * never invalidated, and never a reason to start an isolate.
 */
export type PluginSurface = 'panel' | 'statusBar' | 'command';

export interface PluginRuntimeError {
  at: number; // epoch ms
  surface: PluginSurface;
  message: string; // safe to render; never contains a secret value
}

/**
 * Settings as they cross to the WEBVIEW. A `secret` that is set reads as
 * SECRET_SENTINEL; unset reads as ''. Writing SECRET_SENTINEL back is a no-op that
 * PRESERVES the stored value, so a form round-trip cannot erase a token (FR-64).
 */
export type PluginSettingsView = Record<string, string | number | boolean>;

export const SECRET_SENTINEL = '••••••';

/** FR-63 — the cap on any stored string setting, secret included. */
export const SETTING_MAX_STRING = 4000;

export interface InstalledPlugin {
  manifest: PluginManifest;
  source: PluginSource;
  /** 40-char SHA (github) or exact version (npm) — the pin (FR-3/FR-4). */
  resolvedRef: string;
  installPath: string; // absolute
  installedAt: number; // epoch ms
  updatedAt: number; // epoch ms
  enablement: PluginEnablement;
  grantedCapabilities: PluginCapabilities;
  /** true ⇒ the on-disk manifest wants more than was granted; inert until re-consent (FR-16). */
  consentPending: boolean;
  settings: PluginSettingsView;
  lastError?: PluginRuntimeError;
}

// ============================================================================
// §5.3  PanelSpec — the FROZEN v1 vocabulary
// ============================================================================

/** The ONLY expressible visual variance (FR-37). Resolves to existing CSS tokens. */
export type PanelTone = 'default' | 'dim' | 'accent' | 'success' | 'warn' | 'error';

/** Flat, primitives only, ≤ PANEL_MAX_ARG_KEYS keys (FR-39). */
export type PanelActionArgs = Record<string, string | number | boolean>;

/**
 * FROZEN for version 1 (FR-35). Exactly these ten types. Adding a type in a future
 * version is backward-compatible; removing or changing one is not.
 */
export type PanelNode =
  | { type: 'text'; value: string; tone?: PanelTone; wrap?: boolean }
  | { type: 'row'; children: PanelNode[]; gap?: 'sm' | 'md'; align?: 'start' | 'center' | 'between' }
  | { type: 'stack'; children: PanelNode[]; gap?: 'sm' | 'md' }
  | { type: 'list'; items: PanelNode[]; selectable?: boolean; emptyText?: string }
  | { type: 'badge'; value: string; tone?: PanelTone }
  | { type: 'keyhint'; value: string }
  | { type: 'divider' }
  | { type: 'action'; label: string; commandId: string; args?: PanelActionArgs; keyhint?: string }
  | { type: 'progress'; percent: number; label?: string }
  | { type: 'spinner'; label?: string };

/**
 * The ten v1 node type tags, in §5.3 declaration order. Single source for the core's
 * validator, the frontend's renderer switch, and the FR-35 member-count assertion:
 * `PANEL_NODE_TYPES.length === 10`. The `PanelNodeTypesAreExhaustive` check below
 * makes widening `PanelNode` without widening this tuple a COMPILE error, and vice
 * versa — so v1 cannot grow a node type by accident.
 */
export const PANEL_NODE_TYPES = [
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
] as const;

export type PanelNodeType = (typeof PANEL_NODE_TYPES)[number];

/** Compile-time proof that PANEL_NODE_TYPES and PanelNode name exactly the same set. */
type _Assert<T extends true> = T;
type _Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type PanelNodeTypesAreExhaustive = _Assert<_Mutual<PanelNode['type'], PanelNodeType>>;

export interface PanelSpec {
  version: 1;
  /** Overrides contributes.panel.title for this render only; ≤ PANEL_MAX_TITLE chars. */
  title?: string;
  nodes: PanelNode[];
}

export interface StatusItemSpec {
  version: 1;
  text: string; // ≤ STATUS_MAX_TEXT chars
  tone?: PanelTone;
  badge?: string; // ≤ STATUS_MAX_BADGE chars
  commandId?: string; // clicking fires it; absent ⇒ inert
}

/**
 * The resolved, core-validated tab a plugin contributes (FR-81..FR-86).
 *
 * Derived from `PluginContributes.tab` at registry-load time — NOT returned by
 * plugin code. There is no `tab()` handler: the URL is static in the manifest so
 * that what the user consented to is what gets framed, permanently.
 */
export interface PluginTab {
  pluginId: string;
  /** Uppercased, truncated to TAB_MAX_TITLE. */
  title: string;
  /** Always https: with host ∈ the plugin's granted network allowlist (FR-82). */
  url: string;
  glyph: string;
}

// ---------- validation limits the CORE enforces (FR-36) ----------
// The frontend renders only core-validated specs and never re-derives these.
export const PANEL_MAX_NODES = 2000;
export const PANEL_MAX_DEPTH = 32;
export const PANEL_MAX_TEXT = 2000;
export const PANEL_MAX_BADGE = 32;
export const PANEL_MAX_KEYHINT = 8;
export const PANEL_MAX_ACTION_LABEL = 64;
export const PANEL_MAX_TITLE = 48;
export const PANEL_MAX_EMPTY_TEXT = 120;
export const STATUS_MAX_TEXT = 24;
export const STATUS_MAX_BADGE = 6;
export const PANEL_TRUNCATED_NOTICE = '⟨panel truncated⟩';
export const PANEL_INVALID_NODE = '⟨invalid node⟩';

/** FR-39 — action.args shape limits. */
export const PANEL_MAX_ARG_KEYS = 16;
export const PANEL_MAX_ARG_KEY_LEN = 64;
export const PANEL_MAX_ARG_VALUE_LEN = 512;

// ============================================================================
// §5.4  Channels
// ============================================================================

// ---------- francois:plugins:list  (no payload) ----------
// invoke('plugins_list'): Promise<Result<InstalledPlugin[]>>
//   Registry order (install order). Secrets redacted (FR-64). Errors: 'INTERNAL'.
export type PluginListOutput = InstalledPlugin[];

// ---------- francois:plugins:logs ----------
// FR-26's ring buffer needs a way out of the core for §8 · C9's LOG group.
export interface PluginLogsInput {
  pluginId: string;
}
// invoke('plugins_logs', req: PluginLogsInput): Promise<Result<string[]>>
//   Oldest first, ≤ LOG_RING_MAX_LINES entries (FR-26).
//   Errors: 'PLUGIN_NOT_FOUND' | 'INTERNAL'
export type PluginLogsOutput = string[];

/** FR-26 — the per-plugin ring keeps the LAST this many lines. */
export const LOG_RING_MAX_LINES = 200;

// ---------- francois:plugins:status ----------
// FR-79 (§7 #40) + FR-66 (§7 #42): two startup conditions that belong to no single
// plugin row, so they fit neither `InstalledPlugin` nor the `plugin.registry` event.
export interface PluginStatusOutput {
  /** `plugins.json` was unparseable and was reset; a backup is at plugins.json.bak. */
  registryWasReset: boolean;
  /** The secret key is missing or corrupt, so stored secrets could not be opened. */
  secretsUnreadable: boolean;
}
// invoke('plugins_status'): Promise<Result<PluginStatusOutput>>
//   `registryWasReset` is CLEARED BY THE READ — it reports something that happened once,
//   and the modal shows it once (§7 #40). `secretsUnreadable` is a standing condition and
//   is not cleared. Errors: 'INTERNAL'

// ---------- francois:plugins:resolve ----------

export interface PluginResolveInput {
  /** 'acme/repo', 'acme/repo@main', a github URL, '<pkg>', '<pkg>@<version|dist-tag>'. */
  spec: string;
  /** Omit to auto-detect: a github URL or an 'owner/repo' shape ⇒ github, else npm. */
  kind?: PluginSourceKind;
}

export interface PluginInstallPreview {
  /** Valid for STAGING_TTL_MS; hand back to plugins:install (FR-5). */
  stagingId: string;
  manifest: PluginManifest;
  source: PluginSource;
  resolvedRef: string;
  /** Bytes of the staged, unpacked tree — shown on the consent card. */
  unpackedBytes: number;
}
// invoke('plugins_resolve', req: PluginResolveInput): Promise<Result<PluginInstallPreview>>
//   Installs NOTHING (FR-10). Errors: 'INVALID_INPUT' | 'PLUGIN_SOURCE_UNREACHABLE'
//         | 'PLUGIN_MANIFEST_INVALID' | 'PLUGIN_ALREADY_INSTALLED' | 'INTERNAL'

/** FR-5 — a staged tree not committed within this window is swept. */
export const STAGING_TTL_MS = 600_000;

// ---------- francois:plugins:install ----------

export interface PluginInstallInput {
  stagingId: string;
}
// invoke('plugins_install', req: PluginInstallInput): Promise<Result<InstalledPlugin>>
//   Commits the staged tree, grants the manifest's capabilities verbatim (FR-9),
//   sets enablement { scope: 'off' } (FR-75), emits plugin.registry.
//   Errors: 'INVALID_INPUT' | 'PLUGIN_ALREADY_INSTALLED' | 'PLUGIN_STORE_WRITE_FAILED' | 'INTERNAL'

// ---------- francois:plugins:uninstall ----------

export interface PluginUninstallInput {
  pluginId: string;
}
// invoke('plugins_uninstall', req: PluginUninstallInput): Promise<Result<null>>
//   FR-74. Errors: 'PLUGIN_NOT_FOUND' | 'PLUGIN_STORE_WRITE_FAILED' | 'INTERNAL'

// ---------- francois:plugins:setEnablement ----------

export interface PluginSetEnablementInput {
  pluginId: string;
  enablement: PluginEnablement;
}
// invoke('plugins_set_enablement', req): Promise<Result<InstalledPlugin>>
//   Unknown projectIds are DROPPED, not rejected (FR-77).
//   Errors: 'PLUGIN_NOT_FOUND' | 'PLUGIN_STORE_WRITE_FAILED' | 'INTERNAL'

// ---------- francois:plugins:getSettings ----------

export interface PluginGetSettingsInput {
  pluginId: string;
}
// invoke('plugins_get_settings', req): Promise<Result<PluginSettingsView>>
//   Declared defaults overlaid with stored values; secrets redacted (FR-64).
//   Errors: 'PLUGIN_NOT_FOUND' | 'INTERNAL'

// ---------- francois:plugins:setSettings ----------

export interface PluginSetSettingsInput {
  pluginId: string;
  /** Partial patch. A key set to SECRET_SENTINEL preserves the stored secret (FR-64). */
  settings: PluginSettingsView;
}
// invoke('plugins_set_settings', req): Promise<Result<InstalledPlugin>>
//   Atomic; validates every value against its descriptor (FR-63). Emits plugin.invalidated
//   for every contributed surface and resets the failure counter (FR-68).
//   Errors: 'PLUGIN_NOT_FOUND' | 'INVALID_INPUT' | 'PLUGIN_STORE_WRITE_FAILED' | 'INTERNAL'

// ---------- francois:plugins:render ----------

export interface PluginRenderInput {
  pluginId: string;
  surface: 'panel' | 'statusBar';
  /** The current visibility scope (FR-76); null under "All projects". */
  projectId: ProjectId | null;
  /** The app-shell active session, or null. */
  sessionId: SessionId | null;
}

export type PluginRenderOutput =
  | { surface: 'panel'; spec: PanelSpec | null } // null ⇒ handler returned nothing (FR-43)
  | { surface: 'statusBar'; item: StatusItemSpec | null };
// invoke('plugins_render', req: PluginRenderInput): Promise<Result<PluginRenderOutput>>
//   On-demand only (FR-72). Errors: 'PLUGIN_NOT_FOUND' | 'PLUGIN_RUNTIME_ERROR'
//         | 'INVALID_INPUT' | 'INTERNAL'

// ---------- francois:plugins:invokeCommand ----------

export interface PluginInvokeCommandInput {
  pluginId: string;
  commandId: string;
  args?: PanelActionArgs;
  projectId: ProjectId | null;
  sessionId: SessionId | null;
}
// invoke('plugins_invoke_command', req): Promise<Result<null>>
//   Resolves when the handler settles. Emits plugin.invalidated for every contributed surface.
//   Errors: 'PLUGIN_NOT_FOUND' | 'INVALID_INPUT' (unknown commandId / bad args)
//         | 'PLUGIN_RUNTIME_ERROR' | 'INTERNAL'

// ---------- francois:plugins:resolveInjection ----------

export interface PluginResolveInjectionInput {
  sessionId: SessionId;
  blockId: BlockId;
  decision: 'approve' | 'deny';
}

export interface PluginResolveInjectionOutput {
  /** true when the approved prompt was enqueued behind an in-flight turn (mirrors SessionSendOutput). */
  queued: boolean;
  queuePosition?: number; // 1-based; present iff queued
}
// invoke('plugins_resolve_injection', req): Promise<Result<PluginResolveInjectionOutput>>
//   'approve' sends through the SAME core path as session_send (FR-57).
//   'deny' always resolves { queued: false } and tells the plugin nothing (FR-56).
//   Errors: 'PLUGIN_INJECTION_NOT_PENDING' | 'SESSION_NOT_FOUND' | 'INTERNAL'

// ---------- francois:plugins:checkUpdate ----------

export interface PluginCheckUpdateInput {
  pluginId: string;
}

export interface PluginUpdateInfo {
  available: boolean;
  currentRef: string;
  currentVersion: string;
  /** Present iff available. */
  newRef?: string;
  newVersion?: string;
  newManifest?: PluginManifest;
  /** FR-13. */
  capabilitiesWidened: boolean;
  addedCapabilities: PluginCapabilityKey[];
  addedHosts: string[];
}
// invoke('plugins_check_update', req): Promise<Result<PluginUpdateInfo>>
//   Never mutates, never runs plugin code (FR-12). Manual only — no background check.
//   Errors: 'PLUGIN_NOT_FOUND' | 'PLUGIN_SOURCE_UNREACHABLE' | 'PLUGIN_MANIFEST_INVALID' | 'INTERNAL'

// ---------- francois:plugins:update ----------

export interface PluginUpdateInput {
  pluginId: string;
  /** Required when the pending update is widening (FR-14). */
  consented?: boolean;
}
// invoke('plugins_update', req): Promise<Result<InstalledPlugin>>
//   Narrowing REPLACES the granted set, never unions (FR-14). Settings/storage survive (FR-15).
//   Errors: 'PLUGIN_NOT_FOUND' | 'PLUGIN_CONSENT_REQUIRED' | 'PLUGIN_SOURCE_UNREACHABLE'
//         | 'PLUGIN_MANIFEST_INVALID' | 'PLUGIN_STORE_WRITE_FAILED' | 'INTERNAL'

// ---------- francois:plugins:event  →  francois://plugins/event ----------

export type PluginInstallPhase =
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'unpacking'
  | 'done'
  | 'failed';

export type PluginEvent =
  /** Full snapshot after ANY registry mutation (FR-80). */
  | { type: 'plugin.registry'; plugins: InstalledPlugin[] }
  /** Re-render this surface; carries no spec — call plugins:render (FR-71). */
  | { type: 'plugin.invalidated'; pluginId: string; surface: PluginSurface }
  /** An invocation failed (FR-73). `consecutive` is the post-increment count. */
  | { type: 'plugin.error'; pluginId: string; error: PluginRuntimeError; consecutive: number }
  /** Install/update progress for a staging id (FR-5). */
  | { type: 'plugin.install.progress'; stagingId: string; phase: PluginInstallPhase; message?: string };

/** FR-73 — consecutive failures after which a surface's refresh timer stops. */
export const PLUGIN_FAILURE_LIMIT = 5;

// ============================================================================
// §5.5  The in-isolate API (documentation types — these NEVER cross IPC)
// ============================================================================
// The public contract for plugin authors: a plugin may `import type` these. The
// core's host bindings are written against the same names so docs cannot drift.

export interface PluginProjectInfo {
  id: ProjectId;
  name: string;
  root: string;
}

export interface PluginFetchInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'; // default 'GET'
  headers?: Record<string, string>; // 'Host' rejected (FR-31)
  body?: string; // ≤ FETCH_MAX_REQUEST_BYTES
}

export interface PluginFetchResponse {
  status: number;
  ok: boolean; // status in [200, 300)
  headers: Record<string, string>; // lowercased names
  text: string; // UTF-8 lossy, ≤ FETCH_MAX_RESPONSE_BYTES
}

/** The single global. Deep-frozen. Capability-gated members are ABSENT when not granted (FR-9). */
export interface PluginHostApi {
  readonly plugin: { id: string; version: string };
  log(...args: unknown[]): void;
  /** Secrets in PLAINTEXT — the only place a stored secret is decrypted (FR-28). */
  settings: { get(): Record<string, string | number | boolean> };
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  // ---- capability: readState (FR-29) ----
  sessions?: { list(): Promise<SessionMeta[]>; get(id: SessionId): Promise<SessionMeta | null> };
  agents?: { list(sessionId: SessionId): Promise<AgentInfo[]> };
  diff?: { summary(sessionId: SessionId): Promise<DiffSummary | null> };
  projects?: { list(): Promise<PluginProjectInfo[]>; current(): Promise<PluginProjectInfo | null> };
  usage?: { get(): Promise<UsageSnapshot | null> };
  // ---- capability: driveSessions (FR-30) ----
  /** REQUESTS a human-confirmed injection; never sends (FR-53). The outcome is never reported back (FR-56). */
  session?: { prompt(sessionId: SessionId, text: string): Promise<{ requestId: string }> };
  // ---- capability: network (FR-31) ----
  fetch?(url: string, init?: PluginFetchInit): Promise<PluginFetchResponse>;
}

export interface PluginRenderContext {
  surface: 'panel' | 'statusBar';
  projectId: ProjectId | null;
  sessionId: SessionId | null;
  now: number; // epoch ms, stamped by the core
}

export interface PluginCommandContext {
  surface: 'command';
  commandId: string;
  args: PanelActionArgs;
  projectId: ProjectId | null;
  sessionId: SessionId | null;
  now: number;
}

/** The entry file's `export default` (FR-19). */
export interface PluginModule {
  panel?(ctx: PluginRenderContext): PanelSpec | null | Promise<PanelSpec | null>;
  statusBar?(ctx: PluginRenderContext): StatusItemSpec | null | Promise<StatusItemSpec | null>;
  // No `tab()`: a contributed tab is static manifest data (FR-81), so plugin code
  // never runs for it and cannot repoint it after consent.
  commands?: Record<string, (ctx: PluginCommandContext) => void | Promise<void>>;
}

// ---------- isolate & host limits the CORE enforces (FR-20, FR-27, FR-31, FR-54) ----------
export const ISOLATE_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
export const ISOLATE_MAX_STACK_BYTES = 512 * 1024;
export const ISOLATE_CPU_DEADLINE_MS = 2_000;
export const ISOLATE_WALL_DEADLINE_MS = 10_000;
export const ISOLATE_MAX_IO_CALLS = 8;
export const ISOLATE_MAX_CONCURRENT = 4;

export const STORAGE_MAX_KEY_LEN = 128;
export const STORAGE_MAX_BYTES = 256 * 1024;

export const FETCH_MAX_PER_INVOCATION = 4;
export const FETCH_MAX_REQUEST_BYTES = 1024 * 1024;
export const FETCH_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
/** `http:` is permitted ONLY for these exact hosts (FR-31). */
export const FETCH_LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;

export const INJECTION_MAX_PROMPT_CHARS = 8_000;
export const INJECTION_TTL_MS = 600_000;
export const INJECTION_MAX_PER_MINUTE = 5;

/** FR-6 — unpack limits. */
export const UNPACK_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const UNPACK_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const UNPACK_MAX_ENTRIES = 200;

// ============================================================================
// §5.6  The transcript block (mirrors PermissionConversationBlock)
// ============================================================================

export type PluginInjectionBlockState = 'pending' | PluginInjectionState;

export interface PluginInjectionConversationBlock {
  kind: 'pluginInjection';
  blockId: BlockId;
  /** true iff state === 'pending' (mirrors permission-guardrails FR-25). */
  isStreaming: boolean;
  request: PluginInjectionRequest;
  state: PluginInjectionBlockState;
  /** Set iff an approved prompt was enqueued behind an in-flight turn (§8 · E23). */
  queuePosition?: number;
}

// ============================================================================
// §5.6  app-shell amendments (FR-45, FR-47, FR-48, FR-50, FR-51)
// ============================================================================
// `contract/app-shell.ts` does not exist in this repo; the frontend's `Pane` union
// lives in src/lib/store.ts. It widens to `... | PluginPaneId` and imports these.
// MainTab widens to `... | PluginTabId` for FR-81 tab contributions.

export type PluginPaneId = `plugin:${string}`;

export const PLUGIN_PANE_PREFIX = 'plugin:';

/** `'acme-ci'` → `'plugin:acme-ci'` (FR-45). */
export function pluginPaneId(pluginId: string): PluginPaneId {
  return `${PLUGIN_PANE_PREFIX}${pluginId}` as PluginPaneId;
}

export function isPluginPaneId(paneId: string): paneId is PluginPaneId {
  return paneId.startsWith(PLUGIN_PANE_PREFIX);
}

/**
 * The status bar's `focus:` label for a pane id (FR-45). PANE_FOCUS_LABELS stays a
 * Record over the five static ids; a PluginPaneId falls back to the plugin id.
 */
export function pluginPaneFocusLabel(paneId: string): string | null {
  return isPluginPaneId(paneId) ? paneId.slice(PLUGIN_PANE_PREFIX.length) : null;
}

// ---------- FR-81: plugin-contributed MAIN TABS ----------
// A separate prefix from PLUGIN_PANE_PREFIX on purpose. `Pane` and `MainTab` are
// distinct unions, and a plugin may contribute BOTH — sharing one prefix would
// make `plugin:acme` ambiguous at every boundary that takes a bare string.

export type PluginTabId = `plugintab:${string}`;

export const PLUGIN_TAB_PREFIX = 'plugintab:';

/** `'acme-ci'` → `'plugintab:acme-ci'`. */
export function pluginTabId(pluginId: string): PluginTabId {
  return `${PLUGIN_TAB_PREFIX}${pluginId}` as PluginTabId;
}

export function isPluginTabId(tabId: string): tabId is PluginTabId {
  return tabId.startsWith(PLUGIN_TAB_PREFIX);
}

/** The plugin id inside a tab id, or null when it is one of the static tabs. */
export function pluginIdOfTab(tabId: string): string | null {
  return isPluginTabId(tabId) ? tabId.slice(PLUGIN_TAB_PREFIX.length) : null;
}

/**
 * The URL schemes a contributed tab may use (FR-82).
 *
 * `data:` and `blob:` are excluded deliberately — either would let a plugin
 * supply the DOCUMENT rather than merely point at one, which is the entire
 * distinction between "names a page" and "renders markup in the webview".
 *
 * `http:` is excluded too, loopback INCLUDED. `francois.fetch` exempts
 * `http://127.0.0.1` (FR-31) because a fetch response is inert text handed to
 * the isolate; a framed page executes. Same string, different blast radius.
 */
export const PLUGIN_TAB_SCHEMES = ['https:'] as const;

/** FR-86 — at most one tab per plugin, at most this many overall, registry order. */
export const MAX_PLUGIN_TABS = 3;

/** FR-81 — the tab strip is narrow; titles are uppercased and truncated to this. */
export const TAB_MAX_TITLE = 12;

/**
 * FR-83 — the exact sandbox token set for a contributed tab's iframe.
 *
 * `allow-same-origin` is absent on purpose: without it the framed document is
 * forced into an opaque origin, so it reaches no storage, cookie, or
 * postMessage channel of Francois's. `allow-popups` is absent so it cannot
 * spawn a window that outlives the tab. Do not add either without a spec
 * amendment — they are the whole boundary.
 */
export const PLUGIN_TAB_SANDBOX = 'allow-scripts allow-forms allow-popups-to-escape-sandbox';

/** FR-47 — KeyAction gains these four; KEY_BINDINGS gains '6'..'9', scope 'suspended-in-text-input'. */
export const PLUGIN_PANE_KEY_ACTIONS = [
  'focusPlugin1',
  'focusPlugin2',
  'focusPlugin3',
  'focusPlugin4',
] as const;
export type PluginPaneKeyAction = (typeof PLUGIN_PANE_KEY_ACTIONS)[number];

/** The number keys bound to the 1st–4th VISIBLE plugin panes, in FR-46 order. */
export const PLUGIN_PANE_HOTKEYS = ['6', '7', '8', '9'] as const;
export const PLUGIN_PANE_MAX_HOTKEYS = PLUGIN_PANE_HOTKEYS.length;

/**
 * The hotkey for the nth visible plugin pane (0-based), or null past the 4th (FR-47).
 * A key with no corresponding pane is a no-op.
 */
export function pluginPaneHotkey(visibleIndex: number): string | null {
  return visibleIndex >= 0 && visibleIndex < PLUGIN_PANE_MAX_HOTKEYS
    ? PLUGIN_PANE_HOTKEYS[visibleIndex]
    : null;
}

/**
 * STATUS_BAR_HINTS[0].glyph, which becomes dynamic (FR-48): '1-5' with no plugin pane,
 * '1-<4+k>' capped at '1-9' where k = min(visiblePluginPanes, 4). No other hint changes.
 */
export function paneHintGlyph(visiblePluginPanes: number): string {
  const k = Math.min(Math.max(visiblePluginPanes, 0), PLUGIN_PANE_MAX_HOTKEYS);
  return k === 0 ? '1-5' : `1-${5 + k}`;
}

/** FR-49 — at most this many plugin status items render; further ones are dropped silently. */
export const STATUS_ITEM_MAX_VISIBLE = 3;

/** FR-46 — the pane title cap, applied after uppercasing. */
export const PLUGIN_PANE_TITLE_MAX = 18;

/** FR-50 — the default palette/action glyph when a contribution declares none. */
export const DEFAULT_PLUGIN_GLYPH = '⌁';

/**
 * FR-50/FR-52 — the palette id for a plugin command. Namespaced by plugin id, so two
 * plugins may declare the same commandId and a collision is impossible (FR-2).
 */
export function pluginPaletteCommandId(pluginId: string, commandId: string): string {
  return `${PLUGIN_PANE_PREFIX}${pluginId}:${commandId}`;
}

/** FR-51 — this feature's own built-in palette command, which opens the Plugins modal. */
export const MANAGE_PLUGINS_COMMAND_ID = 'manage-plugins';
export const MANAGE_PLUGINS_COMMAND_NAME = 'Manage plugins';

// ============================================================================
// Response aliases (mirror the other feature contracts' style)
// ============================================================================

export type PluginListResponse = Result<PluginListOutput>;
export type PluginResolveResponse = Result<PluginInstallPreview>;
export type PluginInstallResponse = Result<InstalledPlugin>;
export type PluginUninstallResponse = Result<null>;
export type PluginSetEnablementResponse = Result<InstalledPlugin>;
export type PluginGetSettingsResponse = Result<PluginSettingsView>;
export type PluginSetSettingsResponse = Result<InstalledPlugin>;
export type PluginRenderResponse = Result<PluginRenderOutput>;
export type PluginInvokeCommandResponse = Result<null>;
export type PluginResolveInjectionResponse = Result<PluginResolveInjectionOutput>;
export type PluginCheckUpdateResponse = Result<PluginUpdateInfo>;
export type PluginUpdateResponse = Result<InstalledPlugin>;
