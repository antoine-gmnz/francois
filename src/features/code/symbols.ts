// code-editor-workspace FR-5 / FR-11: document symbols, structurally typed (the fields
// of `monaco.languages.DocumentSymbol` read here) so this stays pure.

export interface RangeLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface SymbolLike {
  name: string;
  kind: number;
  range: RangeLike;
  selectionRange: RangeLike;
  children?: SymbolLike[];
}

export interface Caret {
  line: number;
  column: number;
}

const before = (a: Caret, line: number, column: number) => a.line < line || (a.line === line && a.column < column);

function holds(r: RangeLike, at: Caret): boolean {
  return !before(at, r.startLineNumber, r.startColumn) && !before({ line: r.endLineNumber, column: r.endColumn }, at.line, at.column);
}

/** FR-5: the deepest symbol whose range holds the caret, or null. */
export function innermostSymbol(symbols: readonly SymbolLike[], at: Caret): SymbolLike | null {
  for (const s of symbols) {
    if (!holds(s.range, at)) continue;
    return innermostSymbol(s.children ?? [], at) ?? s;
  }
  return null;
}

export interface FlatSymbol {
  name: string;
  kind: number;
  /** The enclosing symbol's name, '' at the top level. */
  container: string;
  selectionRange: RangeLike;
}

/** FR-11 `@`: every symbol, depth-first. */
export function flattenSymbols(symbols: readonly SymbolLike[], container = ''): FlatSymbol[] {
  const out: FlatSymbol[] = [];
  for (const s of symbols) {
    out.push({ name: s.name, kind: s.kind, container, selectionRange: s.selectionRange });
    out.push(...flattenSymbols(s.children ?? [], s.name));
  }
  return out;
}
