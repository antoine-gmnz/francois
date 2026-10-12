// code-editor-vsx FR-7: TextMate tokenization for contributed grammars, in Monaco.
// `vscode-textmate` + `vscode-oniguruma` load lazily, the first time a contributed grammar
// is needed: both modules and the onig wasm (bundled locally through Vite's `?url`, never a
// CDN — the CSP's `'wasm-unsafe-eval'` lets it compile) stay out of every chunk until then.
//
// A registry resolves scopes across ALL contributed grammars, so `include: "source.x"`
// (embedded languages) and `injectTo` (injections) work between extensions. The Monaco
// adapter's state is the rule stack; a token's Monaco scope is its innermost TextMate scope,
// which the Graphite theme's TextMate rules (monaco-theme.ts) colour by dotted prefix.

import type * as Monaco from 'monaco-editor';
import type { IGrammar, IOnigLib, IRawGrammar, StateStack } from 'vscode-textmate';
import type { VsxGrammar } from '../../../contract/code-editor-vsx';
import { parseJsonc } from './vsx-languages';

type VtModule = typeof import('vscode-textmate');

export interface TextmateLib {
  vt: VtModule;
  onig: IOnigLib;
}

/** Per-line tokenization budget: a pathological grammar stops early instead of freezing typing. */
export const TOKENIZE_TIME_LIMIT_MS = 100;

/** A CommonJS/UMD module may arrive as its namespace or behind `default`, by bundler. */
function interop<T extends object>(mod: T | { default: T }, probe: string): T {
  return probe in mod ? (mod as T) : (mod as { default: T }).default;
}

let loading: Promise<TextmateLib> | null = null;

/** The TextMate engine, loaded once; a failed load is forgotten so a later reload retries. */
export function loadTextmate(): Promise<TextmateLib> {
  if (!loading) {
    loading = (async () => {
      const [vtMod, onigMod, wasm] = await Promise.all([
        import('vscode-textmate'),
        import('vscode-oniguruma'),
        import('vscode-oniguruma/release/onig.wasm?url'),
      ]);
      const vt = interop<VtModule>(vtMod, 'Registry');
      const onig = interop<typeof import('vscode-oniguruma')>(onigMod, 'loadWASM');
      const res = await fetch(wasm.default);
      await onig.loadWASM(await res.arrayBuffer());
      return { vt, onig: { createOnigScanner: (p: string[]) => onig.createOnigScanner(p), createOnigString: (s: string) => onig.createOnigString(s) } };
    })().catch((e: unknown) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

export interface LoadedGrammar {
  grammar: IGrammar;
  initial: StateStack;
}

export interface GrammarRegistry {
  /** The grammar for a language id, or null when none is contributed or it does not load. */
  load(language: string): Promise<LoadedGrammar | null>;
  dispose(): void;
}

function parse(vt: VtModule, g: VsxGrammar): IRawGrammar | null {
  try {
    return g.format === 'json' ? (parseJsonc(g.content) as IRawGrammar) : vt.parseRawGrammar(g.content, `${g.scopeName}.tmLanguage`);
  } catch {
    return null;
  }
}

/** A registry over `grammars`, ordered oldest install first: for a scope or a language the
 *  last grammar wins (§7, the most recent install). */
export function createGrammarRegistry(lib: TextmateLib, grammars: readonly VsxGrammar[]): GrammarRegistry {
  const byScope = new Map<string, VsxGrammar>();
  const injections = new Map<string, string[]>();
  for (const g of grammars) {
    byScope.set(g.scopeName, g);
    for (const target of g.injectTo) injections.set(target, [...(injections.get(target) ?? []), g.scopeName]);
  }
  const parsed = new Map<string, IRawGrammar | null>();
  const registry = new lib.vt.Registry({
    onigLib: Promise.resolve(lib.onig),
    loadGrammar: async (scope) => {
      const g = byScope.get(scope);
      if (!g) return null;
      if (!parsed.has(scope)) parsed.set(scope, parse(lib.vt, g));
      return parsed.get(scope) ?? null;
    },
    getInjections: (scope) => injections.get(scope),
  });
  // vscode-textmate numbers languages (never 0) for its embedded-language metadata.
  const languageIds = new Map<string, number>();
  const languageNumber = (id: string) => {
    if (!languageIds.has(id)) languageIds.set(id, languageIds.size + 1);
    return languageIds.get(id)!;
  };

  return {
    async load(language) {
      const g = [...grammars].reverse().find((x) => x.language === language);
      if (!g) return null;
      const embeddedLanguages = Object.fromEntries(Object.entries(g.embeddedLanguages).map(([scope, lang]) => [scope, languageNumber(lang)]));
      try {
        const grammar = await registry.loadGrammarWithConfiguration(g.scopeName, languageNumber(language), { embeddedLanguages });
        return grammar ? { grammar, initial: lib.vt.INITIAL } : null;
      } catch {
        return null;
      }
    },
    dispose: () => registry.dispose(),
  };
}

export const innermostScope = (scopes: readonly string[]): string => scopes[scopes.length - 1] ?? '';

class RuleStackState implements Monaco.languages.IState {
  constructor(readonly stack: StateStack) {}
  clone(): RuleStackState {
    return new RuleStackState(this.stack.clone());
  }
  equals(other: Monaco.languages.IState): boolean {
    return other instanceof RuleStackState && other.stack.equals(this.stack);
  }
}

/** Monaco's TokensProvider over a loaded grammar. A grammar that throws (an oniguruma regex
 *  that does not compile) yields plain text and reports through `onError`, once. */
export function tokensProviderFor(grammar: IGrammar, initial: StateStack, onError?: (e: unknown) => void, timeLimit = TOKENIZE_TIME_LIMIT_MS): Monaco.languages.TokensProvider {
  let failed = false;
  return {
    getInitialState: () => new RuleStackState(initial),
    tokenize(line, state) {
      const prev = state as RuleStackState;
      if (!failed) {
        try {
          const r = grammar.tokenizeLine(line, prev.stack, timeLimit);
          return {
            tokens: r.tokens.map((t) => ({ startIndex: t.startIndex, scopes: innermostScope(t.scopes) })),
            // Stopped early: the next line restarts from this line's state, as VS Code does.
            endState: r.stoppedEarly ? prev : new RuleStackState(r.ruleStack),
          };
        } catch (e) {
          failed = true;
          onError?.(e);
        }
      }
      return { tokens: [{ startIndex: 0, scopes: '' }], endState: prev };
    },
  };
}
