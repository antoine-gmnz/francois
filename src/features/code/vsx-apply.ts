// code-editor-vsx FR-7…FR-10: applies the enabled extensions' contributions to Monaco and
// keeps them applied. Installed once from monaco-setup.ts (inside Monaco's lazy chunk); it
// follows vsxStore's `contributions`, which the Code tab loads on mount and reloads after
// every install / uninstall / enable / disable. Per language (vsx-plan.ts diff):
// registration, merged language configuration, snippet completion, and a TextMate tokenizer
// — disposing one puts back what it replaced (Monarch, the built-in configuration). Open
// models then re-pick their language, so they re-tokenize.

import type * as Monaco from 'monaco-editor';
import { TokenizationRegistry } from 'monaco-editor/editor/common/languages.js';
import type { VsxContributions } from '../../../contract/code-editor-vsx';
import { languageFor } from './language';
import { parseModelUriPath } from './problems';
import { createGrammarRegistry, loadTextmate, tokensProviderFor, type GrammarRegistry } from './textmate';
import { mergeConfigurations, parseJsonc, toLanguageConfiguration } from './vsx-languages';
import { diffApplied, hashOf, planContributions, signatures, type LanguagePlan } from './vsx-plan';
import { parseSnippets, snippetProvider } from './vsx-snippets';
import { useVsxStore } from './vsxStore';

type MonacoApi = typeof Monaco;

interface Applied {
  sig: string;
  disposables: Monaco.IDisposable[];
  disposed: boolean;
}

const applied = new Map<string, Applied>();
let registry: GrammarRegistry | null = null;
let registrySig = '';
let generation = 0;

function dispose(entry: Applied): void {
  entry.disposed = true;
  for (const d of entry.disposables.splice(0)) d.dispose();
}

/** Adds a disposable to an entry — or disposes it at once when a newer apply already
 *  dropped the entry while a grammar was loading. */
function own(entry: Applied, d: Monaco.IDisposable): void {
  if (entry.disposed) d.dispose();
  else entry.disposables.push(d);
}

/** setTokensProvider, whose dispose restores the tokenizer it replaced. Monaco builds a
 *  built-in's Monarch tokenizer once from a factory; dropping ours would leave none. */
function setTokens(monaco: MonacoApi, id: string, provider: Monaco.languages.TokensProvider): Monaco.IDisposable {
  const previous = TokenizationRegistry.get(id);
  const d = monaco.languages.setTokensProvider(id, provider);
  return {
    dispose() {
      d.dispose();
      if (previous && !TokenizationRegistry.get(id)) TokenizationRegistry.register(id, previous);
    },
  };
}

function register(monaco: MonacoApi, p: LanguagePlan): void {
  if (!p.language || monaco.languages.getLanguages().some((l) => l.id === p.id)) return;
  const l = p.language;
  monaco.languages.register({
    id: l.id,
    aliases: l.aliases,
    extensions: l.extensions,
    filenames: l.filenames,
    filenamePatterns: l.filenamePatterns,
    ...(l.firstLine ? { firstLine: l.firstLine } : {}),
  });
}

function configure(monaco: MonacoApi, p: LanguagePlan, entry: Applied): void {
  const configs = p.configurations.flatMap((text) => {
    try {
      return [toLanguageConfiguration(parseJsonc(text))];
    } catch {
      return []; // malformed file: skipped, the others still apply
    }
  });
  if (configs.length > 0) own(entry, monaco.languages.setLanguageConfiguration(p.id, mergeConfigurations(configs)));
  const defs = p.snippets.flatMap(parseSnippets);
  if (defs.length > 0) own(entry, monaco.languages.registerCompletionItemProvider(p.id, snippetProvider(defs)));
}

async function tokenize(monaco: MonacoApi, c: VsxContributions, plans: LanguagePlan[], gen: number): Promise<void> {
  const { setWarning } = useVsxStore.getState();
  const warn = (p: LanguagePlan, what: string) => p.grammar && setWarning(p.grammar.extensionId, `The ${p.id} grammar ${what} — ${p.id} files show as plain text.`);
  let lib;
  try {
    lib = await loadTextmate();
  } catch {
    for (const p of plans) warn(p, 'could not load the TextMate engine');
    return;
  }
  if (gen !== generation) return;
  registry ??= createGrammarRegistry(lib, c.grammars);
  const reg = registry;
  for (const p of plans) {
    const entry = applied.get(p.id);
    const loaded = await reg.load(p.id);
    if (gen !== generation || !entry || entry.disposed) continue;
    if (!loaded) {
      warn(p, 'failed to load');
      continue;
    }
    const onError = () => warn(p, 'failed to compile');
    own(entry, setTokens(monaco, p.id, tokensProviderFor(loaded.grammar, loaded.initial, onError)));
  }
}

/** FR-10: open Code-tab models re-pick their language (a contributed one, or back to the built-in). */
function relanguageModels(monaco: MonacoApi): void {
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme !== 'inmemory' || model.isDisposed()) continue;
    const parsed = parseModelUriPath(model.uri.path);
    if (!parsed) continue;
    const want = languageFor(parsed.path).id;
    if (model.getLanguageId() !== want) monaco.editor.setModelLanguage(model, want);
  }
}

function apply(monaco: MonacoApi, c: VsxContributions): void {
  const gen = ++generation;
  const plans = planContributions(c);
  const next = signatures(c);
  const { dispose: drop, apply: add } = diffApplied(new Map([...applied].map(([id, a]) => [id, a.sig])), next);

  for (const id of drop) {
    const entry = applied.get(id);
    if (entry) dispose(entry);
    applied.delete(id);
    const grammar = plans.get(id)?.grammar;
    if (grammar) useVsxStore.getState().setWarning(grammar.extensionId, null);
  }
  const grammarsSig = hashOf(c.grammars);
  if (grammarsSig !== registrySig) {
    registry?.dispose();
    registry = null;
    registrySig = grammarsSig;
  }

  const withGrammar: LanguagePlan[] = [];
  for (const id of add) {
    const p = plans.get(id)!;
    const entry: Applied = { sig: next.get(id)!, disposables: [], disposed: false };
    applied.set(id, entry);
    register(monaco, p);
    configure(monaco, p, entry);
    if (p.grammar) withGrammar.push(p);
  }
  relanguageModels(monaco);
  if (withGrammar.length > 0) void tokenize(monaco, c, withGrammar, gen);
}

/** Once, from monaco-setup.ts: apply now and on every contributions change. */
export function installVsx(monaco: MonacoApi): void {
  let last: VsxContributions | null = null;
  const follow = (c: VsxContributions | null) => {
    if (!c || c === last) return;
    last = c;
    apply(monaco, c);
  };
  follow(useVsxStore.getState().contributions);
  useVsxStore.subscribe((s) => follow(s.contributions));
}
