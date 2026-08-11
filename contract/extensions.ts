// contract/extensions.ts — the frontend↔core boundary for `extensions`
// (specs/extensions.md §5). Canonical TypeScript; the Rust core mirrors these
// with serde structs. Imported READ-ONLY by both surfaces — neither edits it.
//
// Physical binding (PIPELINE.md §Conventions):
//   francois:extensions:<verb>  → invoke('extensions_<verb_snake_case>', payload) → Result<T>
//   francois:extensions:event   → listen('francois://extensions/event')           → ExtensionEvent

import type { AppError, Result } from './common';

// ---------- identity ----------

/** FR-2: the compiled registry holds exactly these three, in this order. */
export type ExtensionId = 'cohorte' | 'git' | 'docker';

/** `${ExtensionId}:${slug}` — e.g. 'git:log'. Compiled in; never minted at runtime. */
export type PanelId = string;

/** Core-minted, uuid v4 (FR-44). */
export type StreamId = string;

export type PanelScope = 'fleet' | 'project';
export type PrimitiveKind = 'key-value' | 'table' | 'stat-row' | 'log-tail';
export type StatusTone = 'ok' | 'warn' | 'error' | 'neutral' | 'busy';
export type ColumnKind = 'text' | 'status' | 'number' | 'time' | 'path';

/**
 * FR-38: the ONLY slot in the system. It may appear in a `log-tail` panel's file
 * path or process argv and nowhere else. The core re-validates every value
 * against this pattern and never trusts the frontend's check.
 *
 * The leading character class excludes `-`, so argument injection
 * (`--upload-pack=…`, `--exec=…`) is structurally impossible rather than filtered.
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

// ---------- the registry, as the frontend sees it ----------

export interface ColumnDef {
  key: string;
  label: string;
  kind: ColumnKind;
  /** Relative flex weight in the row. Absent ⇒ 1. */
  weight?: number;
}

export interface PanelAction {
  /** FR-46: exactly one action exists in the whole registry. */
  id: 'cohorte-dashboard';
  label: string;
  /** The static resolved command, shown verbatim in the FR-48 confirmation. */
  resolvedCommand: string;
}

export interface PanelInfo {
  id: PanelId;
  label: string;
  scope: PanelScope;
  primitive: PrimitiveKind;
  /** FR-31 — `table` only; always false for every other primitive. */
  paginated: boolean;
  /** FR-28: ALREADY CLAMPED to the 2000 ms floor by the core. `null` = no auto-refresh. */
  refreshMs: number | null;
  /** `table` only; `null` for every other primitive. */
  columns: ColumnDef[] | null;
  /** FR-49: copy for a VALIDATED zero-row payload — never shown for an error. */
  emptyCopy: string;
  /**
   * FR-38: for a `log-tail` panel, the sibling panel whose selected row fills its
   * token, and the `cells` key to read the value from. `null` when the panel
   * declares no slot.
   */
  tokenSource: { panelId: PanelId; rowKey: string } | null;
  /** FR-46. Non-null on `cohorte:health` only. */
  action: PanelAction | null;
}

export interface ExtensionInfo {
  id: ExtensionId;
  label: string;
  /** FR-6: the persisted toggle. A key never written reads as `true`. */
  enabled: boolean;
  /** FR-3, evaluated against the `root` the list was queried with. */
  detected: boolean;
  /** FR-56: why not — rendered by the modal's `unavailable here` row. Null when detected. */
  undetectedReason: string | null;
  /**
   * FR-26: message composition ONLY. Francois runs no version probe and parses
   * no `--version` output. `null` for git and docker.
   */
  minVersionLabel: string | null;
  panels: PanelInfo[];
}

// ---------- panel payloads (one per pull primitive) ----------

export interface KeyValueRow {
  key: string;
  value: string;
  tone: StatusTone;
}

export interface TableRow {
  /** Stable within a page. The React key, and the FR-38 token source. */
  id: string;
  /** Keyed by `ColumnDef.key`. An unknown key is ignored; a missing one renders empty (FR-36). */
  cells: Record<string, string>;
  tone: StatusTone;
}

export interface StatTile {
  label: string;
  value: string;
  sublabel?: string;
}

/**
 * FR-25: what `extensions_panel` resolves. `log-tail` is absent by design — it
 * never resolves through this call, it opens a stream instead.
 */
export type PanelData =
  | { primitive: 'key-value'; rows: KeyValueRow[] }
  | { primitive: 'table'; rows: TableRow[]; offset: number; hasMore: boolean }
  | { primitive: 'stat-row'; tiles: StatTile[] };

// ---------- caps (FR-21..FR-23, FR-28, FR-31, FR-32, FR-40, FR-43, FR-51) ----------

/** Hard numbers, so the core has no judgment call and the frontend agrees with it. */
export const EXT_TIMEOUT_MS = 10_000;
export const EXT_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;
export const EXT_CONCURRENCY = 4;
export const EXT_REFRESH_FLOOR_MS = 2_000;
export const EXT_PAGE_SIZE = 100;
export const EXT_MAX_PAGES = 20;
export const EXT_LOG_MAX_LINES = 2_000;
export const EXT_LOG_MAX_BYTES = 1024 * 1024;
export const EXT_STREAM_GRACE_MS = 10_000;
export const EXT_FIELD_MAX_CHARS = 512;
export const EXT_PROBE_TIMEOUT_MS = 2_000;
export const EXT_DASHBOARD_URL = 'http://127.0.0.1:4317';

// ---------- requests ----------

export interface ListExtensionsRequest {
  /**
   * Absolute project root to evaluate detection against. `null` (FR-14: no active
   * session) ⇒ every extension reports `detected: false` with a reason, which
   * governs whether a NEW tab is offered (FR-11). An ALREADY-OPEN tab is not
   * closed by this — FR-12/FR-13/FR-14 own an open tab's lifecycle, and its
   * fleet-scoped panels keep loading.
   */
  root: string | null;
}

export interface SetExtensionEnabledRequest {
  extensionId: ExtensionId;
  enabled: boolean;
  /** Absolute project root to re-evaluate detection against for the refreshed
   * list this call returns. `null` = fleet-only (mirrors `ListExtensionsRequest`).
   * Required so a toggle from one project's tab never evaluates against
   * whichever root a different session queried most recently. */
  root: string | null;
}

export interface DetectExtensionsRequest {
  /** FR-57: invalidates this root's cache entry and re-runs every predicate. */
  root: string;
}

export interface PanelRequest {
  panelId: PanelId;
  /** Required for `scope: 'project'`; ignored for `scope: 'fleet'`. */
  root: string | null;
  /** FR-31, paginated tables only. Absent ⇒ offset 0, limit EXT_PAGE_SIZE. */
  offset?: number;
  limit?: number;
}

export interface OpenStreamRequest {
  panelId: PanelId;
  root: string | null;
  /** FR-38. Must match TOKEN_PATTERN; the core re-validates. `null` ⇒ EXT_INVALID_TOKEN
   * for a panel whose `tokenSource` is non-null. */
  token: string | null;
}

export interface CloseStreamRequest {
  streamId: StreamId;
}

export interface LaunchRequest {
  actionId: 'cohorte-dashboard';
}

/** FR-47. */
export interface ProbeResult {
  state: 'running' | 'stopped' | 'occupied';
  /** Present only when `state === 'running'`. */
  url: string | null;
}

// ---------- events (francois://extensions/event) ----------

export type ExtensionEvent =
  | { type: 'ext.stream.started'; streamId: StreamId; panelId: PanelId }
  | { type: 'ext.stream.chunk'; streamId: StreamId; lines: string[] }
  | { type: 'ext.stream.ended'; streamId: StreamId; exitCode: number | null }
  | { type: 'ext.stream.error'; streamId: StreamId; error: AppError };

// ---------- commands ----------
//
// | logical channel                    | tauri command            |
// | ---------------------------------- | ------------------------ |
// | francois:extensions:list           | extensions_list          |
// | francois:extensions:setEnabled     | extensions_set_enabled   |
// | francois:extensions:detect         | extensions_detect        |
// | francois:extensions:panel          | extensions_panel         |
// | francois:extensions:openStream     | extensions_open_stream   |
// | francois:extensions:closeStream    | extensions_close_stream  |
// | francois:extensions:probe          | extensions_probe         |
// | francois:extensions:launch         | extensions_launch        |

export type ListExtensionsResponse = Result<ExtensionInfo[]>;
/** FR-8: returns the FULL refreshed list, so the frontend never re-queries to learn what changed. */
export type SetExtensionEnabledResponse = Result<ExtensionInfo[]>;
export type DetectExtensionsResponse = Result<ExtensionInfo[]>;
export type PanelResponse = Result<PanelData>;
export type OpenStreamResponse = Result<StreamId>;
export type CloseStreamResponse = Result<null>;
export type ProbeResponse = Result<ProbeResult>;

/**
 * FR-48 — IDEMPOTENT, and the core owns the whole sequence so the two surfaces
 * cannot diverge on it. The frontend calls this for BOTH the `Open dashboard`
 * and `Launch dashboard` states and awaits one answer:
 *
 *   probe `running`  ⇒ the core opens EXT_DASHBOARD_URL with the platform opener, resolves ok
 *   probe `occupied` ⇒ resolves EXT_PORT_OCCUPIED; nothing is spawned
 *   probe `stopped`  ⇒ the core spawns ["cohorte","dashboard","--open"] DETACHED and untracked
 *                      (cohorte's own `--open` opens the browser), then re-probes every 1500 ms
 *                      until `running` — resolves ok — or EXT_LAUNCH_FAILED after 10 s
 *
 * No PID is retained: no stop button, no kill-on-quit, no orphan reconciliation.
 */
export type LaunchResponse = Result<null>;
