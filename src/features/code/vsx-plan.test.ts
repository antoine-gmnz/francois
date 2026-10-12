// code-editor-vsx FR-10: what to (re)apply to Monaco after the contributions change.

import { describe, expect, it } from 'vitest';
import type { VsxContributions, VsxGrammar, VsxLanguage } from '../../../contract/code-editor-vsx';
import { diffApplied, hashOf, planContributions, signatures } from './vsx-plan';

const language = (extensionId: string, id: string, configuration: string | null = null): VsxLanguage => ({
  extensionId,
  id,
  aliases: [],
  extensions: [`.${id}`],
  filenames: [],
  filenamePatterns: [],
  firstLine: null,
  configuration,
});
const grammar = (extensionId: string, lang: string | null, scopeName: string): VsxGrammar => ({
  extensionId,
  language: lang,
  scopeName,
  content: '{}',
  format: 'json',
  embeddedLanguages: {},
  tokenTypes: {},
  injectTo: [],
});
const C = (more: Partial<VsxContributions>): VsxContributions => ({ languages: [], grammars: [], snippets: [], ...more });

describe('planContributions', () => {
  it('groups languages, configurations, the last grammar and snippets by language id', () => {
    const plans = planContributions(
      C({
        languages: [language('a', 'toml', '{"a":1}'), language('b', 'toml', '{"b":2}'), language('a', 'nix')],
        grammars: [grammar('a', 'toml', 'source.toml'), grammar('b', 'toml', 'source.toml.b'), grammar('c', null, 'inject.x')],
        snippets: [{ extensionId: 'b', language: 'toml', content: '{}' }, { extensionId: 'c', language: 'rust', content: '{}' }],
      }),
    );
    expect([...plans.keys()].sort()).toEqual(['nix', 'rust', 'toml']);
    const toml = plans.get('toml')!;
    expect(toml.language?.extensionId).toBe('b');
    expect(toml.configurations).toEqual(['{"a":1}', '{"b":2}']);
    expect(toml.grammar?.scopeName).toBe('source.toml.b');
    expect(toml.snippets).toEqual(['{}']);
    // a language only snippets target (a built-in) has no registration of its own
    expect(plans.get('rust')).toMatchObject({ language: null, grammar: null, configurations: [] });
  });
});

describe('signatures + diffApplied', () => {
  const base = C({ languages: [language('a', 'toml'), language('a', 'nix')], grammars: [grammar('a', 'toml', 'source.toml')] });

  it('re-applies only what changed', () => {
    const before = signatures(base);
    const after = signatures(C({ ...base, languages: [language('a', 'toml'), language('a', 'nix', '{"x":1}')] }));
    expect(diffApplied(before, after)).toEqual({ dispose: ['nix'], apply: ['nix'] });
  });

  it('disposes a language that is gone and applies a new one', () => {
    const after = signatures(C({ languages: [language('a', 'toml'), language('z', 'zig')], grammars: base.grammars }));
    expect(diffApplied(signatures(base), after)).toEqual({ dispose: ['nix'], apply: ['zig'] });
  });

  it('re-applies every grammar-carrying language when any grammar changes (one shared registry)', () => {
    const after = signatures(C({ ...base, grammars: [...base.grammars, grammar('q', null, 'inject.todo')] }));
    expect(diffApplied(signatures(base), after)).toEqual({ dispose: ['toml'], apply: ['toml'] });
  });

  it('is empty when nothing changed', () => {
    expect(diffApplied(signatures(base), signatures(base))).toEqual({ dispose: [], apply: [] });
  });
});

describe('hashOf', () => {
  it('is stable and content-sensitive', () => {
    expect(hashOf({ a: [1, 'x'] })).toBe(hashOf({ a: [1, 'x'] }));
    expect(hashOf({ a: [1, 'x'] })).not.toBe(hashOf({ a: [1, 'y'] }));
  });
});
