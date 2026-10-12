// code-editor-vsx FR-8: lenient JSONC, language-configuration conversion, file association.

import { describe, expect, it } from 'vitest';
import type { VsxLanguage } from '../../../contract/code-editor-vsx';
import { compileRegex, matchContributedLanguage, mergeConfigurations, parseJsonc, toLanguageConfiguration } from './vsx-languages';

const lang = (id: string, more: Partial<VsxLanguage> = {}): VsxLanguage => ({
  extensionId: 'pub.ext',
  id,
  aliases: [],
  extensions: [],
  filenames: [],
  filenamePatterns: [],
  firstLine: null,
  configuration: null,
  ...more,
});

describe('parseJsonc', () => {
  it('strips line and block comments outside strings', () => {
    const text = `{
      // a comment
      "a": "http://x.y/*not a comment*/", /* block
      comment */ "b": 1
    }`;
    expect(parseJsonc(text)).toEqual({ a: 'http://x.y/*not a comment*/', b: 1 });
  });
  it('drops trailing commas and a BOM, keeps escaped quotes', () => {
    expect(parseJsonc('﻿{ "a": [1, 2,], "b": "say \\"hi\\", ok", }')).toEqual({ a: [1, 2], b: 'say "hi", ok' });
  });
  it('keeps a comma-then-bracket that sits inside a string', () => {
    expect(parseJsonc('{ "a": ",]" }')).toEqual({ a: ',]' });
  });
  it('throws on text that is not JSON even after stripping', () => {
    expect(() => parseJsonc('{ a: 1 }')).toThrow();
  });
});

describe('compileRegex', () => {
  it('compiles a string or a { pattern, flags } object', () => {
    expect(compileRegex('^\\s*#region')?.test('  #region x')).toBe(true);
    expect(compileRegex({ pattern: 'ABC', flags: 'i' })?.test('abc')).toBe(true);
  });
  it('returns undefined for an invalid regex or a wrong shape', () => {
    expect(compileRegex('(unclosed')).toBeUndefined();
    expect(compileRegex(42)).toBeUndefined();
    expect(compileRegex({ pattern: 'a', flags: 'zz' })).toBeUndefined();
  });
});

describe('toLanguageConfiguration', () => {
  it('passes comments, brackets and pairs through, normalising pair shapes', () => {
    const conf = toLanguageConfiguration({
      comments: { lineComment: '#', blockComment: ['/*', '*/'] },
      brackets: [['{', '}'], ['[', ']'], ['bad']],
      autoClosingPairs: [['{', '}'], { open: '"', close: '"', notIn: ['string'] }],
      surroundingPairs: [['(', ')'], { open: "'", close: "'" }],
      colorizedBracketPairs: [['(', ')']],
    });
    expect(conf.comments).toEqual({ lineComment: '#', blockComment: ['/*', '*/'] });
    expect(conf.brackets).toEqual([['{', '}'], ['[', ']']]);
    expect(conf.autoClosingPairs).toEqual([{ open: '{', close: '}' }, { open: '"', close: '"', notIn: ['string'] }]);
    expect(conf.surroundingPairs).toEqual([{ open: '(', close: ')' }, { open: "'", close: "'" }]);
    expect(conf.colorizedBracketPairs).toEqual([['(', ')']]);
  });
  it('accepts the object form of lineComment', () => {
    expect(toLanguageConfiguration({ comments: { lineComment: { comment: '//', noIndent: true } } }).comments).toEqual({ lineComment: '//' });
  });
  it('compiles folding markers, wordPattern and indentation rules', () => {
    const conf = toLanguageConfiguration({
      folding: { offSide: true, markers: { start: '^\\s*#region', end: '^\\s*#endregion' } },
      wordPattern: '[\\w-]+',
      indentationRules: { increaseIndentPattern: '\\{$', decreaseIndentPattern: { pattern: '^\\}' }, indentNextLinePattern: '(' },
    });
    expect(conf.folding?.offSide).toBe(true);
    expect(conf.folding?.markers?.start.test('#region')).toBe(true);
    expect(conf.wordPattern?.source).toBe('[\\w-]+');
    expect(conf.indentationRules?.increaseIndentPattern.test('a {')).toBe(true);
    expect(conf.indentationRules?.decreaseIndentPattern.test('}')).toBe(true);
    // the invalid optional pattern is dropped, the rule set kept
    expect(conf.indentationRules?.indentNextLinePattern).toBeUndefined();
  });
  it('drops indentation rules missing a valid required pattern, and an invalid wordPattern', () => {
    const conf = toLanguageConfiguration({ indentationRules: { increaseIndentPattern: '(', decreaseIndentPattern: 'x' }, wordPattern: '[' });
    expect(conf.indentationRules).toBeUndefined();
    expect(conf.wordPattern).toBeUndefined();
  });
  it('converts onEnterRules, dropping rules with an invalid beforeText', () => {
    const conf = toLanguageConfiguration({
      onEnterRules: [
        { beforeText: '^\\s*//', action: { indent: 'none', appendText: '// ' } },
        { beforeText: '(', action: { indent: 'indent' } },
        { beforeText: { pattern: '\\{$' }, afterText: '^\\}', action: { indent: 'indentOutdent' } },
        { beforeText: 'x', previousLineText: '^y', action: { indent: 'outdent', removeText: 2 } },
      ],
    });
    expect(conf.onEnterRules).toHaveLength(3);
    expect(conf.onEnterRules?.[0].action).toEqual({ indentAction: 0, appendText: '// ' });
    expect(conf.onEnterRules?.[1].action.indentAction).toBe(2);
    expect(conf.onEnterRules?.[1].afterText?.test('}')).toBe(true);
    expect(conf.onEnterRules?.[2].action).toEqual({ indentAction: 3, removeText: 2 });
    expect(conf.onEnterRules?.[2].previousLineText?.test('y')).toBe(true);
  });
  it('returns an empty configuration for a non-object', () => {
    expect(toLanguageConfiguration(null)).toEqual({});
    expect(toLanguageConfiguration([1])).toEqual({});
  });
});

describe('mergeConfigurations (§7)', () => {
  it('merges left to right, the later wins per key', () => {
    expect(mergeConfigurations([{ brackets: [['(', ')']], comments: { lineComment: '#' } }, { comments: { lineComment: '//' } }])).toEqual({
      brackets: [['(', ')']],
      comments: { lineComment: '//' },
    });
  });
});

describe('matchContributedLanguage', () => {
  const langs = [
    lang('toml', { aliases: ['TOML'], extensions: ['.toml'] }),
    lang('dts', { extensions: ['.d.ts'] }),
    lang('justfile', { filenames: ['justfile', '.justfile'] }),
    lang('dockercompose', { filenamePatterns: ['docker-compose.*.yml', '**/compose/*.y{a,}ml'] }),
  ];
  it('matches by extension, case-insensitively, the longest extension winning', () => {
    expect(matchContributedLanguage('a/Cargo.TOML', langs)?.id).toBe('toml');
    expect(matchContributedLanguage('types/x.d.ts', langs)?.id).toBe('dts');
  });
  it('matches exact filenames and glob patterns, before extensions', () => {
    expect(matchContributedLanguage('sub/justfile', langs)?.id).toBe('justfile');
    expect(matchContributedLanguage('docker-compose.dev.yml', langs)?.id).toBe('dockercompose');
    expect(matchContributedLanguage('infra/compose/web.yaml', langs)?.id).toBe('dockercompose');
    expect(matchContributedLanguage('infra/web.yaml', langs)).toBeNull();
  });
  it('lets the later contribution win on a tie', () => {
    const both = [lang('toml-a', { extensions: ['.toml'] }), lang('toml-b', { extensions: ['.toml'] })];
    expect(matchContributedLanguage('x.toml', both)?.id).toBe('toml-b');
  });
  it('returns null when nothing matches', () => {
    expect(matchContributedLanguage('README', langs)).toBeNull();
  });
});
