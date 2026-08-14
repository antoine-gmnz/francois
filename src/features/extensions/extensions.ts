// extensions — the feature's pure logic (specs/extensions.md §6): tab identity,
// which extensions the strip offers, the five section states, FR-49's error
// composition, the paginated-table cursor with its 20-page cap, the log-tail
// ring buffer, the one token slot, and the typed-cell text. Framework-free so
// it is unit-testable without a component renderer (this project wires none).
//
// Nothing here spawns, fetches or subscribes — every caller in the components
// beside it goes through src/lib/api.ts, and every payload shape comes from
// contract/extensions.ts, which is read-only for this surface.

import type { AppError } from '../../../contract/common';
import { formatRelativeTime } from '../../../contract/fleet-board';
import {
  EXT_LOG_MAX_BYTES,
  EXT_LOG_MAX_LINES,
  EXT_MAX_PAGES,
  EXT_OUTPUT_CAP_BYTES,
  EXT_PAGE_SIZE,
  EXT_REFRESH_FLOOR_MS,
  EXT_TIMEOUT_MS,
  TOKEN_PATTERN,
  type ColumnKind,
  type ConsentRequest,
  type ConsentState,
  type ExtensionInfo,
  type ExtensionSource,
  type KeyValueRow,
  type PanelInfo,
  type PanelResponse,
  type StatTile,
  type StatusTone,
  type TableRow,
} from '../../../contract/extensions';

// ---------- tab identity (FR-9) ----------

const TAB_PREFIX = 'ext:';

/** FR-9: an extension tab's MainTab value — the sibling of `agentTabId`. */
export function extTabId(extensionId: string): string {
  return `${TAB_PREFIX}${extensionId}`;
}

/** The extension behind a MainTab value, or null for any other tab. */
export function extIdFromTab(tab: string): string | null {
  return tab.startsWith(TAB_PREFIX) ? tab.slice(TAB_PREFIX.length) : null;
}

export function isExtTab(tab: string): boolean {
  return extIdFromTab(tab) !== null;
}

// ---------- which tabs the strip offers (FR-8, FR-11, FR-13) ----------

/**
 * FR-11: a tab is offered when the extension is enabled AND detected for the
 * active session's root. FR-13 adds the one exception: a tab already opened in
 * this app run (`sticky`) stays in the strip after a session change that no
 * longer detects it — its body then reads `not available in <project>` instead
 * of vanishing under the cursor. FR-8 outranks both: disabled is gone, period.
 */
export function visibleExtensions(list: readonly ExtensionInfo[], sticky: readonly string[]): ExtensionInfo[] {
  return list.filter((e) => e.enabled && (e.detected || sticky.includes(e.id)));
}

// ---------- the five section states ----------

export const SELECT_SESSION_COPY = 'select a session';
export const SELECT_ROW_COPY = 'select a row above';
export const PAGE_CAP_NOTICE = `showing first ${EXT_MAX_PAGES * EXT_PAGE_SIZE} rows`;
export const LOAD_MORE_COPY = 'Load more';
export const RETRY_COPY = 'Retry';
export const DISABLE_COPY = 'disable';

/** FR-13: distinct from every FR-49 error — the tab is out of scope, not broken. */
export function notAvailableCopy(projectName: string | null): string {
  return `not available in ${projectName && projectName.trim() ? projectName : 'this project'}`;
}

/** Which of the pre-fetch states a section renders, before any provider runs. */
export type SectionGate = 'no-session' | 'unavailable' | 'no-selection' | 'ready';

export interface SectionContext {
  /** The active session's project root, or null with no active session. */
  root: string | null;
  /** FR-3, for that root. */
  detected: boolean;
  /** FR-38: the value filling this panel's token slot, if it has one. */
  token: string | null;
}

export function sectionGate(panel: PanelInfo, ctx: SectionContext): SectionGate {
  if (panel.scope === 'project') {
    if (ctx.root === null) return 'no-session'; // FR-14
    if (!ctx.detected) return 'unavailable'; // FR-13
  }
  if (panel.tokenSource !== null && !isValidToken(ctx.token)) return 'no-selection'; // FR-38
  return 'ready';
}

/** FR-20: the root a panel is fetched against — fleet panels take none. */
export function panelRoot(panel: PanelInfo, root: string | null): string | null {
  return panel.scope === 'fleet' ? null : root;
}

/**
 * FR-28: the core already clamps `refreshMs` to the 2 000 ms floor; this mirrors
 * the clamp on the way into the interval so a definition that ever slipped
 * through cannot make the webview hammer the provider. `null` = no auto-refresh.
 */
export function effectiveRefreshMs(panel: PanelInfo): number | null {
  return panel.refreshMs === null ? null : Math.max(EXT_REFRESH_FLOOR_MS, panel.refreshMs);
}

// ---------- error composition (FR-49) ----------

function detailRecord(error: AppError): Record<string, unknown> {
  return error.detail !== null && typeof error.detail === 'object' ? (error.detail as Record<string, unknown>) : {};
}

/** FR-49: the cause, always named, never confusable with a zero-row result. */
export function causeText(error: AppError): string {
  const detail = detailRecord(error);
  switch (error.code) {
    case 'EXT_PROVIDER_MISSING': {
      const argv0 = typeof detail.argv0 === 'string' ? detail.argv0 : null;
      return argv0 ? `${argv0} not found on PATH` : 'provider not found on PATH';
    }
    case 'EXT_PROVIDER_EXIT': {
      const code = typeof detail.code === 'number' ? detail.code : null;
      return code === null ? 'exited non-zero' : `exited ${code}`;
    }
    case 'EXT_PROVIDER_TIMEOUT':
      return `timed out after ${Math.round(EXT_TIMEOUT_MS / 1000)}s`;
    case 'EXT_OUTPUT_CAPPED':
      return `output exceeded ${Math.round(EXT_OUTPUT_CAP_BYTES / (1024 * 1024))} MiB`;
    case 'EXT_SCHEMA_INVALID':
      return 'unexpected output shape';
    case 'EXT_PATH_OUTSIDE_ROOT':
      return 'path escapes the project root';
    case 'EXT_INVALID_TOKEN':
      return 'that row cannot be streamed';
    case 'EXT_NOT_ENABLED':
      return 'the extension is disabled';
    case 'EXT_NOT_DETECTED':
      return 'not detected in this project';
    case 'EXT_PANEL_NOT_FOUND':
      return 'unknown panel';
    case 'EXT_STREAM_NOT_FOUND':
      return 'the stream already ended';
    case 'EXT_MANIFEST_INVALID':
    case 'EXT_MANIFEST_UNSUPPORTED':
      return manifestErrorCause(error);
    case 'EXT_NOT_CONSENTED':
      return 'not consented yet';
    case 'EXT_CONSENT_STALE':
      return 'changed since you enabled it';
    default:
      // Anything the core codes outside the EXT_* family still names itself —
      // the message is human-readable and safe to render (contract/common).
      return error.message;
  }
}

/**
 * FR-26/FR-49: `needs cohorte ≥ 2.4.0 · exited 1`. `minVersionLabel` is
 * composition only — Francois probes no version and parses no `--version`.
 */
export function errorHeadline(error: AppError, minVersionLabel: string | null): string {
  const cause = causeText(error);
  return minVersionLabel ? `needs ${sanitizeForDisplay(minVersionLabel)} · ${cause}` : cause;
}

/**
 * FR-49's monospace second line. `detail.command` is the resolved argv the core
 * attached (`EXT_PROVIDER_MISSING` / `_TIMEOUT` / `_EXIT`, `EXT_OUTPUT_CAPPED`,
 * and `EXT_NOT_DETECTED`'s no-home-directory case — see contract/common.ts).
 * `argv0` is a fallback DISPLAY ONLY for `EXT_PROVIDER_MISSING` when the core
 * could not resolve a full command (the binary itself was never found).
 */
export function errorCommand(error: AppError): string | null {
  const detail = detailRecord(error);
  if (typeof detail.command === 'string' && detail.command !== '') return sanitizeForDisplay(detail.command);
  return typeof detail.argv0 === 'string' && detail.argv0 !== '' ? sanitizeForDisplay(detail.argv0) : null;
}

/** FR-24: the core's already-truncated, already-sanitized stderr. */
export function errorDetailText(error: AppError): string | null {
  const stderr = detailRecord(error).stderr;
  if (typeof stderr !== 'string') return null;
  const text = stderr.trim();
  return text === '' ? null : text;
}

// ---------- paginated tables (FR-31, FR-32) ----------

const MAX_ROWS = EXT_MAX_PAGES * EXT_PAGE_SIZE;

export interface TableCursor {
  rows: TableRow[];
  /** The `--offset` the next page fetch carries (FR-31). */
  nextOffset: number;
  /** What the provider said about the page just applied. */
  hasMore: boolean;
  pages: number;
  /** FR-32: 20 pages / 2 000 rows reached. */
  capped: boolean;
}

export const EMPTY_CURSOR: TableCursor = { rows: [], nextOffset: 0, hasMore: false, pages: 0, capped: false };

export interface TablePage {
  rows: TableRow[];
  offset: number;
  hasMore: boolean;
}

/** FR-32: accumulate a page, never past 20 pages / 2 000 retained rows. */
export function appendPage(cursor: TableCursor, page: TablePage): TableCursor {
  const rows = [...cursor.rows, ...page.rows].slice(0, MAX_ROWS);
  const pages = cursor.pages + 1;
  return {
    rows,
    nextOffset: page.offset + page.rows.length,
    hasMore: page.hasMore,
    pages,
    capped: pages >= EXT_MAX_PAGES || rows.length >= MAX_ROWS,
  };
}

/** FR-32: past the cap the control is disabled and reads PAGE_CAP_NOTICE. */
export function canLoadMore(cursor: TableCursor): boolean {
  return cursor.hasMore && !cursor.capped;
}

/**
 * FR-31/FR-33: the `--offset` the NEXT fetch carries — 0 for a fresh `replace`
 * (first open, refresh, retry — every page is a fresh provider spawn under the
 * identical caps) or the cursor's already-tracked continuation point for an
 * `append` (Load more).
 */
export function nextFetchOffset(cursor: TableCursor, mode: 'replace' | 'append'): number {
  return mode === 'append' ? cursor.nextOffset : 0;
}

// ---------- per-panel fetch state (FR-18, FR-25, FR-30, FR-34) ----------

export type PanelStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PanelState {
  /** Bumped per request so a slow answer can never overwrite a newer one. */
  reqId: number;
  status: PanelStatus;
  cursor: TableCursor;
  keyValue: KeyValueRow[];
  tiles: StatTile[];
  error: AppError | null;
}

export const CLOSED_PANEL: PanelState = {
  reqId: 0,
  status: 'idle',
  cursor: EMPTY_CURSOR,
  keyValue: [],
  tiles: [],
  error: null,
};

/**
 * FR-18: a section starts its own loading state. FR-34: a `replace` fetch (first
 * open, refresh, retry) discards the cursor — a panel must never show rows that
 * are no longer being updated — while an `append` (Load more) keeps it.
 */
export function startPanelFetch(prev: PanelState, reqId: number, mode: 'replace' | 'append'): PanelState {
  return {
    ...prev,
    reqId,
    status: 'loading',
    error: null,
    cursor: mode === 'append' ? prev.cursor : EMPTY_CURSOR,
    keyValue: mode === 'append' ? prev.keyValue : [],
    tiles: mode === 'append' ? prev.tiles : [],
  };
}

/**
 * FR-25: a validated payload is applied whole — a partially valid one never
 * reaches here. FR-30: a failure replaces the body rather than keeping rows.
 */
export function receivePanel(prev: PanelState, reqId: number, res: PanelResponse): PanelState {
  if (prev.reqId !== reqId) return prev; // stale
  if (!res.ok) {
    return { ...prev, status: 'error', error: res.error, cursor: EMPTY_CURSOR, keyValue: [], tiles: [] };
  }
  const data = res.data;
  if (data.primitive === 'table') {
    return {
      ...prev,
      status: 'ready',
      error: null,
      cursor: appendPage(prev.cursor, { rows: data.rows, offset: data.offset, hasMore: data.hasMore }),
    };
  }
  if (data.primitive === 'key-value') {
    return { ...prev, status: 'ready', error: null, keyValue: data.rows };
  }
  return { ...prev, status: 'ready', error: null, tiles: data.tiles };
}

/** FR-49: a validated zero-row success renders the section's declared empty copy. */
export function isPanelEmpty(state: PanelState, primitive: PanelInfo['primitive']): boolean {
  if (state.status !== 'ready') return false;
  if (primitive === 'table') return state.cursor.rows.length === 0;
  if (primitive === 'key-value') return state.keyValue.length === 0;
  if (primitive === 'stat-row') return state.tiles.length === 0;
  return false;
}

// ---------- log-tail ring buffer (FR-40) ----------

export interface LogBuffer {
  lines: string[];
  /** Oldest-dropped count, rendered as the dim leading row. */
  dropped: number;
  bytes: number;
}

export const EMPTY_LOG: LogBuffer = { lines: [], dropped: 0, bytes: 0 };

/** FR-40: a ring of 2 000 lines / 1 MiB, oldest dropped, drops counted. */
export function appendLogLines(buf: LogBuffer, incoming: readonly string[]): LogBuffer {
  if (incoming.length === 0) return buf;
  const lines = [...buf.lines, ...incoming];
  let bytes = buf.bytes;
  for (const line of incoming) bytes += line.length + 1;
  let dropped = buf.dropped;
  let start = 0;
  while (lines.length - start > EXT_LOG_MAX_LINES || (bytes > EXT_LOG_MAX_BYTES && start < lines.length - 1)) {
    bytes -= lines[start].length + 1;
    start++;
    dropped++;
  }
  return { lines: start === 0 ? lines : lines.slice(start), dropped, bytes };
}

/** FR-40: matches `earlierBlocksNotice` in agent-tab.ts, one register down. */
export function earlierLinesNotice(dropped: number): string | null {
  return dropped > 0 ? `… ${dropped} earlier line${dropped === 1 ? '' : 's'}` : null;
}

// ---------- the one token slot (FR-38) ----------

/** FR-38: the frontend's check. The core re-validates and never trusts this. */
export function isValidToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/**
 * FR-38: a token may come ONLY from a sibling panel's validated rows, selected
 * by a click. A cell that fails the charset yields null — the section then keeps
 * reading `select a row above` rather than sending something the core refuses.
 */
export function tokenFromRow(row: TableRow | undefined | null, rowKey: string): string | null {
  if (!row) return null;
  const raw = rowKey === 'id' ? row.id : row.cells[rowKey];
  return isValidToken(raw) ? raw : null;
}

// ---------- status tones (FR-35/FR-36) ----------

/**
 * Design brief: a status tone NEVER borrows the accent — acid means "the live
 * thing" and in an extension tab that is the streaming log-tail, nothing else.
 * `ok` is the v2 ready-green the identity moved to exactly so a running
 * container cannot read as the accent.
 */
export function toneColor(tone: StatusTone): string {
  switch (tone) {
    case 'ok':
      return 'var(--success)';
    case 'warn':
      return 'var(--warn)';
    case 'error':
      return 'var(--error)';
    case 'busy':
      return 'var(--hue-blue)';
    default:
      return 'var(--text-muted)';
  }
}

/** The tag class a `status` cell wears (BEM-lite modifier, never inline). */
export function toneClassName(tone: StatusTone): string {
  return `ext-tag ext-tag--${tone}`;
}

// ---------- typed cells (FR-36) ----------

/**
 * FR-36: `time` renders an epoch-ms value in the app's existing relative format
 * (contract/fleet-board's `formatRelativeTime`, the same helper the sidebar and
 * the Overview rollup render through). A cell that is not a number degrades to
 * its own text — provider output is distrusted, never coerced into `NaN`.
 * Every other kind renders verbatim; the KIND drives the CSS treatment, not the
 * text. A missing cell renders empty, which is not an error.
 */
export function cellText(kind: ColumnKind, raw: string | undefined, now: number = Date.now()): string {
  if (raw === undefined || raw === null) return '';
  if (kind !== 'time') return raw;
  const at = Number(raw);
  return Number.isFinite(at) && raw.trim() !== '' ? formatRelativeTime(at, now) : raw;
}

/**
 * FR-36: a `path` cell truncates from the LEFT so the filename survives.
 * Sanitized first (see `sanitizeForDisplay`) — provider/manifest paths are
 * untrusted text rendered verbatim in the UI.
 */
export function truncatePathLeft(value: string, max: number): string {
  const clean = sanitizeForDisplay(value);
  return clean.length <= max ? clean : `…${clean.slice(clean.length - (max - 1))}`;
}

/** The per-kind class the table cell wears (BEM-lite modifier, never inline). */
export function cellClassName(kind: ColumnKind): string {
  return `ext-cell ext-cell--${kind}`;
}

// ---------- consent (extension-install FR-15..FR-20) ----------

export const REVIEW_ENABLE_COPY = 'Review & enable';
export const REVIEW_AGAIN_COPY = 'Review again';
/** design brief: the row-level warn-tone notice for a `stale` consent. */
export const STALE_ROW_NOTICE = 'changed since you enabled it';
/** design brief: the consent dialog's leading warn line for a `stale` consent. */
export const STALE_DIALOG_NOTICE = 'the manifest changed since you enabled it — review the new commands';
/** design brief §"Empty state". */
export const EMPTY_DIR_LABEL = '~/.francois/extensions/';
export const EMPTY_STATE_COPY = 'Nothing installed yet. Copy examples/extensions/plugin-example/ in to get started.';

/** FR-15..FR-18: what the row's trailing control renders (design brief §"Extensions modal"). */
export type ConsentControlKind = 'toggle' | 'review' | 'review-again';

export function consentControlKind(consent: ConsentState): ConsentControlKind {
  if (consent.state === 'granted') return 'toggle';
  if (consent.state === 'stale') return 'review-again';
  return 'review';
}

/**
 * Defense-in-depth for FR-16/FR-6 (core is expected to strip these
 * server-side too, per its own remediation item): drops Unicode Cc control
 * characters (incl. tab/newline, which could forge extra display lines) and
 * the bidi-control code points (LRE/RLE/LRO/RLO/PDF, LRI/RLI/FSI/PDI, ALM,
 * LRM/RLM) that let an untrusted manifest string visually reorder or hide
 * its own bytes.
 */
const CONTROL_OR_BIDI_RE =
  // Cc/C1 controls (incl. \t \n \r) + ALM/LRM/RLM + LRE/RLE/PDF/LRO/RLO + LRI/RLI/FSI/PDI
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function sanitizeForDisplay(value: string): string {
  return value.replace(CONTROL_OR_BIDI_RE, '');
}

/**
 * FR-16: one argv, joined for display — the dialog renders one of these per
 * line. Each token is sanitized (see `sanitizeForDisplay`) then wrapped in a
 * Unicode isolate (LRI…PDI) so a bidi-override that slipped past the core's
 * own stripping still cannot escape its own token and reorder its neighbors.
 */
export function formatArgv(argv: readonly string[]): string {
  return argv.map((token) => `\u2066${sanitizeForDisplay(token)}\u2069`).join(' ');
}

/**
 * FR-18: the hash the dialog SHOWED, echoed back in `ConsentRequest` so a
 * manifest edited mid-dialog resolves `EXT_CONSENT_STALE` instead of being
 * consented to by accident. The core carries it on every loaded source; it is
 * the empty string only when the manifest could not be read at all
 * (`manifestError` non-null), and such a row offers no consent control.
 */
export function sourceManifestSha256(source: ExtensionSource): string {
  return source.manifestSha256;
}

/**
 * FR-16/FR-18: the payload `extensions_consent` is called with — the hash is
 * taken from the extension the dialog is RENDERING, so what the user read and
 * what the core checks are the same bytes by construction. Pure, so the
 * round-trip is unit-testable without a component renderer.
 */
export function consentRequest(extension: ExtensionInfo, root: string | null): ConsentRequest {
  return {
    extensionId: extension.id,
    manifestSha256: sourceManifestSha256(extension.source),
    root,
  };
}

/** FR-6/FR-5: the row-level manifest-error register (design brief: cause, then
 *  the manifest path in mono beneath — reusing the FR-49 error idiom). */
export function manifestErrorCause(error: AppError): string {
  if (error.code === 'EXT_MANIFEST_INVALID' || error.code === 'EXT_MANIFEST_UNSUPPORTED') {
    return sanitizeForDisplay(`invalid manifest · ${error.message}`);
  }
  return sanitizeForDisplay(error.message);
}

export function manifestErrorPath(error: AppError): string | null {
  const detail = error.detail !== null && typeof error.detail === 'object' ? (error.detail as Record<string, unknown>) : {};
  return typeof detail.manifestPath === 'string' ? sanitizeForDisplay(detail.manifestPath) : null;
}
