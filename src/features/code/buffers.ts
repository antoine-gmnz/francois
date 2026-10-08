// The live text of every open file (code-editor §6: Monaco models are kept OUTSIDE
// the store). A module-level map keyed `rootKey::path`. The store holds only small
// records (code-tabs.ts) and asks this module for text.
//
// Truth order for a buffer's text: its attached model (created lazily the first time
// the tab is shown — see monaco-models.ts), else `baseline`, the text last loaded from
// or saved to disk (LF-normalised, no BOM). Dirty = text !== baseline.
//
// `BufferModel` is the seam: the Monaco side implements it over an ITextModel, tests
// use a plain object — so nothing here (or in the store) imports monaco-editor.

export interface BufferModel {
  getText(): string;
  /** Swap the text in, keeping the cursor and scroll; `undoable` pushes it on the undo stack. */
  setText(text: string, undoable: boolean): void;
  dispose(): void;
}

export interface EditorBuffer {
  baseline: string;
  model: BufferModel | null;
}

const buffers = new Map<string, EditorBuffer>();

export const bufferKey = (rootKey: string, path: string) => `${rootKey}::${path}`;

export function getBuffer(key: string): EditorBuffer | undefined {
  return buffers.get(key);
}

export function createBuffer(key: string, baseline: string): EditorBuffer {
  buffers.get(key)?.model?.dispose();
  const buf: EditorBuffer = { baseline, model: null };
  buffers.set(key, buf);
  return buf;
}

export function attachModel(key: string, model: BufferModel): void {
  const buf = buffers.get(key);
  if (buf) buf.model = model;
  else model.dispose();
}

/** The buffer's current text, or null when nothing is open under `key`. */
export function bufferText(key: string): string | null {
  const buf = buffers.get(key);
  if (!buf) return null;
  return buf.model ? buf.model.getText() : buf.baseline;
}

/** Replace the buffer's text (a reload); a buffer with no model yet just takes it as its baseline. */
export function replaceBufferText(key: string, text: string, undoable: boolean): void {
  const buf = buffers.get(key);
  if (!buf) return;
  if (buf.model) buf.model.setText(text, undoable);
}

export function dropBuffer(key: string): void {
  buffers.get(key)?.model?.dispose();
  buffers.delete(key);
}

export function dropRootBuffers(rootKey: string): void {
  for (const key of [...buffers.keys()]) if (key.startsWith(`${rootKey}::`)) dropBuffer(key);
}
