// code-editor-workspace FR-5/FR-11: a model's document symbols from whatever provider
// Monaco's language features registered for it (TS/JS, JSON, CSS, HTML, and the
// language servers of code-editor-lsp) — the same outline Monaco's own "Go to symbol"
// reads. The first provider that answers wins: the LSP one answers only while its
// server is ready, so the built-in TS outline stays the fallback. The registry lives behind an internal
// service, imported lazily so it stays in the Monaco chunk. Any failure reads as
// "no symbols": the breadcrumb simply ends at the file name.

import type * as Monaco from 'monaco-editor';
import type { MonacoModule } from './monaco-loader';
import type { SymbolLike } from './symbols';

interface SymbolRegistry {
  ordered(model: Monaco.editor.ITextModel): Monaco.languages.DocumentSymbolProvider[];
  onDidChange: Monaco.IEvent<unknown>;
}

let registry: Promise<SymbolRegistry | null> | null = null;

function symbolRegistry(): Promise<SymbolRegistry | null> {
  if (!registry) {
    registry = Promise.all([
      import('monaco-editor/editor/standalone/browser/standaloneServices.js'),
      import('monaco-editor/editor/common/services/languageFeatures.js'),
    ])
      .then(([{ StandaloneServices }, { ILanguageFeaturesService }]) => {
        const svc = StandaloneServices.get<{ documentSymbolProvider?: SymbolRegistry }>(ILanguageFeaturesService);
        return svc.documentSymbolProvider ?? null;
      })
      .catch(() => null);
  }
  return registry;
}

/** The model's symbols — null when no provider is registered (yet) for its language, or none answered. */
export async function documentSymbols(m: MonacoModule, model: Monaco.editor.ITextModel): Promise<SymbolLike[] | null> {
  const reg = await symbolRegistry();
  if (!reg || model.isDisposed()) return null;
  const providers = reg.ordered(model);
  if (providers.length === 0) return null;
  const source = new m.monaco.CancellationTokenSource();
  try {
    for (const provider of providers) {
      const out = await Promise.resolve(provider.provideDocumentSymbols(model, source.token)).catch(() => null);
      if (out) return out;
    }
    return null;
  } finally {
    source.dispose();
  }
}

/** Fires when a language registers its provider (they arrive lazily, after the first model). */
export async function onSymbolProvidersChange(fn: () => void): Promise<Monaco.IDisposable | null> {
  const reg = await symbolRegistry();
  return reg ? reg.onDidChange(fn) : null;
}
