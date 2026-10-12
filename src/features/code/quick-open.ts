// code-editor-workspace FR-11: quick open — pure helpers. A query is a file search,
// `:N[:C]` (go to line in the active file) or `@query` (the active file's symbols).

import { fuzzyMatch } from './fuzzy';
import type { FlatSymbol } from './symbols';

export type QuickQuery =
  | { kind: 'files'; text: string }
  | { kind: 'line'; line: number | null; column: number | null }
  | { kind: 'symbol'; text: string };

const LINE = /^:(\d+)(?::(\d+))?$/;

export function parseQuickQuery(raw: string): QuickQuery {
  const q = raw.trim();
  if (q.startsWith('@')) return { kind: 'symbol', text: q.slice(1).trim() };
  if (q.startsWith(':')) {
    const m = LINE.exec(q);
    const line = m ? Number(m[1]) : 0;
    if (!m || line < 1) return { kind: 'line', line: null, column: null };
    const column = m[2] ? Number(m[2]) : 0;
    return { kind: 'line', line, column: column >= 1 ? column : null };
  }
  return { kind: 'files', text: q };
}

export interface FileRow {
  path: string;
  name: string;
  dir: string;
  /** Matched character indices into `name`. */
  hits: number[];
}

function row(path: string, indices: readonly number[]): FileRow {
  const cut = path.lastIndexOf('/');
  const base = cut + 1;
  return { path, name: path.slice(base), dir: cut < 0 ? '' : path.slice(0, cut), hits: indices.filter((i) => i >= base).map((i) => i - base) };
}

export interface QuickSections {
  recent: FileRow[];
  files: FileRow[];
}

/** RECENTLY OPENED (recent files that match, most recent first) then FILES (the rest, fuzzy-ranked). */
export function quickOpenSections(paths: readonly string[], text: string, recent: readonly string[], limit = 50): QuickSections {
  const present = new Set(paths);
  const recents = recent.filter((p) => present.has(p));
  const isRecent = new Set(recents);
  if (text === '') {
    return {
      recent: recents.map((p) => row(p, [])),
      files: paths
        .filter((p) => !isRecent.has(p))
        .slice(0, limit)
        .map((p) => row(p, [])),
    };
  }
  const recentRows: FileRow[] = [];
  for (const p of recents) {
    const hit = fuzzyMatch(text, p);
    if (hit) recentRows.push(row(p, hit.indices));
  }
  const ranked: Array<{ path: string; score: number; indices: number[] }> = [];
  for (const p of paths) {
    if (isRecent.has(p)) continue;
    const hit = fuzzyMatch(text, p);
    if (hit) ranked.push({ path: p, ...hit });
  }
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { recent: recentRows, files: ranked.slice(0, limit).map((r) => row(r.path, r.indices)) };
}

export interface RankedSymbol {
  symbol: FlatSymbol;
  /** Matched character indices into `symbol.name`. */
  hits: number[];
}

/** `@query`: document order on an empty query, fuzzy-ranked otherwise. */
export function rankSymbols(symbols: readonly FlatSymbol[], text: string, limit = 100): RankedSymbol[] {
  if (text === '') return symbols.slice(0, limit).map((symbol) => ({ symbol, hits: [] }));
  const out: Array<RankedSymbol & { score: number }> = [];
  for (const symbol of symbols) {
    const hit = fuzzyMatch(text, symbol.name);
    if (hit) out.push({ symbol, hits: hit.indices, score: hit.score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit).map(({ symbol, hits }) => ({ symbol, hits }));
}
