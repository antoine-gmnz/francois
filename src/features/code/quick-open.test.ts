// code-editor-workspace FR-11: quick open — query parsing, file sections, symbol filtering.

import { describe, expect, it } from 'vitest';
import { parseQuickQuery, quickOpenSections, rankSymbols } from './quick-open';
import type { FlatSymbol } from './symbols';

describe('parseQuickQuery', () => {
  it('reads files, :line[:col] and @symbol', () => {
    expect(parseQuickQuery('')).toEqual({ kind: 'files', text: '' });
    expect(parseQuickQuery('  cb ')).toEqual({ kind: 'files', text: 'cb' });
    expect(parseQuickQuery(':42')).toEqual({ kind: 'line', line: 42, column: null });
    expect(parseQuickQuery(':42:7')).toEqual({ kind: 'line', line: 42, column: 7 });
    expect(parseQuickQuery('@handle')).toEqual({ kind: 'symbol', text: 'handle' });
  });

  it('a bare or malformed colon query has no line yet', () => {
    expect(parseQuickQuery(':')).toEqual({ kind: 'line', line: null, column: null });
    expect(parseQuickQuery(':x')).toEqual({ kind: 'line', line: null, column: null });
    expect(parseQuickQuery(':0')).toEqual({ kind: 'line', line: null, column: null });
  });
});

describe('quickOpenSections', () => {
  const paths = ['src/auth/callback.ts', 'src/auth/session.ts', 'README.md', 'src/app.ts'];

  it('empty query: recent files, then the rest', () => {
    const s = quickOpenSections(paths, '', ['README.md', 'gone.ts']);
    expect(s.recent.map((r) => r.path)).toEqual(['README.md']);
    expect(s.files.map((r) => r.path)).toEqual(['src/auth/callback.ts', 'src/auth/session.ts', 'src/app.ts']);
    expect(s.recent[0]).toMatchObject({ name: 'README.md', dir: '', hits: [] });
  });

  it('typed query: matching recents, then the other matches fuzzy-ranked', () => {
    const s = quickOpenSections(paths, 'cb', ['src/auth/session.ts', 'src/auth/callback.ts']);
    expect(s.recent.map((r) => r.path)).toEqual(['src/auth/callback.ts']);
    expect(s.files).toEqual([]);
    const t = quickOpenSections(paths, 'ts', []);
    expect(t.recent).toEqual([]);
    expect(t.files.length).toBe(3);
  });

  it('hits index into the basename', () => {
    const s = quickOpenSections(paths, 'cal', []);
    expect(s.files[0]).toMatchObject({ path: 'src/auth/callback.ts', name: 'callback.ts', dir: 'src/auth', hits: [0, 1, 2] });
  });

  it('caps the FILES section', () => {
    const many = Array.from({ length: 80 }, (_, i) => `f${i}.ts`);
    expect(quickOpenSections(many, '', [], 50).files).toHaveLength(50);
  });
});

describe('rankSymbols', () => {
  const r = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  const syms: FlatSymbol[] = [
    { name: 'handleCallback', kind: 11, container: 'Handler', selectionRange: r },
    { name: 'helper', kind: 11, container: '', selectionRange: r },
    { name: 'other', kind: 11, container: '', selectionRange: r },
  ];

  it('keeps document order on an empty query and fuzzy-filters otherwise', () => {
    expect(rankSymbols(syms, '').map((s) => s.symbol.name)).toEqual(['handleCallback', 'helper', 'other']);
    expect(rankSymbols(syms, 'hlp').map((s) => s.symbol.name)).toEqual(['helper']);
    expect(rankSymbols(syms, 'hc')[0]).toMatchObject({ symbol: { name: 'handleCallback' }, hits: [0, 6] });
  });
});
