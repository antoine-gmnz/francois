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
}

/** The three capability flags, in consent-card display order. */
export const PLUGIN_CAPABILITY_KEYS = ['readState', 'driveSessions', 'network'] as const;
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
// MainTab is UNCHANGED — no plugin main tab in v1.

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
