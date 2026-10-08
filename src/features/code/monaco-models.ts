// code-editor FR-6 / §6: one Monaco model per tab (its own undo stack), kept OUTSIDE
// the store. A model is created lazily the first time its tab is shown, from the
// buffer's baseline, and registered with buffers.ts through the BufferModel seam.

import type * as Monaco from 'monaco-editor';
import { attachModel, getBuffer, type BufferModel } from './buffers';
import { minimalChange } from './editor-sync';
import { languageFor } from './language';

type MonacoApi = typeof Monaco;

const models = new Map<string, Monaco.editor.ITextModel>();

/**
 * The model for `key`, created on first use. `onDirty` fires on every content change
 * with whether the text now differs from the buffer's baseline.
 */
export function ensureModel(
  monaco: MonacoApi,
  key: string,
  path: string,
  onDirty: (dirty: boolean) => void,
): Monaco.editor.ITextModel | null {
  const existing = models.get(key);
  if (existing && !existing.isDisposed()) return existing;
  const buf = getBuffer(key);
  if (!buf) return null;
  const uri = monaco.Uri.from({ scheme: 'inmemory', path: `/${encodeURIComponent(key.slice(0, key.indexOf('::')))}/${path}` });
  monaco.editor.getModel(uri)?.dispose();
  const model = monaco.editor.createModel(buf.baseline, languageFor(path).id, uri);
  // The frontend speaks LF only (FR-8); without this, Enter on Windows inserts CRLF.
  model.setEOL(monaco.editor.EndOfLineSequence.LF);
  models.set(key, model);

  const adapter: BufferModel = {
    getText: () => model.getValue(),
    setText: (text, undoable) => {
      const change = minimalChange(model.getValue(), text);
      if (!change) return;
      const from = model.getPositionAt(change.from);
      const to = model.getPositionAt(change.to);
      const edit = { range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: change.insert };
      if (undoable) model.pushEditOperations([], [edit], () => null);
      else model.applyEdits([edit]);
    },
    dispose: () => {
      models.delete(key);
      model.dispose();
    },
  };
  attachModel(key, adapter);
  model.onDidChangeContent(() => {
    const b = getBuffer(key);
    if (b) onDirty(model.getValue() !== b.baseline);
  });
  return model;
}
