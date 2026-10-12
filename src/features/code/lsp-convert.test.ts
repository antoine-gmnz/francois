// code-editor-lsp FR-9/FR-12: the pure LSP ↔ Monaco converters.

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import {
  fileUriFor,
  lspLanguageIdFor,
  lspLanguageOf,
  relPathOf,
  toCodeActions,
  toCompletionItem,
  toCompletionList,
  toDocumentSymbols,
  toHighlights,
  toHover,
  toLocations,
  toLspPosition,
  toLspRange,
  toMarkdown,
  toMarkerData,
  toMonacoRange,
  toRenameLocation,
  toSignatureHelp,
  toTextEdits,
  toWorkspaceEdit,
  workspaceEditUris,
  type LspCompletionItem,
  type LspDiagnostic,
} from './lsp-convert';

const R = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });
const M = (sl: number, sc: number, el: number, ec: number) => ({ startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec });
const DEFAULT = M(3, 5, 3, 9);
const ROOT = 'file:///C:/work/orbit-api';
/** A fake Uri: tests only compare its string. */
const fakeUri = (s: string) => ({ toString: () => s, path: s }) as unknown as Monaco.Uri;
const toUri = (u: string) => (u.startsWith(ROOT) ? fakeUri(`inmemory:${u.slice(ROOT.length)}`) : null);

describe('positions and ranges', () => {
  it('maps 1-based Monaco positions onto 0-based LSP ones and back', () => {
    expect(toLspPosition({ lineNumber: 1, column: 1 })).toEqual({ line: 0, character: 0 });
    expect(toLspPosition({ lineNumber: 12, column: 7 })).toEqual({ line: 11, character: 6 });
    expect(toMonacoRange(R(2, 4, 2, 10))).toEqual(M(3, 5, 3, 11));
    expect(toLspRange(M(3, 5, 3, 11))).toEqual(R(2, 4, 2, 10));
  });
});

describe('file uris', () => {
  it('builds a file uri from the root uri and a relative path, encoding each segment', () => {
    expect(fileUriFor(ROOT, 'src/a b.ts')).toBe('file:///C:/work/orbit-api/src/a%20b.ts');
    expect(fileUriFor(`${ROOT}/`, 'x.ts')).toBe('file:///C:/work/orbit-api/x.ts');
  });

  it('reads the relative path back, tolerating encoded drive letters and case on Windows', () => {
    expect(relPathOf(ROOT, 'file:///C:/work/orbit-api/src/a%20b.ts')).toBe('src/a b.ts');
    expect(relPathOf(ROOT, 'file:///c%3A/work/orbit-api/src/index.ts')).toBe('src/index.ts');
    expect(relPathOf(ROOT, 'file:///c:/Work/Orbit-Api/src/Index.ts')).toBe('src/Index.ts');
  });

  it('refuses uris outside the root, the root itself and look-alike siblings', () => {
    expect(relPathOf(ROOT, 'file:///C:/work/other/a.ts')).toBeNull();
    expect(relPathOf(ROOT, 'file:///C:/work/orbit-api-2/a.ts')).toBeNull();
    expect(relPathOf(ROOT, ROOT)).toBeNull();
  });

  it('keeps case on WSL roots', () => {
    const wsl = 'file://wsl.localhost/Ubuntu/home/me/app';
    expect(relPathOf(wsl, 'file://wsl.localhost/Ubuntu/home/me/app/src/main.rs')).toBe('src/main.rs');
    expect(relPathOf(wsl, 'file://wsl.localhost/Ubuntu/home/me/App/src/main.rs')).toBeNull();
  });
});

describe('languages', () => {
  it('maps Monaco language ids onto the server languages', () => {
    expect(lspLanguageOf('typescript')).toBe('typescript');
    expect(lspLanguageOf('javascript')).toBe('typescript');
    expect(lspLanguageOf('rust')).toBe('rust');
    expect(lspLanguageOf('python')).toBe('python');
    expect(lspLanguageOf('go')).toBe('go');
    expect(lspLanguageOf('json')).toBeNull();
  });

  it('names the LSP languageId of a file (react variants included)', () => {
    expect(lspLanguageIdFor('src/a.ts')).toBe('typescript');
    expect(lspLanguageIdFor('src/a.tsx')).toBe('typescriptreact');
    expect(lspLanguageIdFor('src/a.mjs')).toBe('javascript');
    expect(lspLanguageIdFor('src/a.jsx')).toBe('javascriptreact');
    expect(lspLanguageIdFor('src/main.rs')).toBe('rust');
    expect(lspLanguageIdFor('x.py')).toBe('python');
  });
});

describe('markdown', () => {
  it('reads MarkupContent, MarkedString and arrays of them', () => {
    expect(toMarkdown({ kind: 'markdown', value: '**x**' })).toEqual([{ value: '**x**' }]);
    expect(toMarkdown({ kind: 'plaintext', value: 'a*b' })).toEqual([{ value: 'a\\*b' }]);
    expect(toMarkdown({ language: 'ts', value: 'const a: number' })).toEqual([{ value: '```ts\nconst a: number\n```' }]);
    expect(toMarkdown(['plain', { language: 'rust', value: 'fn x()' }])).toEqual([{ value: 'plain' }, { value: '```rust\nfn x()\n```' }]);
    expect(toMarkdown('')).toEqual([]);
    expect(toMarkdown(undefined)).toEqual([]);
  });
});

describe('completion', () => {
  it('maps the kind, falls back to the label and the word range', () => {
    const out = toCompletionItem({ label: 'map', kind: 2 }, DEFAULT);
    expect(out).toMatchObject({ label: 'map', kind: 0, insertText: 'map', range: DEFAULT });
    expect(out.insertTextRules).toBeUndefined();
    expect(toCompletionItem({ label: 'x' }, DEFAULT).kind).toBe(18);
    expect(toCompletionItem({ label: 'Foo', kind: 7 }, DEFAULT).kind).toBe(5);
    expect(toCompletionItem({ label: 'K', kind: 21 }, DEFAULT).kind).toBe(14);
    expect(toCompletionItem({ label: 's', kind: 15 }, DEFAULT).kind).toBe(28);
  });

  it('inserts snippets as snippets', () => {
    const out = toCompletionItem({ label: 'fn', insertText: 'fn ${1:name}() {}', insertTextFormat: 2 }, DEFAULT);
    expect(out.insertText).toBe('fn ${1:name}() {}');
    expect(out.insertTextRules).toBe(4);
  });

  it('takes the range from a textEdit or an InsertReplaceEdit', () => {
    expect(toCompletionItem({ label: 'a', textEdit: { range: R(0, 1, 0, 3), newText: 'abc' } }, DEFAULT)).toMatchObject({ insertText: 'abc', range: M(1, 2, 1, 4) });
    const ir = toCompletionItem({ label: 'a', textEdit: { newText: 'abc', insert: R(0, 1, 0, 2), replace: R(0, 1, 0, 5) } }, DEFAULT);
    expect(ir.range).toEqual({ insert: M(1, 2, 1, 3), replace: M(1, 2, 1, 6) });
  });

  it('carries details, docs, sort/filter text, preselect, commit characters, extra edits and deprecation', () => {
    const item: LspCompletionItem = {
      label: 'useState',
      labelDetails: { detail: '<S>()', description: 'react' },
      detail: 'function useState',
      documentation: { kind: 'markdown', value: 'Returns a stateful value.' },
      sortText: '0001',
      filterText: 'useState',
      preselect: true,
      commitCharacters: ['('],
      additionalTextEdits: [{ range: R(0, 0, 0, 0), newText: "import { useState } from 'react';\n" }],
      deprecated: true,
    };
    const out = toCompletionItem(item, DEFAULT);
    expect(out.label).toEqual({ label: 'useState', detail: '<S>()', description: 'react' });
    expect(out.detail).toBe('function useState');
    expect(out.documentation).toEqual({ value: 'Returns a stateful value.' });
    expect(out).toMatchObject({ sortText: '0001', filterText: 'useState', preselect: true, commitCharacters: ['('] });
    expect(out.additionalTextEdits).toEqual([{ range: M(1, 1, 1, 1), text: "import { useState } from 'react';\n" }]);
    expect(out.tags).toEqual([1]);
    expect(toCompletionItem({ label: 'p', documentation: 'plain doc' }, DEFAULT).documentation).toBe('plain doc');
    expect(toCompletionItem({ label: 'p', tags: [1] }, DEFAULT).tags).toEqual([1]);
  });

  it('reads arrays and lists, applying the list item defaults', () => {
    expect(toCompletionList([{ label: 'a' }], DEFAULT)).toMatchObject({ incomplete: false, suggestions: [{ label: 'a' }] });
    const list = toCompletionList(
      { isIncomplete: true, itemDefaults: { editRange: R(0, 0, 0, 2), insertTextFormat: 2, commitCharacters: ['.'], data: { k: 1 } }, items: [{ label: 'b', textEditText: 'b$0' }] },
      DEFAULT,
    );
    expect(list.incomplete).toBe(true);
    expect(list.suggestions[0]).toMatchObject({ insertText: 'b$0', range: M(1, 1, 1, 3), insertTextRules: 4, commitCharacters: ['.'] });
    expect(list.items[0].data).toEqual({ k: 1 });
    expect(toCompletionList(null, DEFAULT).suggestions).toEqual([]);
  });
});

describe('hover and signature help', () => {
  it('converts hover contents and range', () => {
    expect(toHover({ contents: { kind: 'markdown', value: 'x' }, range: R(0, 0, 0, 1) })).toEqual({ contents: [{ value: 'x' }], range: M(1, 1, 1, 2) });
    expect(toHover(null)).toBeNull();
    expect(toHover({ contents: [] })).toBeNull();
  });

  it('converts signatures, string and offset parameter labels, defaulting the actives to 0', () => {
    const out = toSignatureHelp({
      signatures: [
        {
          label: 'f(a: number, b: string)',
          documentation: { kind: 'markdown', value: 'doc' },
          parameters: [{ label: 'a: number' }, { label: [13, 22], documentation: 'second' }],
        },
      ],
      activeParameter: 1,
    });
    expect(out).toEqual({
      signatures: [
        {
          label: 'f(a: number, b: string)',
          documentation: { value: 'doc' },
          parameters: [{ label: 'a: number', documentation: undefined }, { label: [13, 22], documentation: 'second' }],
          activeParameter: undefined,
        },
      ],
      activeSignature: 0,
      activeParameter: 1,
    });
    expect(toSignatureHelp(null)).toBeNull();
    expect(toSignatureHelp({ signatures: [] })).toBeNull();
  });
});

describe('locations', () => {
  it('reads a Location, an array, and LocationLinks, dropping uris outside the root', () => {
    expect(toLocations({ uri: `${ROOT}/a.ts`, range: R(1, 0, 1, 4) }, toUri).map((l) => [String(l.uri), l.range])).toEqual([['inmemory:/a.ts', M(2, 1, 2, 5)]]);
    const out = toLocations(
      [
        { uri: `${ROOT}/a.ts`, range: R(0, 0, 0, 1) },
        { uri: 'file:///elsewhere/lib.d.ts', range: R(0, 0, 0, 1) },
      ],
      toUri,
    );
    expect(out).toHaveLength(1);
    const links = toLocations([{ originSelectionRange: R(0, 0, 0, 3), targetUri: `${ROOT}/b.ts`, targetRange: R(0, 0, 9, 1), targetSelectionRange: R(2, 4, 2, 8) }], toUri);
    expect(links[0]).toMatchObject({ originSelectionRange: M(1, 1, 1, 4), range: M(1, 1, 10, 2), targetSelectionRange: M(3, 5, 3, 9) });
    expect(String(links[0].uri)).toBe('inmemory:/b.ts');
    expect(toLocations(null, toUri)).toEqual([]);
  });
});

describe('document symbols', () => {
  it('converts hierarchical DocumentSymbols (LSP kinds are 1-based)', () => {
    const out = toDocumentSymbols([
      { name: 'Server', kind: 5, range: R(0, 0, 9, 1), selectionRange: R(0, 6, 0, 12), children: [{ name: 'listen', kind: 6, detail: '()', range: R(1, 2, 3, 3), selectionRange: R(1, 2, 1, 8) }] },
    ]);
    expect(out[0]).toMatchObject({ name: 'Server', kind: 4, detail: '', tags: [], range: M(1, 1, 10, 2), selectionRange: M(1, 7, 1, 13) });
    expect(out[0].children?.[0]).toMatchObject({ name: 'listen', kind: 5, detail: '()' });
  });

  it('nests flat SymbolInformation by range containment', () => {
    const out = toDocumentSymbols([
      { name: 'inner', kind: 12, location: { uri: 'x', range: R(2, 2, 2, 10) }, containerName: 'Outer' },
      { name: 'Outer', kind: 5, location: { uri: 'x', range: R(0, 0, 5, 1) } },
      { name: 'after', kind: 12, location: { uri: 'x', range: R(7, 0, 7, 5) } },
    ]);
    expect(out.map((s) => s.name)).toEqual(['Outer', 'after']);
    expect(out[0].children?.map((s) => s.name)).toEqual(['inner']);
    expect(out[0].children?.[0].containerName).toBe('Outer');
  });
});

describe('highlights and edits', () => {
  it('maps highlight kinds (LSP 1-based → Monaco 0-based), Text by default', () => {
    expect(toHighlights([{ range: R(0, 0, 0, 1), kind: 3 }, { range: R(1, 0, 1, 1) }])).toEqual([
      { range: M(1, 1, 1, 2), kind: 2 },
      { range: M(2, 1, 2, 2), kind: 0 },
    ]);
  });

  it('converts TextEdits', () => {
    expect(toTextEdits([{ range: R(0, 0, 0, 2), newText: 'x' }])).toEqual([{ range: M(1, 1, 1, 3), text: 'x' }]);
    expect(toTextEdits(null)).toEqual([]);
  });

  it('converts a WorkspaceEdit — documentChanges first, file operations skipped', () => {
    const we = {
      changes: { [`${ROOT}/ignored.ts`]: [{ range: R(0, 0, 0, 0), newText: 'no' }] },
      documentChanges: [
        { textDocument: { uri: `${ROOT}/a.ts`, version: 3 }, edits: [{ range: R(0, 0, 0, 1), newText: 'A' }] },
        { kind: 'create', uri: `${ROOT}/new.ts` },
        { textDocument: { uri: 'file:///elsewhere/x.ts', version: null }, edits: [{ range: R(0, 0, 0, 1), newText: 'Z' }] },
      ],
    };
    const out = toWorkspaceEdit(we, toUri);
    expect(out.edits.map((e) => [String(e.resource), e.textEdit, e.versionId])).toEqual([['inmemory:/a.ts', { range: M(1, 1, 1, 2), text: 'A' }, undefined]]);
    expect(workspaceEditUris(we)).toEqual([`${ROOT}/a.ts`, 'file:///elsewhere/x.ts']);
  });

  it('reads the plain `changes` map when there are no documentChanges', () => {
    const we = { changes: { [`${ROOT}/a.ts`]: [{ range: R(0, 0, 0, 1), newText: 'A' }, { range: R(1, 0, 1, 1), newText: 'B' }] } };
    expect(toWorkspaceEdit(we, toUri).edits).toHaveLength(2);
    expect(workspaceEditUris(we)).toEqual([`${ROOT}/a.ts`]);
    expect(toWorkspaceEdit(null, toUri).edits).toEqual([]);
  });
});

describe('code actions', () => {
  it('keeps edit-bearing and resolvable actions, skipping bare and command-only ones', () => {
    const actions = [
      { title: 'Organize imports', command: 'ts.organize', arguments: [] },
      { title: 'Run thing', command: { title: 'x', command: 'run' } },
      { title: "Add import 'x'", kind: 'quickfix', isPreferred: true, edit: { changes: { [`${ROOT}/a.ts`]: [{ range: R(0, 0, 0, 0), newText: 'import x;\n' }] } } },
      { title: 'Extract function', kind: 'refactor.extract', data: { id: 7 } },
      { title: 'Disabled', kind: 'refactor', disabled: { reason: 'Nothing selected' }, data: {} },
    ];
    const out = toCodeActions(actions, 'typescript', toUri);
    expect(out.map((a) => a.action.title)).toEqual(["Add import 'x'", 'Extract function', 'Disabled']);
    expect(out[0].action).toMatchObject({ kind: 'quickfix', isPreferred: true });
    expect(out[0].action.edit?.edits).toHaveLength(1);
    expect(out[1].action.edit).toBeUndefined();
    expect(out[1].lsp).toBe(actions[3]);
    expect(out[2].action.disabled).toBe('Nothing selected');
    expect(toCodeActions(null, 'typescript', toUri)).toEqual([]);
  });
});

describe('rename', () => {
  const word = () => ({ range: M(1, 1, 1, 4), text: 'foo' });
  it('reads a Range, a range + placeholder, and defaultBehavior', () => {
    expect(toRenameLocation(R(0, 0, 0, 3), word, (r) => (r.endColumn === 4 ? 'foo' : '?'))).toEqual({ range: M(1, 1, 1, 4), text: 'foo' });
    expect(toRenameLocation({ range: R(0, 0, 0, 3), placeholder: 'bar' }, word, () => '')).toEqual({ range: M(1, 1, 1, 4), text: 'bar' });
    expect(toRenameLocation({ defaultBehavior: true }, word, () => '')).toEqual(word());
  });

  it('rejects a null answer', () => {
    expect(toRenameLocation(null, word, () => '')).toMatchObject({ rejectReason: "This element can't be renamed." });
  });
});

describe('diagnostics', () => {
  const diag = (p: Partial<LspDiagnostic> = {}): LspDiagnostic => ({ range: R(4, 2, 4, 9), message: 'nope', ...p });

  it('maps severities (LSP Error 1 … Hint 4), defaulting to Error', () => {
    expect([1, 2, 3, 4, undefined].map((severity) => toMarkerData(diag({ severity }), 'rust', toUri).severity)).toEqual([8, 4, 2, 1, 8]);
  });

  it('labels TypeScript codes ts(…) and other servers by their own source', () => {
    expect(toMarkerData(diag({ code: 2345, source: 'typescript' }), 'typescript', toUri)).toMatchObject({ source: 'ts', code: '2345' });
    expect(toMarkerData(diag({ code: 'E0308', source: 'rustc' }), 'rust', toUri)).toMatchObject({ source: 'rustc', code: 'E0308' });
    expect(toMarkerData(diag(), 'rust', toUri).code).toBeUndefined();
  });

  it('converts the range, tags and related information inside the root', () => {
    const out = toMarkerData(
      diag({
        tags: [1],
        relatedInformation: [
          { location: { uri: `${ROOT}/b.ts`, range: R(0, 0, 0, 1) }, message: 'declared here' },
          { location: { uri: 'file:///elsewhere.ts', range: R(0, 0, 0, 1) }, message: 'dropped' },
        ],
      }),
      'typescript',
      toUri,
    );
    expect(out).toMatchObject({ message: 'nope', ...M(5, 3, 5, 10), tags: [1] });
    expect(out.relatedInformation).toHaveLength(1);
    expect(out.relatedInformation?.[0]).toMatchObject({ message: 'declared here', ...M(1, 1, 1, 2) });
  });
});
