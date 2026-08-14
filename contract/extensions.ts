// contract/extensions.ts — the frontend↔core boundary for `extensions`
// (specs/extensions.md §5, amended by specs/extension-install.md §5). Canonical
// TypeScript; the Rust core mirrors these with serde structs. Imported READ-ONLY
// by both surfaces — neither edits it.
//
// Physical binding (PIPELINE.md §Conventions):
//   francois:extensions:<verb>  → invoke('extensions_<verb_snake_case>', payload) → Result<T>
//   francois:extensions:event   → listen('francois://extensions/event')           → ExtensionEvent

import type { AppError, Result } from './common';

// ---------- identity ----------

/** extension-install FR-3: minted from the directory name, never from the manifest. */
export type ExtensionId = string;
export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** extension-install FR-9: a bare binary name resolved on PATH — no separator, no absolute path. */
export const ARGV0_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export const MANIFEST_VERSION = 1;
export const MANIFEST_MAX_BYTES = 256 * 1024;

/** `${ExtensionId}:${slug}` — e.g. 'git:log'. Minted by the core (FR-8); never read from the manifest. */
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

// ---------- detection (extension-install FR-12) ----------

/** The closed predicate set, as the frontend sees it (for the reason copy). */
export type DetectPredicate =
  | { kind: 'pathExists'; path: string }
  | { kind: 'pathJsonEquals'; path: string; pointer: string; equals: string }
  | { kind: 'commandSucceeds'; argv: string[] };

// ---------- consent (extension-install FR-15..FR-18) ----------

/** The three states a disk extension's consent can be in. */
export type ConsentState =
  | { state: 'granted' }
  | { state: 'never' }
  /** FR-18: consented, then the manifest bytes changed. */
  | { state: 'stale' };

export interface ExtensionSource {
  /** Absolute directory under ~/.francois/extensions. */
  dir: string;
  /** FR-18: sha256 of the manifest bytes as loaded. The consent dialog echoes it
   *  back in `ConsentRequest`, so a manifest edited mid-dialog resolves
   *  EXT_CONSENT_STALE instead of being consented to by accident. Empty string
   *  when the manifest could not be read (`manifestError` non-null). */
  manifestSha256: string;
  /** FR-16/FR-18: every distinct argv the manifest declares, deduplicated, in
   *  declaration order — panels first, then the predicate's. What the consent
   *  dialog renders verbatim. */
  declaredCommands: string[][];
}

// ---------- the registry, as the frontend sees it ----------

export interface ColumnDef {
  key: string;
  label: string;
  kind: ColumnKind;
  /** Relative flex weight in the row. Absent ⇒ 1. */
  weight?: number;
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
}

export interface ExtensionInfo {
  id: ExtensionId;
  label: string;
  /** extension-install FR-15: a key never written reads as FALSE. */
  enabled: boolean;
  consent: ConsentState;
  /** FR-3, evaluated against the `root` the list was queried with. */
  detected: boolean;
  /** FR-14/FR-17: `null` when detected; `not evaluated — enable to detect`
   *  whenever consent is not `granted` and the predicate is `commandSucceeds`. */
  undetectedReason: string | null;
  /**
   * FR-26: message composition ONLY. Francois runs no version probe and parses
   * no `--version` output. `null` when the manifest declares none.
   */
  minVersionLabel: string | null;
  source: ExtensionSource;
  predicate: DetectPredicate;
  /** extension-install FR-6: empty when `manifestError` is non-null — never partially loaded. */
  panels: PanelInfo[];
  /** extension-install FR-5/FR-6: the load failure, with its JSON pointer in `detail`. */
  manifestError: AppError | null;
}

/** extension-install FR-16 — the only way `enabled` becomes true for a `never`/`stale` extension. */
export interface ConsentRequest {
  extensionId: ExtensionId;
  /** The sha256 the dialog showed, so a manifest edited mid-dialog cannot be
   *  consented to by accident (FR-18). Mismatch ⇒ EXT_CONSENT_STALE. */
  manifestSha256: string;
  root: string | null;
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
  /** extension-install FR-13: invalidates this root's cache entry, re-scans the
   *  manifest directory and re-runs every predicate. */
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
// | francois:extensions:consent        | extensions_consent       |

export type ListExtensionsResponse = Result<ExtensionInfo[]>;
/** FR-8: returns the FULL refreshed list, so the frontend never re-queries to learn what changed. */
export type SetExtensionEnabledResponse = Result<ExtensionInfo[]>;
export type DetectExtensionsResponse = Result<ExtensionInfo[]>;
export type PanelResponse = Result<PanelData>;
export type OpenStreamResponse = Result<StreamId>;
export type CloseStreamResponse = Result<null>;
/** extension-install FR-16 — resolves the full refreshed list, same shape as SetExtensionEnabledResponse. */
export type ConsentResponse = Result<ExtensionInfo[]>;
