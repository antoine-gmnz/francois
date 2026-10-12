// code-editor FR-7: Monaco, bundled locally from the npm `monaco-editor` package —
// never a CDN. This module is only ever reached through monaco-loader.ts's dynamic
// import, so Vite emits it (and Monaco) as its own lazily loaded chunk.
//
// The worker set is editor, ts, json, css and html. Vite's `?worker` emits each as a
// same-origin file, which the webview CSP's `worker-src 'self' blob:` (FR-16) allows.

import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices.js';
import { IStorageService } from 'monaco-editor/platform/storage/common/storage.js';
import { installLspBridge } from './lsp-bridge';
import { installLspProviders } from './lsp-providers';
import { buildGraphiteTheme } from './monaco-theme';
import { installProblemActions } from './problem-send';
import { installVsx } from './vsx-apply';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// code-editor-workspace FR-9: one "Send to <target> with this problem" provider for
// every language, routed to whichever mounted editor shows the model.
installProblemActions(monaco);

// code-editor-lsp FR-9…FR-13: the language-server bridge — model sync, markers, the
// built-in TS overlap, the editor opener — and its providers, once per language id.
installLspBridge(monaco);
installLspProviders(monaco);

// code-editor-vsx FR-7…FR-10: the enabled Open VSX extensions' languages, configuration,
// snippets and TextMate grammars — applied now and re-applied on every change.
installVsx(monaco);

// code-editor-workspace FR-6: the completion details pane opens by default. Monaco keeps
// that switch in its (in-memory, standalone) storage under `expandSuggestionDocs`; seed
// it once per run so ^Space still toggles it for the rest of the run.
try {
  StandaloneServices.get<{ store(key: string, value: boolean, scope: number, target: number): void }>(IStorageService).store('expandSuggestionDocs', true, 0, 0);
} catch {
  // an internal moved: the pane simply starts collapsed, as Monaco's default
}

export const GRAPHITE_THEME = 'francois-graphite';

/** (Re)generate the theme from the live CSS tokens and apply it (FR-7). */
export function applyGraphiteTheme(): void {
  const style = getComputedStyle(document.documentElement);
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  monaco.editor.defineTheme(GRAPHITE_THEME, buildGraphiteTheme((name) => style.getPropertyValue(name), theme));
  monaco.editor.setTheme(GRAPHITE_THEME);
}

export { monaco };
