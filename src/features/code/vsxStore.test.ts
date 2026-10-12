// code-editor-vsx FR-6/FR-10: the EXTENSIONS sidebar's store against a mocked api.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VsxContributions, VsxDetails, VsxInstalled, VsxLanguage, VsxSummary } from '../../../contract/code-editor-vsx';

const api = vi.hoisted(() => ({
  vsxSearch: vi.fn(),
  vsxDetails: vi.fn(),
  vsxInstall: vi.fn(),
  vsxUninstall: vi.fn(),
  vsxSetEnabled: vi.fn(),
  vsxList: vi.fn(),
  vsxContributions: vi.fn(),
}));
vi.mock('../../lib/api', () => api);

import { languageFor, setContributedLanguages } from './language';
import { contributionSummary, formatDownloads, initialVsxState, orderContributions, SEARCH_DEBOUNCE_MS, supportLabel, useVsxStore, vsxErrorText } from './vsxStore';

const ok = <T>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message = 'boom', detail?: unknown) => ({ ok: false as const, error: { code, message, detail } });
const s = () => useVsxStore.getState();

const summary = (id: string, more: Partial<VsxSummary> = {}): VsxSummary => ({
  id,
  namespace: id.split('.')[0],
  name: id.split('.')[1],
  displayName: id,
  description: '',
  version: '1.0.0',
  publisher: id.split('.')[0],
  downloadCount: 10,
  averageRating: null,
  icon: null,
  support: null,
  verified: false,
  ...more,
});
const installed = (id: string, more: Partial<VsxInstalled> = {}): VsxInstalled => ({
  id,
  displayName: id,
  publisher: 'pub',
  description: '',
  version: '1.0.0',
  icon: null,
  support: 'full',
  contributions: { languages: 1, grammars: 1, snippets: 0, languageConfigurations: 1 },
  languageIds: ['x'],
  enabled: true,
  installedAt: 1,
  ...more,
});
const language = (extensionId: string, id: string, ext: string): VsxLanguage => ({
  extensionId,
  id,
  aliases: [],
  extensions: [ext],
  filenames: [],
  filenamePatterns: [],
  firstLine: null,
  configuration: null,
});
const EMPTY: VsxContributions = { languages: [], grammars: [], snippets: [] };
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

beforeEach(() => {
  vi.useFakeTimers();
  useVsxStore.setState(initialVsxState());
  for (const f of Object.values(api)) f.mockReset();
  api.vsxList.mockResolvedValue(ok([]));
  api.vsxContributions.mockResolvedValue(ok(EMPTY));
});
afterEach(() => {
  vi.useRealTimers();
  setContributedLanguages([]);
});

describe('formatDownloads', () => {
  it('abbreviates thousands and millions, flooring so it never overstates', () => {
    expect(formatDownloads(0)).toBe('0');
    expect(formatDownloads(999)).toBe('999');
    expect(formatDownloads(1_500)).toBe('1.5K');
    expect(formatDownloads(34_000)).toBe('34K');
    expect(formatDownloads(999_999)).toBe('999K');
    expect(formatDownloads(1_234_567)).toBe('1.2M');
    expect(formatDownloads(2_000_000)).toBe('2M');
    expect(formatDownloads(15_900_000)).toBe('15M');
  });
});

describe('contributionSummary', () => {
  it('lists the non-zero contribution counts', () => {
    expect(contributionSummary({ languages: 2, grammars: 1, snippets: 0, languageConfigurations: 1 })).toBe('2 languages · 1 grammar · 1 language configuration');
    expect(contributionSummary({ languages: 0, grammars: 0, snippets: 3, languageConfigurations: 0 })).toBe('3 snippet files');
    expect(contributionSummary({ languages: 0, grammars: 0, snippets: 0, languageConfigurations: 0 })).toBe('');
  });
});

describe('supportLabel / vsxErrorText', () => {
  it('names the support levels', () => {
    expect(supportLabel('full')).toBe('Full');
    expect(supportLabel('partial')).toBe('Syntax & snippets only');
    expect(supportLabel('unsupported')).toBe('Needs VS Code');
  });
  it('turns the vsx error codes into copy, the package reason included', () => {
    expect(vsxErrorText({ code: 'VSX_UNREACHABLE', message: 'x' })).toMatch(/reach Open VSX/);
    expect(vsxErrorText({ code: 'VSX_INVALID_PACKAGE', message: 'x', detail: { reason: 'checksum mismatch' } })).toBe('The package failed verification: checksum mismatch.');
    expect(vsxErrorText({ code: 'VSX_UNSUPPORTED', message: 'x' })).toMatch(/Needs VS Code/);
    expect(vsxErrorText({ code: 'INTERNAL', message: 'disk full' })).toBe('disk full');
  });
});

describe('search (FR-6)', () => {
  it('runs 300 ms after the last keystroke, from offset 0', async () => {
    api.vsxSearch.mockResolvedValue(ok({ results: [summary('a.b')], total: 1 }));
    s().setQuery('to');
    s().setQuery('toml');
    expect(api.vsxSearch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(api.vsxSearch).toHaveBeenCalledTimes(1);
    expect(api.vsxSearch).toHaveBeenCalledWith({ query: 'toml', offset: 0 });
    expect(s()).toMatchObject({ results: [summary('a.b')], total: 1, searchStatus: 'done' });
  });

  it('drops a response older than the newest request', async () => {
    const first = deferred<ReturnType<typeof ok>>();
    api.vsxSearch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ok({ results: [summary('new.one')], total: 1 }));
    const a = s().search();
    s().setQuery('new');
    await s().search();
    first.resolve(ok({ results: [summary('old.one')], total: 1 }));
    await a;
    expect(s().results.map((r) => r.id)).toEqual(['new.one']);
  });

  it('loads more at the current offset and appends', async () => {
    api.vsxSearch.mockResolvedValueOnce(ok({ results: [summary('a.a'), summary('a.b')], total: 3 })).mockResolvedValueOnce(ok({ results: [summary('a.c')], total: 3 }));
    await s().search();
    await s().loadMore();
    expect(api.vsxSearch).toHaveBeenLastCalledWith({ query: '', offset: 2 });
    expect(s().results.map((r) => r.id)).toEqual(['a.a', 'a.b', 'a.c']);
  });

  it('drops a load-more answer once a new search started', async () => {
    api.vsxSearch.mockResolvedValueOnce(ok({ results: [summary('a.a')], total: 5 }));
    await s().search();
    const more = deferred<ReturnType<typeof ok>>();
    api.vsxSearch.mockReturnValueOnce(more.promise).mockResolvedValueOnce(ok({ results: [summary('b.b')], total: 1 }));
    const m = s().loadMore();
    await s().search();
    more.resolve(ok({ results: [summary('a.z')], total: 5 }));
    await m;
    expect(s().results.map((r) => r.id)).toEqual(['b.b']);
  });

  it('shows an error and retries the failed step', async () => {
    api.vsxSearch.mockResolvedValueOnce(fail('VSX_UNREACHABLE'));
    await s().search();
    expect(s()).toMatchObject({ searchStatus: 'error', results: [] });
    expect(s().searchError).toMatch(/reach Open VSX/);
    api.vsxSearch.mockResolvedValueOnce(ok({ results: [summary('a.a')], total: 2 })).mockResolvedValueOnce(fail('VSX_UNREACHABLE'));
    await s().retry();
    await s().loadMore();
    expect(s()).toMatchObject({ searchStatus: 'error', results: [summary('a.a')] });
    api.vsxSearch.mockResolvedValueOnce(ok({ results: [summary('a.b')], total: 2 }));
    await s().retry();
    expect(api.vsxSearch).toHaveBeenLastCalledWith({ query: '', offset: 1 });
    expect(s().results).toHaveLength(2);
    expect(s().searchError).toBeNull();
  });
});

describe('details', () => {
  const details = { ...summary('a.b'), support: 'full', contributions: { languages: 1, grammars: 1, snippets: 0, languageConfigurations: 0 }, languageIds: ['x'], license: 'MIT', repository: null, pageUrl: 'https://open-vsx.org/extension/a/b', readme: null } as VsxDetails;

  it('expands a row and fetches its details once', async () => {
    api.vsxDetails.mockResolvedValue(ok(details));
    await s().toggleExpanded('a.b');
    expect(s().expanded).toBe('a.b');
    expect(s().details['a.b']).toEqual({ status: 'done', data: details, error: null });
    await s().toggleExpanded('a.b');
    expect(s().expanded).toBeNull();
    await s().toggleExpanded('a.b');
    expect(api.vsxDetails).toHaveBeenCalledTimes(1);
  });

  it('keeps a details error for Retry', async () => {
    api.vsxDetails.mockResolvedValueOnce(fail('VSX_NOT_FOUND')).mockResolvedValueOnce(ok(details));
    await s().toggleExpanded('a.b');
    expect(s().details['a.b'].status).toBe('error');
    await s().loadDetails('a.b');
    expect(s().details['a.b'].status).toBe('done');
  });
});

describe('install / uninstall / enable (FR-6, FR-10)', () => {
  it('installs, records the extension and reloads the contributions', async () => {
    api.vsxInstall.mockResolvedValue(ok(installed('b.b')));
    api.vsxList.mockResolvedValue(ok([installed('b.b')]));
    const p = s().install('b.b');
    expect(s().busy['b.b']).toBe('install');
    await p;
    expect(api.vsxInstall).toHaveBeenCalledWith({ id: 'b.b' });
    expect(s().installed.map((i) => i.id)).toEqual(['b.b']);
    expect(s().busy['b.b']).toBeUndefined();
    expect(api.vsxContributions).toHaveBeenCalled();
  });

  it('records a failed install on the row', async () => {
    api.vsxInstall.mockResolvedValue(fail('VSX_INVALID_PACKAGE', 'x', { reason: 'zip-slip' }));
    await s().install('b.b');
    expect(s().rowErrors['b.b']).toBe('The package failed verification: zip-slip.');
    expect(api.vsxContributions).not.toHaveBeenCalled();
    s().dismissRowError('b.b');
    expect(s().rowErrors['b.b']).toBeUndefined();
  });

  it('uninstalls and toggles, reloading the contributions each time', async () => {
    useVsxStore.setState({ installed: [installed('a.a'), installed('b.b')] });
    api.vsxSetEnabled.mockResolvedValue(ok(installed('a.a', { enabled: false })));
    api.vsxUninstall.mockResolvedValue(ok(null));
    // the core's list mirrors what the mutation left behind
    api.vsxList.mockImplementation(() => Promise.resolve(ok(s().installed)));
    await s().setEnabled('a.a', false);
    expect(api.vsxSetEnabled).toHaveBeenCalledWith({ id: 'a.a', enabled: false });
    expect(s().installed.find((i) => i.id === 'a.a')?.enabled).toBe(false);
    await s().uninstall('b.b');
    expect(api.vsxUninstall).toHaveBeenCalledWith({ id: 'b.b' });
    expect(s().installed.map((i) => i.id)).toEqual(['a.a']);
    expect(api.vsxContributions).toHaveBeenCalledTimes(2);
  });

  it('clears a warning when the extension is disabled or removed', async () => {
    useVsxStore.setState({ installed: [installed('a.a')], warnings: { 'a.a': 'bad grammar' } });
    api.vsxUninstall.mockResolvedValue(ok(null));
    await s().uninstall('a.a');
    expect(s().warnings['a.a']).toBeUndefined();
  });
});

describe('reloadContributions (FR-10)', () => {
  it('stores the installed list and the contributions, oldest install first, and feeds language.ts', async () => {
    api.vsxList.mockResolvedValue(ok([installed('new.x', { installedAt: 20 }), installed('old.x', { installedAt: 10 })]));
    api.vsxContributions.mockResolvedValue(ok({ ...EMPTY, languages: [language('new.x', 'nix-new', '.nix'), language('old.x', 'nix-old', '.nix')] }));
    await s().reloadContributions();
    expect(s().contributions?.languages.map((l) => l.id)).toEqual(['nix-old', 'nix-new']);
    expect(s().installed).toHaveLength(2);
    expect(languageFor('a.nix').id).toBe('nix-new');
  });

  it('keeps the last good contributions when the reload fails', async () => {
    useVsxStore.setState({ contributions: EMPTY });
    api.vsxContributions.mockResolvedValue(fail('INTERNAL'));
    await s().reloadContributions();
    expect(s().contributions).toBe(EMPTY);
  });
});

describe('orderContributions', () => {
  it('sorts every list by its extension install time, unknown ones first, stably', () => {
    const c: VsxContributions = { languages: [language('b', 'l1', '.a'), language('zz', 'l2', '.a'), language('a', 'l3', '.a')], grammars: [], snippets: [] };
    const order = orderContributions(c, [installed('a', { installedAt: 1 }), installed('b', { installedAt: 2 })]);
    expect(order.languages.map((l) => l.id)).toEqual(['l2', 'l3', 'l1']);
  });
});
