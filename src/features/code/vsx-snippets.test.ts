// code-editor-vsx FR-9: VS Code snippet files → Monaco snippet completion items.

import { describe, expect, it } from 'vitest';
import { parseSnippets, SNIPPET_INSERT_RULE, SNIPPET_KIND, snippetSuggestions } from './vsx-snippets';

describe('parseSnippets', () => {
  it('reads string / array prefixes and bodies, one definition per prefix', () => {
    const defs = parseSnippets(`{
      // a JSONC comment
      "For loop": { "prefix": ["for", "fori"], "body": ["for (\${1:i}) {", "\\t$0", "}"], "description": "A for loop" },
      "Log": { "prefix": "log", "body": "console.log($1)", },
    }`);
    expect(defs).toEqual([
      { prefix: 'for', name: 'For loop', body: 'for (${1:i}) {\n\t$0\n}', description: 'A for loop' },
      { prefix: 'fori', name: 'For loop', body: 'for (${1:i}) {\n\t$0\n}', description: 'A for loop' },
      { prefix: 'log', name: 'Log', body: 'console.log($1)', description: null },
    ]);
  });
  it('joins an array description and skips entries without a prefix or body', () => {
    const defs = parseSnippets('{ "A": { "prefix": "a", "body": "x", "description": ["one", "two"] }, "B": { "body": "y" }, "C": { "prefix": "c" }, "D": 3 }');
    expect(defs).toEqual([{ prefix: 'a', name: 'A', body: 'x', description: 'one\ntwo' }]);
  });
  it('returns nothing for malformed or non-object JSON', () => {
    expect(parseSnippets('{ nope')).toEqual([]);
    expect(parseSnippets('[1, 2]')).toEqual([]);
  });
});

describe('snippetSuggestions', () => {
  const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 };
  it('offers each definition as an InsertAsSnippet item of kind Snippet', () => {
    const items = snippetSuggestions([{ prefix: 'log', name: 'Log', body: 'console.log($1)', description: null }], range);
    expect(items).toEqual([
      {
        label: { label: 'log', description: 'Log' },
        kind: SNIPPET_KIND,
        insertText: 'console.log($1)',
        insertTextRules: SNIPPET_INSERT_RULE,
        detail: 'Log',
        documentation: { value: '```\nconsole.log($1)\n```' },
        range,
        sortText: 'log',
      },
    ]);
  });
  it('uses the description as the detail when there is one', () => {
    const [item] = snippetSuggestions([{ prefix: 'a', name: 'A', body: 'x', description: 'Does A' }], range);
    expect(item.detail).toBe('Does A');
  });
});
