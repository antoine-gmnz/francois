// code-editor-vsx FR-7: the TextMate registry over contributed grammars and the Monaco
// tokens-provider adapter, against the real vscode-textmate + oniguruma wasm.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as onig from 'vscode-oniguruma';
import * as vt from 'vscode-textmate';
import type { VsxGrammar } from '../../../contract/code-editor-vsx';
import { createGrammarRegistry, innermostScope, tokensProviderFor, type TextmateLib } from './textmate';

let lib: TextmateLib;

beforeAll(async () => {
  // The test runs in node (no server to fetch the `?url` asset from): read the wasm off disk.
  // A string-typed specifier, since the project carries no @types/node.
  const fsModule: string = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL): Uint8Array };
  const bytes = readFileSync(new URL('../../../node_modules/vscode-oniguruma/release/onig.wasm', import.meta.url));
  await onig.loadWASM(bytes.slice().buffer);
  lib = { vt, onig: { createOnigScanner: (p) => onig.createOnigScanner(p), createOnigString: (s) => onig.createOnigString(s) } };
});

const grammar = (scopeName: string, body: object, more: Partial<VsxGrammar> = {}): VsxGrammar => ({
  extensionId: 'pub.ext',
  language: null,
  scopeName,
  content: JSON.stringify({ scopeName, ...body }),
  format: 'json',
  embeddedLanguages: {},
  tokenTypes: {},
  injectTo: [],
  ...more,
});

const TOY = grammar(
  'source.toy',
  {
    patterns: [
      { name: 'comment.block.toy', begin: '/\\*', end: '\\*/' },
      { name: 'keyword.control.toy', match: '\\blet\\b' },
      { name: 'constant.numeric.toy', match: '\\d+' },
      { begin: '`', end: '`', name: 'meta.embedded.inner', patterns: [{ include: 'source.inner' }] },
    ],
  },
  { language: 'toy' },
);
const INNER = grammar('source.inner', { patterns: [{ name: 'string.inner', match: 'hi' }] });

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>scopeName</key><string>source.plisty</string>
  <key>patterns</key><array><dict><key>name</key><string>keyword.plisty</string><key>match</key><string>\\bfn\\b</string></dict></array>
</dict></plist>`;

const scopesOf = (p: ReturnType<typeof tokensProviderFor>, line: string, state = p.getInitialState()) => {
  const r = p.tokenize(line, state);
  return { tokens: r.tokens.map((t) => [t.startIndex, t.scopes]), endState: r.endState };
};

describe('innermostScope', () => {
  it('is the last scope, or empty', () => {
    expect(innermostScope(['source.toy', 'keyword.control.toy'])).toBe('keyword.control.toy');
    expect(innermostScope([])).toBe('');
  });
});

describe('createGrammarRegistry + tokensProviderFor (FR-7)', () => {
  it('tokenizes with the innermost scope and carries the rule stack across lines', async () => {
    const reg = createGrammarRegistry(lib, [TOY]);
    const g = await reg.load('toy');
    expect(g).not.toBeNull();
    const p = tokensProviderFor(g!.grammar, g!.initial);
    expect(scopesOf(p, 'let x 42').tokens).toEqual([
      [0, 'keyword.control.toy'],
      [3, 'source.toy'],
      [6, 'constant.numeric.toy'],
    ]);
    const first = scopesOf(p, 'a /* open');
    expect(first.tokens[first.tokens.length - 1]?.[1]).toBe('comment.block.toy');
    const second = scopesOf(p, 'still */ 7', first.endState);
    expect(second.tokens[0]).toEqual([0, 'comment.block.toy']);
    expect(second.tokens[second.tokens.length - 1]).toEqual([9, 'constant.numeric.toy']);
  });

  it('gives states that clone and compare by rule stack', async () => {
    const g = (await createGrammarRegistry(lib, [TOY]).load('toy'))!;
    const p = tokensProviderFor(g.grammar, g.initial);
    const a = p.tokenize('/* x', p.getInitialState()).endState;
    const b = p.tokenize('/* y', p.getInitialState()).endState;
    expect(a.equals(b)).toBe(true);
    expect(a.clone().equals(a)).toBe(true);
    expect(a.equals(p.getInitialState())).toBe(false);
  });

  it('resolves an embedded scope from another contributed grammar', async () => {
    const g = (await createGrammarRegistry(lib, [TOY, INNER]).load('toy'))!;
    const p = tokensProviderFor(g.grammar, g.initial);
    expect(scopesOf(p, '`hi`').tokens).toEqual([
      [0, 'meta.embedded.inner'],
      [1, 'string.inner'],
      [3, 'meta.embedded.inner'],
    ]);
  });

  it('applies an injection grammar that targets the scope', async () => {
    const todo = grammar('todo.injection', { injectionSelector: 'L:comment', patterns: [{ name: 'keyword.todo', match: 'TODO' }] }, { injectTo: ['source.toy'] });
    const g = (await createGrammarRegistry(lib, [TOY, todo]).load('toy'))!;
    const p = tokensProviderFor(g.grammar, g.initial);
    expect(scopesOf(p, '/* TODO */').tokens).toContainEqual([3, 'keyword.todo']);
  });

  it('reads a plist grammar', async () => {
    const g = (await createGrammarRegistry(lib, [{ ...grammar('source.plisty', {}), content: PLIST, format: 'plist', language: 'plisty' }]).load('plisty'))!;
    const p = tokensProviderFor(g.grammar, g.initial);
    expect(scopesOf(p, 'fn').tokens).toEqual([[0, 'keyword.plisty']]);
  });

  it('uses the last grammar contributed for a language (the most recent install)', async () => {
    const other = grammar('source.toy2', { patterns: [{ name: 'keyword.other', match: 'let' }] }, { language: 'toy' });
    const g = (await createGrammarRegistry(lib, [TOY, other]).load('toy'))!;
    expect(scopesOf(tokensProviderFor(g.grammar, g.initial), 'let').tokens).toEqual([[0, 'keyword.other']]);
  });

  it('returns null for a language without a grammar or a grammar that does not parse', async () => {
    const broken = { ...grammar('source.bad', {}), content: '{ nope', language: 'bad' };
    const reg = createGrammarRegistry(lib, [broken]);
    await expect(reg.load('none')).resolves.toBeNull();
    await expect(reg.load('bad')).resolves.toBeNull();
  });

  it('falls back to one plain token and reports once when a regex fails to compile (§7)', async () => {
    const bad = grammar('source.badre', { patterns: [{ name: 'keyword.x', match: '(?<' }] }, { language: 'badre' });
    const g = (await createGrammarRegistry(lib, [bad]).load('badre'))!;
    const onError = vi.fn();
    const p = tokensProviderFor(g.grammar, g.initial, onError);
    const state = p.getInitialState();
    const r = p.tokenize('anything', state);
    expect(r.tokens).toEqual([{ startIndex: 0, scopes: '' }]);
    expect(r.endState).toBe(state);
    p.tokenize('again', state);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
