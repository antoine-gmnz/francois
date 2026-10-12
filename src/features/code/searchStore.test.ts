// code-editor-workspace FR-12/FR-13: the search sidebar's store against a mocked api.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorSearchData } from '../../../contract/code-editor-workspace';

const api = vi.hoisted(() => ({ editorSearch: vi.fn(), editorReplace: vi.fn() }));
vi.mock('../../lib/api', () => api);

import { initialSearchState, matchRange, replacePlan, SEARCH_DEBOUNCE_MS, useSearchStore } from './searchStore';
import { PROJECT_ROOT, SESSION_ROOT, tab } from './code.testutil';

const ok = <T>(data: T) => ({ ok: true as const, data });
const s = () => useSearchStore.getState();
const data = (paths: string[], perFile = 1, truncated = false): EditorSearchData => ({
  files: paths.map((path) => ({
    path,
    matches: Array.from({ length: perFile }, (_, i) => ({ line: i + 1, column: 3, preview: 'a foo b', previewStart: 2, previewEnd: 5 })),
  })),
  matchCount: paths.length * perFile,
  truncated,
});
const flush = async () => {
  await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
};

beforeEach(() => {
  vi.useFakeTimers();
  useSearchStore.setState(initialSearchState());
  api.editorSearch.mockReset();
  api.editorReplace.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('search (FR-12)', () => {
  it('runs 300 ms after the last keystroke with the options and include glob', async () => {
    api.editorSearch.mockResolvedValue(ok(data(['a.ts'])));
    s().setQuery(PROJECT_ROOT, 'fo');
    s().setQuery(PROJECT_ROOT, 'foo');
    s().toggleOption(PROJECT_ROOT, 'matchCase');
    s().setInclude(PROJECT_ROOT, 'src/**');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(api.editorSearch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.editorSearch).toHaveBeenCalledTimes(1);
    expect(api.editorSearch).toHaveBeenCalledWith({
      root: PROJECT_ROOT,
      query: 'foo',
      options: { matchCase: true, wholeWord: false, regex: false },
      include: 'src/**',
    });
    expect(s().result).toEqual(data(['a.ts']));
    expect(s().status).toBe('done');
  });

  it('an empty query clears the results without a call', async () => {
    api.editorSearch.mockResolvedValue(ok(data(['a.ts'])));
    s().setQuery(PROJECT_ROOT, 'foo');
    await flush();
    s().setQuery(PROJECT_ROOT, '  ');
    await flush();
    expect(api.editorSearch).toHaveBeenCalledTimes(1);
    expect(s().result).toBeNull();
    expect(s().status).toBe('idle');
  });

  it('drops a stale response that lands after a newer query', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    api.editorSearch.mockImplementationOnce(() => new Promise((r) => (resolveOld = r))).mockResolvedValueOnce(ok(data(['new.ts'])));
    s().setQuery(PROJECT_ROOT, 'old');
    await flush();
    s().setQuery(PROJECT_ROOT, 'new');
    await flush();
    resolveOld(ok(data(['old.ts'])));
    await vi.advanceTimersByTimeAsync(0);
    expect(s().result?.files.map((f) => f.path)).toEqual(['new.ts']);
  });

  it('an error (bad regex) is shown and clears the results', async () => {
    api.editorSearch.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'Invalid regular expression: (' } });
    s().setQuery(PROJECT_ROOT, '(');
    await flush();
    expect(s()).toMatchObject({ status: 'error', error: 'Invalid regular expression: (', result: null });
  });

  it('a new root resets the query and results', async () => {
    api.editorSearch.mockResolvedValue(ok(data(['a.ts'])));
    s().setQuery(PROJECT_ROOT, 'foo');
    await flush();
    s().syncRoot(SESSION_ROOT);
    expect(s()).toMatchObject({ query: '', result: null, status: 'idle' });
    s().syncRoot(SESSION_ROOT);
    expect(s().rootKey).toBe('session:s1');
  });

  it('collapses and expands a file group', () => {
    s().toggleCollapsed('a.ts');
    expect(s().collapsed).toEqual(['a.ts']);
    s().toggleCollapsed('a.ts');
    expect(s().collapsed).toEqual([]);
  });
});

describe('replacePlan / matchRange', () => {
  it('skips files with a dirty buffer and sends open clean tabs their version', () => {
    const plan = replacePlan(data(['a.ts', 'b.ts', 'c.ts'], 2).files, [tab('a.ts', { dirty: true }), tab('b.ts', { version: 'v9' })]);
    expect(plan.targets).toEqual([{ path: 'b.ts' , baseVersion: 'v9' }, { path: 'c.ts' }]);
    expect(plan.dirty).toEqual(['a.ts']);
    expect(plan.matches).toBe(4);
  });

  it('selects the match from its column for the preview span length', () => {
    expect(matchRange({ line: 4, column: 7, preview: 'x', previewStart: 2, previewEnd: 5 })).toEqual({
      startLineNumber: 4,
      startColumn: 7,
      endLineNumber: 4,
      endColumn: 10,
    });
  });
});

describe('replace all (FR-13)', () => {
  it('replaces in the planned files, names the skipped dirty ones, then re-runs the search', async () => {
    api.editorSearch.mockResolvedValue(ok(data(['a.ts', 'b.ts'])));
    s().setQuery(PROJECT_ROOT, 'foo');
    s().setReplacement('bar');
    s().togglePreserveCase();
    await flush();
    api.editorReplace.mockResolvedValue(ok({ written: [{ path: 'b.ts', version: 'v2', replacements: 1 }], skipped: [] }));
    await s().replaceAll(PROJECT_ROOT, [tab('a.ts', { dirty: true })]);
    expect(api.editorReplace).toHaveBeenCalledWith({
      root: PROJECT_ROOT,
      query: 'foo',
      options: { matchCase: false, wholeWord: false, regex: false },
      replacement: 'bar',
      preserveCase: true,
      files: [{ path: 'b.ts' }],
    });
    expect(s().notice).toBe('Replaced 1 match in 1 file. Skipped 1 file with unsaved edits: a.ts');
    expect(api.editorSearch).toHaveBeenCalledTimes(2);
  });

  it('reports files the core skipped', async () => {
    api.editorSearch.mockResolvedValue(ok(data(['a.ts', 'b.ts'])));
    s().setQuery(PROJECT_ROOT, 'foo');
    await flush();
    api.editorReplace.mockResolvedValue(ok({ written: [{ path: 'a.ts', version: 'v2', replacements: 3 }], skipped: [{ path: 'b.ts', reason: 'stale' }] }));
    await s().replaceAll(PROJECT_ROOT, []);
    expect(s().notice).toBe('Replaced 3 matches in 1 file. 1 file changed on disk and was skipped.');
  });

  it('an error lands in the notice', async () => {
    api.editorSearch.mockResolvedValue(ok(data(['a.ts'])));
    s().setQuery(PROJECT_ROOT, 'foo');
    await flush();
    api.editorReplace.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'nope' } });
    await s().replaceAll(PROJECT_ROOT, []);
    expect(s().notice).toBe('Replace failed: nope');
  });
});
