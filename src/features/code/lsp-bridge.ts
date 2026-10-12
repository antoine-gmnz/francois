// code-editor-lsp FR-9…FR-13 — the hand-written bridge between Monaco and the core's
// language servers (no monaco-languageclient). Installed once from monaco-setup.ts.
//
//   · tracks every Code-tab model of an LSP language (a model whose buffer exists —
//     never a review/preview model) and keeps it in sync (FR-10, lsp-sync.ts);
//   · `request()` is the one door for providers (lsp-providers.ts): only for a model
//     whose root has a `ready` server, flushes the pending didChange first, and drops
//     a result whose model moved on since (spec §7);
//   · diagnostics → markers, owner `lsp` (FR-12); files without a model stay in the store;
//   · Monaco's built-in TS/JS features step aside while a TS server is ready for the
//     shown root (FR-11);
//   · results in files with no tab open them through codeStore (FR-13).

import type * as Monaco from 'monaco-editor';
import type { EditorRoot } from '../../../contract/code-editor';
import type { LspEvent, LspLanguage, LspRequestMethod, LspServerStatus } from '../../../contract/code-editor-lsp';
import { editorClose, editorOpen, lspCancel, lspNotify, lspRequest } from '../../lib/api';
import { bufferKey, getBuffer } from './buffers';
import { groupsOfRoot, onDidSave, useCodeStore } from './codeStore';
import { setLspDiagnosticsSink } from './codeEvents';
import { rootKey } from './editor-root';
import { languageFor } from './language';
import { fileUriFor, lspLanguageIdFor, lspLanguageOf, relPathOf, toMarkerData, type LspDiagnostic } from './lsp-convert';
import { DocSync, type SyncDoc } from './lsp-sync';
import { diagnosticTargets, lspKey, useLspStore } from './lspStore';
import { ensureModel } from './monaco-models';
import { modelUriPath, parseModelUriPath } from './problems';

type MonacoApi = typeof Monaco;
type Model = Monaco.editor.ITextModel;

export const LSP_MARKER_OWNER = 'lsp';
const PREVIEW_CAP = 30;
const PREVIEW_FETCH_CAP = 20;

interface Tracked {
  model: Model;
  rk: string;
  path: string;
  language: LspLanguage;
}

/** A tracked model whose server is ready — what every provider works from. */
export interface ReadyDoc {
  model: Model;
  rk: string;
  path: string;
  root: EditorRoot;
  language: LspLanguage;
  status: LspServerStatus;
  /** The document's `file://` uri. */
  uri: string;
}

let monacoApi: MonacoApi | null = null;
const tracked = new Map<string, Tracked>();
/** The raw LSP diagnostics last set on each model — code actions send them back as context. */
const rawDiagnostics = new Map<string, LspDiagnostic[]>();
const previews: Model[] = [];

const statusOf = (rk: string, language: LspLanguage) => useLspStore.getState().statusByKey[lspKey(rk, language)];

function readyOf(t: Tracked): ReadyDoc | null {
  const status = statusOf(t.rk, t.language);
  if (!status || status.state !== 'ready') return null;
  return { model: t.model, rk: t.rk, path: t.path, root: status.root, language: t.language, status, uri: fileUriFor(status.rootUri, t.path) };
}

/** The model's ready server, or null — providers answer nothing then. */
export function readyDoc(model: Model): ReadyDoc | null {
  const t = tracked.get(model.uri.toString());
  return t && !model.isDisposed() ? readyOf(t) : null;
}

const syncDoc = (d: ReadyDoc): SyncDoc => ({
  key: d.model.uri.toString(),
  root: d.root,
  language: d.language,
  server: `${d.status.rootUri}|${d.language}`,
  uri: d.uri,
  languageId: lspLanguageIdFor(d.path),
  text: () => d.model.getValue(),
  version: () => d.model.getVersionId(),
});

const sync = new DocSync((doc, method, params) => void lspNotify({ root: doc.root, language: doc.language, method, params }).catch(() => {}));

/** The pending raw diagnostics behind a model's `lsp` markers. */
export const diagnosticsOf = (model: Model): LspDiagnostic[] => rawDiagnostics.get(model.uri.toString()) ?? [];

/**
 * One LSP request for `doc` — `{ data }` (the raw result, possibly null), or null when it
 * failed, was cancelled, or the model changed while it was in flight (the result would
 * point at stale text; `anyVersion` waives that for resolves).
 */
export async function request(
  doc: ReadyDoc,
  method: LspRequestMethod,
  params: unknown,
  token?: Monaco.CancellationToken,
  opts?: { anyVersion?: boolean },
): Promise<{ data: unknown } | null> {
  const key = doc.model.uri.toString();
  sync.flush(key);
  const version = doc.model.getVersionId();
  const requestId = token ? crypto.randomUUID() : undefined;
  const sub = token?.onCancellationRequested(() => {
    if (requestId) void lspCancel({ root: doc.root, language: doc.language, requestId }).catch(() => {});
  });
  const res = await lspRequest({ root: doc.root, language: doc.language, method, params, requestId }).catch(() => null);
  sub?.dispose();
  if (!res || !res.ok || doc.model.isDisposed() || token?.isCancellationRequested) return null;
  if (!opts?.anyVersion && doc.model.getVersionId() !== version) return null;
  return { data: res.data };
}

/** Server `file://` uri → the Code-tab model uri of the same root (null outside it). */
export function modelUriMapper(doc: ReadyDoc): (fileUri: string) => Monaco.Uri | null {
  const m = monacoApi;
  return (fileUri) => {
    const path = relPathOf(doc.status.rootUri, fileUri);
    return m && path !== null ? m.Uri.from({ scheme: 'inmemory', path: modelUriPath(doc.rk, path) }) : null;
  };
}

// ---------- FR-12 markers ----------

function setLspMarkers(t: Tracked, diagnostics: LspDiagnostic[]): void {
  const m = monacoApi;
  const doc = readyOf(t);
  if (!m || t.model.isDisposed()) return;
  rawDiagnostics.set(t.model.uri.toString(), diagnostics);
  const toUri = doc ? modelUriMapper(doc) : () => null;
  m.editor.setModelMarkers(
    t.model,
    LSP_MARKER_OWNER,
    diagnostics.map((d) => toMarkerData(d, t.language, toUri)),
  );
}

function findTracked(rk: string, path: string): Tracked | undefined {
  for (const t of tracked.values()) if (t.rk === rk && t.path === path) return t;
  return undefined;
}

function onDiagnostics(e: Extract<LspEvent, { type: 'lsp.diagnostics' }>): void {
  for (const { rootKey: rk, path } of diagnosticTargets(useLspStore.getState(), e)) {
    const t = findTracked(rk, path);
    if (!t || t.language !== e.language) continue;
    setLspMarkers(t, e.diagnostics as LspDiagnostic[]);
    useLspStore.getState().dropOrphan(rk, path);
  }
}

// ---------- FR-10 model tracking ----------

function openIfReady(t: Tracked): void {
  const d = readyOf(t);
  if (d) sync.open(syncDoc(d));
}

function track(model: Model): void {
  if (model.uri.scheme !== 'inmemory') return;
  const parsed = parseModelUriPath(model.uri.path);
  if (!parsed || !getBuffer(bufferKey(parsed.rootKey, parsed.path))) return; // a preview, not a tab
  const language = lspLanguageOf(model.getLanguageId());
  if (!language) return;
  const key = model.uri.toString();
  const t: Tracked = { model, rk: parsed.rootKey, path: parsed.path, language };
  tracked.set(key, t);
  model.onDidChangeContent(() => sync.change(key));
  model.onWillDispose(() => {
    sync.close(key);
    tracked.delete(key);
    rawDiagnostics.delete(key);
  });
  openIfReady(t);
  // Diagnostics that arrived while the file had no model move onto it.
  const orphan = useLspStore.getState().orphansByRootKey[t.rk]?.[t.path];
  if (orphan && orphan.language === language) {
    setLspMarkers(t, orphan.diagnostics as LspDiagnostic[]);
    useLspStore.getState().dropOrphan(t.rk, t.path);
  }
}

/** A server came up (or back after a restart): re-open its documents. Went away: forget them. */
function onStatuses(next: Record<string, LspServerStatus>, prev: Record<string, LspServerStatus>): void {
  for (const [key, st] of Object.entries(next)) {
    const before = prev[key];
    if (before === st) continue;
    const wasReady = before?.state === 'ready';
    const isReady = st.state === 'ready';
    if (wasReady === isReady && before?.rootUri === st.rootUri) continue;
    for (const t of tracked.values()) {
      if (lspKey(t.rk, t.language) !== key) continue;
      sync.forget(t.model.uri.toString());
      if (isReady) openIfReady(t);
      else {
        rawDiagnostics.delete(t.model.uri.toString());
        if (!t.model.isDisposed()) monacoApi?.editor.setModelMarkers(t.model, LSP_MARKER_OWNER, []);
      }
    }
    // Previews only exist for server results; once Monaco's own TS is back they would
    // otherwise be validated (and listed in Problems) like open files.
    if (!isReady) for (const p of previews.splice(0)) if (!p.isDisposed()) p.dispose();
  }
}

// ---------- FR-11 built-in overlap ----------

type Defaults = typeof Monaco.typescript.typescriptDefaults;
const OFF: Monaco.typescript.ModeConfiguration = {
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: false,
  signatureHelp: false,
  onTypeFormattingEdits: false,
  codeActions: false,
  inlayHints: false,
};
let builtinsOff = false;
let saved: Array<[Defaults, Monaco.typescript.ModeConfiguration]> | null = null;

function syncBuiltins(): void {
  const m = monacoApi;
  if (!m) return;
  const root = useCodeStore.getState().root;
  const off = !!root && statusOf(rootKey(root), 'typescript')?.state === 'ready';
  if (off === builtinsOff) return;
  builtinsOff = off;
  const all: Defaults[] = [m.typescript.typescriptDefaults, m.typescript.javascriptDefaults];
  if (off) {
    saved = all.map((d) => [d, { ...d.modeConfiguration }]);
    for (const d of all) d.setModeConfiguration(OFF);
    // The built-in diagnostics' markers would otherwise linger until the next edit.
    for (const model of m.editor.getModels()) {
      m.editor.setModelMarkers(model, 'typescript', []);
      m.editor.setModelMarkers(model, 'javascript', []);
    }
  } else {
    for (const [d, conf] of saved ?? []) d.setModeConfiguration(conf);
    saved = null;
  }
}

// ---------- FR-13 models for results in other files ----------

/** The Code-tab model uri `uri` names in the shown root, or null. */
function codeTarget(uri: Monaco.Uri): { rk: string; path: string } | null {
  if (uri.scheme !== 'inmemory') return null;
  const parsed = parseModelUriPath(uri.path);
  const root = useCodeStore.getState().root;
  if (!parsed || !root || rootKey(root) !== parsed.rootKey) return null;
  return { rk: parsed.rootKey, path: parsed.path };
}

const dirtyCallback = (rk: string, path: string) => (dirty: boolean) => useCodeStore.getState().setDirty(rk, path, dirty);

/**
 * Read-only preview models so the peek widget (references, several definitions) can
 * show files that have no tab: read once and released (editor_open + editor_close).
 * A tab opened later replaces the preview (monaco-models.ts disposes it).
 */
export async function ensurePreviewModels(uris: readonly Monaco.Uri[]): Promise<void> {
  const m = monacoApi;
  const root = useCodeStore.getState().root;
  if (!m || !root) return;
  const seen = new Set<string>();
  const wanted: Array<{ uri: Monaco.Uri; rk: string; path: string }> = [];
  for (const uri of uris) {
    const key = uri.toString();
    if (seen.has(key) || m.editor.getModel(uri)) continue;
    seen.add(key);
    const target = codeTarget(uri);
    if (target) wanted.push({ uri, ...target });
    if (wanted.length >= PREVIEW_FETCH_CAP) break;
  }
  await Promise.all(
    wanted.map(async ({ uri, rk, path }) => {
      const key = bufferKey(rk, path);
      if (getBuffer(key)) {
        ensureModel(m, key, path, dirtyCallback(rk, path));
        return;
      }
      const res = await editorOpen({ root, path }).catch(() => null);
      void editorClose({ root, path }).catch(() => {});
      if (!res?.ok || m.editor.getModel(uri) || getBuffer(key)) return;
      const model = m.editor.createModel(res.data.text, languageFor(path).id, uri);
      previews.push(model);
    }),
  );
  while (previews.length > PREVIEW_CAP) {
    const old = previews.shift();
    if (old && !old.isDisposed()) old.dispose();
  }
}

/**
 * Edits (rename, code actions) need a real, saveable model per file: a file with no tab
 * opens as one (dirty after the edit, like any other change), then the focused group
 * goes back to what it showed. Returns the uris that now have a Code-tab model.
 */
export async function ensureEditModels(uris: readonly Monaco.Uri[]): Promise<Set<string>> {
  const m = monacoApi;
  const ready = new Set<string>();
  if (!m) return ready;
  const store = useCodeStore.getState();
  const root = store.root;
  const rk = root ? rootKey(root) : '';
  const groups = groupsOfRoot(store, rk);
  const focused = groups.focused;
  const shown = groups.groups[focused]?.active ?? null;
  let opened = false;
  for (const uri of uris) {
    const target = codeTarget(uri);
    if (!target) continue;
    const key = bufferKey(target.rk, target.path);
    if (!getBuffer(key)) {
      const res = await useCodeStore.getState().openFile(target.path);
      if (!res.ok) continue;
      opened = true;
    }
    if (ensureModel(m, key, target.path, dirtyCallback(target.rk, target.path))) ready.add(uri.toString());
  }
  if (opened && shown) useCodeStore.getState().activate(shown, focused);
  return ready;
}

// ---------- install ----------

let installed = false;

export function installLspBridge(monaco: MonacoApi): void {
  if (installed) return;
  installed = true;
  monacoApi = monaco;

  for (const model of monaco.editor.getModels()) track(model);
  monaco.editor.onDidCreateModel(track);

  onDidSave((rk, path) => {
    const t = findTracked(rk, path);
    if (t) sync.save(t.model.uri.toString());
  });
  setLspDiagnosticsSink(onDiagnostics);

  useLspStore.subscribe((s, prev) => {
    if (s.statusByKey !== prev.statusByKey) {
      onStatuses(s.statusByKey, prev.statusByKey);
      syncBuiltins();
    }
  });
  useCodeStore.subscribe((s, prev) => {
    if (s.root !== prev.root) syncBuiltins();
  });
  syncBuiltins();

  // FR-13: a definition/reference/symbol in a file with no tab opens it, caret on the target.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const target = codeTarget(resource);
      if (!target) return false;
      const sel = selectionOrPosition;
      const range = !sel
        ? { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
        : 'startLineNumber' in sel
          ? { startLineNumber: sel.startLineNumber, startColumn: sel.startColumn, endLineNumber: sel.startLineNumber, endColumn: sel.startColumn }
          : { startLineNumber: sel.lineNumber, startColumn: sel.column, endLineNumber: sel.lineNumber, endColumn: sel.column };
      void useCodeStore.getState().revealRange(target.path, range);
      return true;
    },
  });
}
