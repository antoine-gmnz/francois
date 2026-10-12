// code-editor-workspace FR-5 / FR-11: document symbols — the caret's enclosing symbol
// and the flat list quick open's `@` filters.

import { describe, expect, it } from 'vitest';
import { flattenSymbols, innermostSymbol, type SymbolLike } from './symbols';

const range = (startLineNumber: number, endLineNumber: number, startColumn = 1, endColumn = 1) => ({
  startLineNumber,
  startColumn,
  endLineNumber,
  endColumn,
});
const sym = (name: string, r: ReturnType<typeof range>, children?: SymbolLike[]): SymbolLike => ({ name, kind: 11, range: r, selectionRange: r, children });

const tree: SymbolLike[] = [
  sym('imports', range(1, 2, 1, 30)),
  sym('Handler', range(4, 20, 1, 2), [sym('constructor', range(5, 7, 3, 4)), sym('handleCallback', range(9, 18, 3, 4), [sym('inner', range(12, 14, 5, 6))])]),
  sym('helper', range(22, 25, 1, 2)),
];

describe('innermostSymbol', () => {
  it('descends to the deepest symbol whose range holds the caret', () => {
    expect(innermostSymbol(tree, { line: 13, column: 8 })?.name).toBe('inner');
    expect(innermostSymbol(tree, { line: 10, column: 1 })?.name).toBe('handleCallback');
    expect(innermostSymbol(tree, { line: 8, column: 1 })?.name).toBe('Handler');
  });

  it('honours columns on the boundary lines', () => {
    expect(innermostSymbol(tree, { line: 9, column: 1 })?.name).toBe('Handler');
    expect(innermostSymbol(tree, { line: 18, column: 4 })?.name).toBe('handleCallback');
    expect(innermostSymbol(tree, { line: 18, column: 5 })?.name).toBe('Handler');
  });

  it('is null outside every symbol', () => {
    expect(innermostSymbol(tree, { line: 3, column: 1 })).toBeNull();
    expect(innermostSymbol([], { line: 1, column: 1 })).toBeNull();
  });
});

describe('flattenSymbols', () => {
  it('lists every symbol depth-first with its container', () => {
    expect(flattenSymbols(tree).map((s) => [s.name, s.container])).toEqual([
      ['imports', ''],
      ['Handler', ''],
      ['constructor', 'Handler'],
      ['handleCallback', 'Handler'],
      ['inner', 'handleCallback'],
      ['helper', ''],
    ]);
  });
});
