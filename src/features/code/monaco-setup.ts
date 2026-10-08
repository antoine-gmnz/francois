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
import { buildGraphiteTheme } from './monaco-theme';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

export const GRAPHITE_THEME = 'francois-graphite';

/** (Re)generate the theme from the live CSS tokens and apply it (FR-7). */
export function applyGraphiteTheme(): void {
  const style = getComputedStyle(document.documentElement);
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  monaco.editor.defineTheme(GRAPHITE_THEME, buildGraphiteTheme((name) => style.getPropertyValue(name), theme));
  monaco.editor.setTheme(GRAPHITE_THEME);
}

export { monaco };
