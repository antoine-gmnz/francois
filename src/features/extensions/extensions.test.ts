/* eslint-disable no-control-regex --
 * These tests assert that control and bidi code points are STRIPPED from
 * untrusted text, so the control characters in the patterns below are the
 * subject under test, not a typo. */
import { describe, expect, it } from 'vitest';
import type { AppError } from '../../../contract/common';
import type { ExtensionInfo, ExtensionSource, PanelInfo, TableRow } from '../../../contract/extensions';
import {
  EMPTY_CURSOR,
  EMPTY_LOG,
  PAGE_CAP_NOTICE,
  SELECT_ROW_COPY,
  SELECT_SESSION_COPY,
  appendLogLines,
  appendPage,
  canLoadMore,
  causeText,
  cellText,
  CLOSED_PANEL,
  consentControlKind,
  consentRequest,
  earlierLinesNotice,
  effectiveRefreshMs,
  errorCommand,
  errorDetailText,
  errorHeadline,
  extIdFromTab,
  extTabId,
  formatArgv,
  isExtTab,
  isValidToken,
  manifestErrorCause,
  manifestErrorPath,
  nextFetchOffset,
  notAvailableCopy,
  panelRoot,
  receivePanel,
  sanitizeForDisplay,
  sectionGate,
  sourceManifestSha256,
  startPanelFetch,
  tokenFromRow,
  toneClassName,
  toneColor,
  truncatePathLeft,
  visibleExtensions,
} from './extensions';

// ---------- fixtures ----------

function panel(over: Partial<PanelInfo> = {}): PanelInfo {
  return {
    id: 'git:log',
    label: 'Log',
    scope: 'project',
    primitive: 'table',
    paginated: true,
    refreshMs: null,
    columns: [{ key: 'subject', label: 'Subject', kind: 'text' }],
    emptyCopy: 'no commits',
    tokenSource: null,
    ...over,
  };
}

function source(over: Partial<ExtensionSource> = {}): ExtensionSource {
  return {
    dir: '/home/u/.francois/extensions/git',
    manifestSha256: 'sha-git',
    declaredCommands: [['git', 'branch']],
    ...over,
  };
}

function ext(over: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id: 'git',
    label: 'git',
    enabled: true,
    consent: { state: 'granted' },
    detected: true,
    undetectedReason: null,
    minVersionLabel: null,
    source: source(),
    predicate: { kind: 'pathExists', path: '.git' },
    panels: [panel()],
    manifestError: null,
    ...over,
  };
}

function rows(n: number, from = 0): TableRow[] {
  return Array.from({ length: n }, (_, i) => ({ id: `r${from + i}`, cells: { subject: `s${from + i}` }, tone: 'neutral' as const }));
}

// ---------- tab identity (FR-9) ----------

describe('ext tab identity', () => {
  it('mints and reads back an ext:<id> MainTab value', () => {
    expect(extTabId('docker')).toBe('ext:docker');
    expect(extIdFromTab('ext:docker')).toBe('docker');
    expect(isExtTab('ext:docker')).toBe(true);
  });

  it('does not claim any other tab value', () => {
    for (const tab of ['session', 'diff', 'shell', 'overview', 'agent:a1', 'workflow:w1']) {
      expect(extIdFromTab(tab)).toBeNull();
      expect(isExtTab(tab)).toBe(false);
    }
  });
});

// ---------- which tabs the strip offers (FR-11, FR-13, FR-8) ----------

describe('visibleExtensions', () => {
  it('offers an extension that is enabled and detected', () => {
    expect(visibleExtensions([ext()], []).map((e) => e.id)).toEqual(['git']);
  });

  it('never offers a disabled extension, sticky or not (FR-7/FR-8)', () => {
    expect(visibleExtensions([ext({ enabled: false })], [])).toEqual([]);
    expect(visibleExtensions([ext({ enabled: false })], ['git'])).toEqual([]);
  });

  it('keeps an already-open tab whose new root does not detect it (FR-13)', () => {
    expect(visibleExtensions([ext({ detected: false })], [])).toEqual([]);
    expect(visibleExtensions([ext({ detected: false })], ['git']).map((e) => e.id)).toEqual(['git']);
  });

  it('preserves registry order (FR-2/FR-10)', () => {
    const list = [ext({ id: 'cohorte' }), ext({ id: 'git' }), ext({ id: 'docker' })];
    expect(visibleExtensions(list, []).map((e) => e.id)).toEqual(['cohorte', 'git', 'docker']);
  });
});

// ---------- the five section states (FR-13, FR-14, FR-38) ----------

describe('sectionGate', () => {
  it('asks for a session only for a project-scoped panel (FR-14)', () => {
    expect(sectionGate(panel(), { root: null, detected: false, token: null })).toBe('no-session');
    expect(sectionGate(panel({ scope: 'fleet' }), { root: null, detected: false, token: null })).toBe('ready');
  });

  it('reads not-available when the root does not detect it (FR-13)', () => {
    expect(sectionGate(panel(), { root: '/repo', detected: false, token: null })).toBe('unavailable');
  });

  it('asks for a row when a log-tail token slot is unfilled (FR-38)', () => {
    const p = panel({ primitive: 'log-tail', tokenSource: { panelId: 'git:log', rowKey: 'id' } });
    expect(sectionGate(p, { root: '/repo', detected: true, token: null })).toBe('no-selection');
    expect(sectionGate(p, { root: '/repo', detected: true, token: 'abc' })).toBe('ready');
  });

  it('is ready otherwise', () => {
    expect(sectionGate(panel(), { root: '/repo', detected: true, token: null })).toBe('ready');
  });

  it('carries the copy the brief pins', () => {
    expect(SELECT_SESSION_COPY).toBe('select a session');
    expect(SELECT_ROW_COPY).toBe('select a row above');
    expect(notAvailableCopy('api')).toBe('not available in api');
    expect(notAvailableCopy(null)).toBe('not available in this project');
  });
});

describe('panel scope & refresh', () => {
  it('fetches a fleet panel with no root and a project panel with the active one (FR-20)', () => {
    expect(panelRoot(panel({ scope: 'fleet' }), '/repo')).toBeNull();
    expect(panelRoot(panel(), '/repo')).toBe('/repo');
  });

  it('mirrors the 2000ms refresh floor and honours null (FR-28)', () => {
    expect(effectiveRefreshMs(panel({ refreshMs: null }))).toBeNull();
    expect(effectiveRefreshMs(panel({ refreshMs: 250 }))).toBe(2000);
    expect(effectiveRefreshMs(panel({ refreshMs: 5000 }))).toBe(5000);
  });
});

// ---------- error composition (FR-49) ----------

describe('error composition', () => {
  const err = (code: AppError['code'], detail?: unknown): AppError => ({ code, message: 'boom', detail });

  it('names each cause', () => {
    expect(causeText(err('EXT_PROVIDER_MISSING', { argv0: 'cohorte' }))).toBe('cohorte not found on PATH');
    expect(causeText(err('EXT_PROVIDER_EXIT', { code: 1, stderr: 'nope' }))).toBe('exited 1');
    expect(causeText(err('EXT_PROVIDER_TIMEOUT'))).toBe('timed out after 10s');
    expect(causeText(err('EXT_OUTPUT_CAPPED'))).toBe('output exceeded 4 MiB');
    expect(causeText(err('EXT_SCHEMA_INVALID'))).toBe('unexpected output shape');
    expect(causeText(err('EXT_PATH_OUTSIDE_ROOT'))).toBe('path escapes the project root');
    expect(causeText(err('EXT_NOT_CONSENTED'))).toBe('not consented yet');
    expect(causeText(err('EXT_CONSENT_STALE'))).toBe('changed since you enabled it');
  });

  it('falls back to the core message for a code it does not special-case', () => {
    expect(causeText(err('INTERNAL'))).toBe('boom');
  });

  it('prefixes the declared minimum version when one exists (FR-26/FR-49)', () => {
    expect(errorHeadline(err('EXT_PROVIDER_EXIT', { code: 1 }), 'cohorte ≥ 2.4.0')).toBe('needs cohorte ≥ 2.4.0 · exited 1');
    expect(errorHeadline(err('EXT_PROVIDER_EXIT', { code: 1 }), null)).toBe('exited 1');
  });

  it('sanitizes a hostile manifest-declared minVersionLabel before composing the headline', () => {
    // minVersionLabel is manifest free text — a tab or an embedded newline
    // must not survive into the rendered headline.
    expect(errorHeadline(err('EXT_PROVIDER_EXIT', { code: 1 }), 'coh\torte\n≥ 2.4.0')).toBe('needs cohorte≥ 2.4.0 · exited 1');
  });

  it('surfaces the resolved command when the core sent one', () => {
    expect(errorCommand(err('EXT_PROVIDER_EXIT', { command: 'cohorte panels health --json' }))).toBe(
      'cohorte panels health --json',
    );
    expect(errorCommand(err('EXT_PROVIDER_EXIT', { command: 'git log' }))).toBe('git log');
    expect(errorCommand(err('EXT_PROVIDER_EXIT', { code: 1 }))).toBeNull();
  });

  it('falls back to argv0 for EXT_PROVIDER_MISSING when the core has no resolved command', () => {
    expect(errorCommand(err('EXT_PROVIDER_MISSING', { argv0: 'cohorte' }))).toBe('cohorte');
    expect(errorCommand(err('EXT_PROVIDER_MISSING', { argv0: 'cohorte', command: 'cohorte panels health' }))).toBe(
      'cohorte panels health',
    );
  });

  it('sanitizes a hostile detail.command / detail.argv0 before it reaches the render site (security)', () => {
    // detail.command/argv0 are provider/manifest-declared text — a bidi
    // override or control character must not survive into what
    // ExtSectionError renders verbatim.
    expect(errorCommand(err('EXT_PROVIDER_EXIT', { command: 'git log‮evil.exe' }))).toBe('git logevil.exe');
    expect(errorCommand(err('EXT_PROVIDER_MISSING', { argv0: 'coh‮orte' }))).toBe('cohorte');
    expect(errorCommand(err('EXT_PROVIDER_TIMEOUT', { command: 'coh\torte\nrun' }))).toBe('cohorterun');
  });

  it('surfaces the truncated stderr of a non-zero exit (FR-24)', () => {
    expect(errorDetailText(err('EXT_PROVIDER_EXIT', { code: 1, stderr: '  unknown command  ' }))).toBe('unknown command');
    expect(errorDetailText(err('EXT_PROVIDER_TIMEOUT'))).toBeNull();
  });
});

// ---------- pagination (FR-31, FR-32) ----------

describe('table cursor', () => {
  it('accumulates pages in order', () => {
    let c = appendPage(EMPTY_CURSOR, { rows: rows(100), offset: 0, hasMore: true });
    c = appendPage(c, { rows: rows(100, 100), offset: 100, hasMore: true });
    expect(c.rows).toHaveLength(200);
    expect(c.rows[199].id).toBe('r199');
    expect(c.nextOffset).toBe(200);
    expect(canLoadMore(c)).toBe(true);
  });

  it('stops offering more when the provider says there is none', () => {
    const c = appendPage(EMPTY_CURSOR, { rows: rows(3), offset: 0, hasMore: false });
    expect(canLoadMore(c)).toBe(false);
    expect(c.capped).toBe(false);
  });

  it('caps at 20 pages / 2000 rows (FR-32)', () => {
    let c = EMPTY_CURSOR;
    for (let i = 0; i < 20; i++) c = appendPage(c, { rows: rows(100, i * 100), offset: i * 100, hasMore: true });
    expect(c.rows).toHaveLength(2000);
    expect(c.capped).toBe(true);
    expect(canLoadMore(c)).toBe(false);
    expect(PAGE_CAP_NOTICE).toBe('showing first 2000 rows');
  });

  it('never grows past the row cap even if a page overshoots', () => {
    let c = EMPTY_CURSOR;
    for (let i = 0; i < 21; i++) c = appendPage(c, { rows: rows(150, i * 150), offset: i * 150, hasMore: true });
    expect(c.rows.length).toBeLessThanOrEqual(2000);
  });
});

// ---------- next fetch offset (FR-31, FR-33) ----------

describe('nextFetchOffset', () => {
  it('always requests offset 0 for a replace fetch, regardless of the cursor', () => {
    const c = appendPage(EMPTY_CURSOR, { rows: rows(20), offset: 0, hasMore: true });
    expect(nextFetchOffset(c, 'replace')).toBe(0);
    expect(nextFetchOffset(EMPTY_CURSOR, 'replace')).toBe(0);
  });

  it('advances an append fetch to the cursor\'s tracked next offset', () => {
    const first = appendPage(EMPTY_CURSOR, { rows: rows(20), offset: 0, hasMore: true });
    expect(nextFetchOffset(first, 'append')).toBe(20);
    const second = appendPage(first, { rows: rows(20, 20), offset: 20, hasMore: true });
    expect(nextFetchOffset(second, 'append')).toBe(40);
  });
});

// ---------- panel fetch state (FR-18, FR-25, FR-30, FR-34) ----------

describe('panel fetch state', () => {
  it('starts loading and drops the previous rows on a refresh (FR-30/FR-34)', () => {
    const loaded = receivePanel(startPanelFetch(CLOSED_PANEL, 1, 'replace'), 1, {
      ok: true,
      data: { primitive: 'table', rows: rows(3), offset: 0, hasMore: false },
    });
    expect(loaded.status).toBe('ready');
    const refreshing = startPanelFetch(loaded, 2, 'replace');
    expect(refreshing.status).toBe('loading');
    expect(refreshing.cursor.rows).toHaveLength(0);
  });

  it('keeps the accumulated rows while a page fetch is in flight (FR-31)', () => {
    const first = receivePanel(startPanelFetch(CLOSED_PANEL, 1, 'replace'), 1, {
      ok: true,
      data: { primitive: 'table', rows: rows(100), offset: 0, hasMore: true },
    });
    const paging = startPanelFetch(first, 2, 'append');
    expect(paging.cursor.rows).toHaveLength(100);
    const second = receivePanel(paging, 2, {
      ok: true,
      data: { primitive: 'table', rows: rows(100, 100), offset: 100, hasMore: false },
    });
    expect(second.cursor.rows).toHaveLength(200);
    expect(canLoadMore(second.cursor)).toBe(false);
  });

  it('ignores a stale response (FR-29: a refresh never applies out of order)', () => {
    const pending = startPanelFetch(CLOSED_PANEL, 2, 'replace');
    const stale = receivePanel(pending, 1, {
      ok: true,
      data: { primitive: 'table', rows: rows(5), offset: 0, hasMore: false },
    });
    expect(stale).toBe(pending);
  });

  it('replaces the body with the error rather than keeping stale rows (FR-30)', () => {
    const loaded = receivePanel(startPanelFetch(CLOSED_PANEL, 1, 'replace'), 1, {
      ok: true,
      data: { primitive: 'table', rows: rows(3), offset: 0, hasMore: false },
    });
    const failed = receivePanel(startPanelFetch(loaded, 2, 'replace'), 2, {
      ok: false,
      error: { code: 'EXT_PROVIDER_TIMEOUT', message: 'timed out' },
    });
    expect(failed.status).toBe('error');
    expect(failed.cursor.rows).toHaveLength(0);
    expect(failed.error?.code).toBe('EXT_PROVIDER_TIMEOUT');
  });

  it('records a zero-row payload as a SUCCESS, not an error (FR-49)', () => {
    const empty = receivePanel(startPanelFetch(CLOSED_PANEL, 1, 'replace'), 1, {
      ok: true,
      data: { primitive: 'table', rows: [], offset: 0, hasMore: false },
    });
    expect(empty.status).toBe('ready');
    expect(empty.error).toBeNull();
    expect(empty.cursor.rows).toHaveLength(0);
  });

  it('carries key-value and stat-row payloads whole (FR-25)', () => {
    const kv = receivePanel(startPanelFetch(CLOSED_PANEL, 1, 'replace'), 1, {
      ok: true,
      data: { primitive: 'key-value', rows: [{ key: 'pipeline', value: 'cohorte', tone: 'ok' }] },
    });
    expect(kv.keyValue).toHaveLength(1);
    const st = receivePanel(startPanelFetch(CLOSED_PANEL, 1, 'replace'), 1, {
      ok: true,
      data: { primitive: 'stat-row', tiles: [{ label: 'spend', value: '$4' }] },
    });
    expect(st.tiles).toHaveLength(1);
  });
});

// ---------- log-tail ring buffer (FR-40) ----------

describe('log buffer', () => {
  it('appends lines in order', () => {
    const buf = appendLogLines(EMPTY_LOG, ['a', 'b']);
    expect(buf.lines).toEqual(['a', 'b']);
    expect(buf.dropped).toBe(0);
  });

  it('drops the oldest past 2000 lines and counts them', () => {
    let buf = EMPTY_LOG;
    for (let i = 0; i < 2100; i++) buf = appendLogLines(buf, [`l${i}`]);
    expect(buf.lines).toHaveLength(2000);
    expect(buf.lines[0]).toBe('l100');
    expect(buf.dropped).toBe(100);
  });

  it('drops the oldest past 1 MiB too', () => {
    const big = 'x'.repeat(64 * 1024);
    let buf = EMPTY_LOG;
    for (let i = 0; i < 20; i++) buf = appendLogLines(buf, [big]);
    expect(buf.bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(buf.dropped).toBeGreaterThan(0);
  });

  it('renders the dim leading notice only when something was dropped', () => {
    expect(earlierLinesNotice(0)).toBeNull();
    expect(earlierLinesNotice(1)).toBe('… 1 earlier line');
    expect(earlierLinesNotice(12)).toBe('… 12 earlier lines');
  });
});

// ---------- the one token slot (FR-38) ----------

describe('token slot', () => {
  it('accepts the contract charset and refuses a leading dash', () => {
    expect(isValidToken('extensions')).toBe(true);
    expect(isValidToken('a.b-c_1')).toBe(true);
    expect(isValidToken('--upload-pack=evil')).toBe(false);
    expect(isValidToken('has space')).toBe(false);
    expect(isValidToken('')).toBe(false);
    expect(isValidToken(null)).toBe(false);
    expect(isValidToken('a'.repeat(129))).toBe(false);
  });

  it('reads the token off a selected row, refusing an invalid cell', () => {
    const row: TableRow = { id: 'r1', cells: { name: 'web_1', bad: '-rf' }, tone: 'neutral' };
    expect(tokenFromRow(row, 'name')).toBe('web_1');
    expect(tokenFromRow(row, 'bad')).toBeNull();
    expect(tokenFromRow(row, 'missing')).toBeNull();
    expect(tokenFromRow(undefined, 'name')).toBeNull();
  });
});

// ---------- typed cells (FR-36) ----------

describe('cell rendering', () => {
  it('renders a time column in the app relative format', () => {
    const now = 1_700_000_000_000;
    expect(cellText('time', String(now - 5_000), now)).toBe('now');
    expect(cellText('time', String(now - 120_000), now)).toBe('2m');
    // a non-numeric time cell degrades to its own text rather than to NaN
    expect(cellText('time', 'yesterday', now)).toBe('yesterday');
  });

  it('leaves other kinds verbatim and a missing cell empty (FR-36)', () => {
    expect(cellText('text', 'main')).toBe('main');
    expect(cellText('number', '42')).toBe('42');
    expect(cellText('status', 'running')).toBe('running');
    expect(cellText('text', undefined)).toBe('');
  });

  it('never lets a status tone borrow the accent (design brief identity rule)', () => {
    const tones = ['ok', 'warn', 'error', 'neutral', 'busy'] as const;
    for (const tone of tones) expect(toneColor(tone)).not.toContain('accent');
    expect(toneColor('ok')).toBe('var(--success)');
    expect(toneColor('neutral')).toBe('var(--text-muted)');
    expect(toneClassName('warn')).toBe('ext-tag ext-tag--warn');
  });

  it('truncates a path from the left so the filename survives', () => {
    expect(truncatePathLeft('specs/reports/extensions.loop.log', 100)).toBe('specs/reports/extensions.loop.log');
    expect(truncatePathLeft('a/very/long/path/to/file.ts', 12)).toBe('…/to/file.ts');
  });
});

// ---------- consent (extension-install FR-15..FR-20) ----------

describe('consentControlKind', () => {
  it('maps granted to a toggle and never/stale to a review control', () => {
    expect(consentControlKind({ state: 'granted' })).toBe('toggle');
    expect(consentControlKind({ state: 'never' })).toBe('review');
    expect(consentControlKind({ state: 'stale' })).toBe('review-again');
  });
});

describe('sanitizeForDisplay', () => {
  it('strips Cc/C1 control characters, including tab and newline', () => {
    expect(sanitizeForDisplay('gitlog\tfake line\n')).toBe('gitlogfake line');
    expect(sanitizeForDisplay('ab')).toBe('ab');
  });

  it('strips bidi-override and bidi-isolate code points', () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE could visually reverse the rest of the token.
    expect(sanitizeForDisplay('safe‮exe.cmd')).toBe('safeexe.cmd');
    expect(sanitizeForDisplay('⁦isolated⁩')).toBe('isolated');
    expect(sanitizeForDisplay('‎LRM‏RLM؜ALM')).toBe('LRMRLMALM');
  });

  it('leaves ordinary text untouched', () => {
    expect(sanitizeForDisplay('git log --oneline')).toBe('git log --oneline');
  });

  it('neutralizes bidi-override/control-character payloads a manifest could put in panel.emptyCopy', () => {
    // panel.emptyCopy is manifest-declared free text (same trust class as
    // PanelInfo.label) — regression guard for the round-7 fix wiring it
    // through sanitizeForDisplay in PanelSection/LogTailSection.
    expect(sanitizeForDisplay('no rows‮gnp.exe‬')).toBe('no rowsgnp.exe');
    expect(sanitizeForDisplay('nothing\tyet\n')).toBe('nothingyet');
  });
});

// Regression guard for the round-7 remediation: panel.emptyCopy is
// manifest-declared free text, same trust class as PanelInfo.label, and must
// be sanitized before render in both places that display it. No DOM test
// runner is wired for this project (see PIPELINE.md §Testing), so this
// asserts the call sites directly against source rather than a rendered DOM.
describe('panel.emptyCopy sanitization at render call sites', () => {
  it('PanelSection wraps panel.emptyCopy in sanitizeForDisplay before rendering it', async () => {
    // Vite's `?raw` import (no DOM renderer is wired for this project — see
    // PIPELINE.md §Testing) gives a source-text regression guard against
    // reverting the round-7 fix that mirrors the earlier panel.label fix.
    const src = (await import('./PanelSection.tsx?raw')).default as string;
    expect(src).toMatch(/EmptyPane[^<]*>\s*\{sanitizeForDisplay\(panel\.emptyCopy\)\}/s);
  });

  it('LogTailSection wraps panel.emptyCopy in sanitizeForDisplay before rendering it', async () => {
    const src = (await import('./LogTailSection.tsx?raw')).default as string;
    expect(src).toMatch(/ext-log__waiting[^<]*>\{sanitizeForDisplay\(panel\.emptyCopy\)\}/s);
  });
});

// Regression guard for the round-9 remediation: the modal-level error banner
// (extensionsSetEnabled/extensionsDetect failures) must be sanitized like
// every other AppError.message render site this feature touches
// (ConsentDialog, manifestErrorCause) — not exploitable today (only core
// static strings reach it), but a regression the moment a core error carries
// manifest text. Same "no DOM runner" rationale as the panel.emptyCopy guard
// above: assert the call site against source text.
describe('ExtensionsModal error banner sanitization', () => {
  it('wraps error.message in sanitizeForDisplay before rendering it', async () => {
    const src = (await import('./ExtensionsModal.tsx?raw')).default as string;
    expect(src).toMatch(/ext-modal__error[^<]*>\{sanitizeForDisplay\(error\.message\)\}/s);
  });
});

// Regression guard for the round-10 remediation: `id` is a raw, disk-supplied
// extension directory name (not core-validated free text like `label`), so
// it must go through sanitizeForDisplay before render just like every other
// field on the row — including the invalid-manifest (FR-3) row, where it's
// the only identifier shown. Same "no DOM runner" rationale as the other
// call-site guards above: assert the source text directly.
describe('ExtensionsModal id sanitization', () => {
  it('wraps e.id in sanitizeForDisplay before rendering it', async () => {
    const src = (await import('./ExtensionsModal.tsx?raw')).default as string;
    expect(src).toMatch(/ext-modal__id[^<]*>\{sanitizeForDisplay\(e\.id\)\}/s);
  });
});

// Regression guard for the round-11 remediation: a failed `disable`
// (rejected promise or an `{ ok: false }` response) must surface, not be
// swallowed — same "no DOM runner" rationale as the other call-site guards
// above: assert the source text directly.
describe('ExtensionView disable error surfacing', () => {
  it('sets disableError from a rejected promise and from an ok:false response, and renders it sanitized', async () => {
    const src = (await import('./ExtensionView.tsx?raw')).default as string;
    expect(src).toMatch(/setDisableError\(res\.error\)/);
    expect(src).toMatch(/catch\(\(\) => \{[\s\S]*?setDisableError\(/);
    expect(src).toMatch(/ext-view__error[^<]*>\{sanitizeForDisplay\(disableError\.message\)\}/s);
  });
});

describe('formatArgv', () => {
  it('joins an argv array with a single space, wrapping each token in a Unicode isolate', () => {
    expect(formatArgv(['git', 'log', '--oneline'])).toBe('⁦git⁩ ⁦log⁩ ⁦--oneline⁩');
    expect(formatArgv(['git'])).toBe('⁦git⁩');
  });

  it('strips control and bidi-override characters out of each token before wrapping it (hygiene)', () => {
    // an embedded newline could forge an extra display line; a bidi override
    // could visually reorder the token's own bytes.
    const withControl = formatArgv(['git', 'log‮vil.exe', 'a\nb']);
    expect(withControl).not.toMatch(/[ --؜‎‏‪-‮]/);
    expect(withControl).toBe('⁦git⁩ ⁦logvil.exe⁩ ⁦ab⁩');
  });
});

describe('sourceManifestSha256', () => {
  it('reads the loaded hash off the source, for the dialog to echo back (FR-18)', () => {
    expect(sourceManifestSha256(source({ manifestSha256: 'abc123' }))).toBe('abc123');
  });

  it('is the empty string only for a manifest that could not be read — which offers no consent control', () => {
    const broken = ext({
      source: source({ manifestSha256: '' }),
      manifestError: { code: 'EXT_MANIFEST_INVALID', message: 'unknown primitive "tabel"' },
      panels: [],
    });
    expect(sourceManifestSha256(broken.source)).toBe('');
    // FR-6: never partially loaded, so there is nothing to consent TO.
    expect(broken.panels).toEqual([]);
  });
});

describe('consentRequest', () => {
  it('echoes the hash of the manifest the dialog is showing (FR-18)', () => {
    const shown = ext({ id: 'k8s', consent: { state: 'never' }, source: source({ manifestSha256: 'sha-shown' }) });
    expect(consentRequest(shown, '/repo')).toEqual({
      extensionId: 'k8s',
      manifestSha256: 'sha-shown',
      root: '/repo',
    });
  });

  it('carries a null root through, for a fleet-only consent', () => {
    expect(consentRequest(ext(), null).root).toBeNull();
  });

  it('echoes the RELOADED hash after a stale-under-the-dialog reload, never the original', () => {
    // EXT_CONSENT_STALE reloads the list in place; a second confirm must send
    // the hash of the commands now on screen, or it would refuse forever.
    const before = ext({ source: source({ manifestSha256: 'sha-old' }) });
    const reloaded = ext({ consent: { state: 'stale' }, source: source({ manifestSha256: 'sha-new' }) });
    expect(consentRequest(before, '/repo').manifestSha256).toBe('sha-old');
    expect(consentRequest(reloaded, '/repo').manifestSha256).toBe('sha-new');
  });
});

// ---------- manifest errors (extension-install FR-5/FR-6) ----------

describe('manifest error composition', () => {
  const err = (code: AppError['code'], detail?: unknown): AppError => ({ code, message: 'boom', detail });

  it('prefixes an invalid/unsupported manifest with "invalid manifest"', () => {
    expect(manifestErrorCause(err('EXT_MANIFEST_INVALID', { pointer: '/panels/1/primitive' }))).toBe(
      'invalid manifest · boom',
    );
    expect(manifestErrorCause(err('EXT_MANIFEST_UNSUPPORTED', { found: 2, supported: 1 }))).toBe(
      'invalid manifest · boom',
    );
  });

  it('falls back to the core message for any other code', () => {
    expect(manifestErrorCause(err('INTERNAL'))).toBe('boom');
  });

  it('surfaces the manifest path from detail, when present', () => {
    expect(manifestErrorPath(err('EXT_MANIFEST_INVALID', { manifestPath: '/home/u/.francois/extensions/k8s/extension.json' }))).toBe(
      '/home/u/.francois/extensions/k8s/extension.json',
    );
    expect(manifestErrorPath(err('EXT_MANIFEST_INVALID'))).toBeNull();
  });
});

// ---------- FR-49 causeText / manifest codes (extension-install remediation) ----------

describe('causeText for manifest codes', () => {
  const err = (code: AppError['code'], message: string): AppError => ({ code, message, detail: null });

  it('strips bidi/control chars from error.message for EXT_MANIFEST_INVALID, matching manifestErrorCause', () => {
    const unsafe = err('EXT_MANIFEST_INVALID', 'bad‮path');
    expect(causeText(unsafe)).toBe(manifestErrorCause(unsafe));
    expect(causeText(unsafe)).not.toContain('‮');
  });

  it('strips bidi/control chars from error.message for EXT_MANIFEST_UNSUPPORTED, matching manifestErrorCause', () => {
    const unsafe = err('EXT_MANIFEST_UNSUPPORTED', 'bad path');
    expect(causeText(unsafe)).toBe(manifestErrorCause(unsafe));
    expect(causeText(unsafe)).not.toContain(' ');
  });
});
