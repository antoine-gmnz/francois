// code-editor-lsp FR-10: document sync for the Code tab's models. Full-text sync only
// (no ranges): didOpen with the model's version id, didChange debounced
// LSP_CHANGE_DEBOUNCE_MS and flushed before any request, didSave, didClose. Pure — the
// bridge feeds it model events and hands it the notify call.

import type { EditorRoot } from '../../../contract/code-editor';
import { LSP_CHANGE_DEBOUNCE_MS, type LspLanguage, type LspNotifyMethod } from '../../../contract/code-editor-lsp';

export interface SyncDoc {
  /** The model's uri string. */
  key: string;
  root: EditorRoot;
  language: LspLanguage;
  /** The server's identity (`rootUri|language`) — two roots on one directory share it. */
  server: string;
  /** The document's `file://` uri. */
  uri: string;
  languageId: string;
  text(): string;
  version(): number;
}

export type SyncNotify = (doc: SyncDoc, method: LspNotifyMethod, params: unknown) => void;

export class DocSync {
  private readonly docs = new Map<string, SyncDoc>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly notify: SyncNotify,
    private readonly debounceMs = LSP_CHANGE_DEBOUNCE_MS,
  ) {}

  isOpen(key: string): boolean {
    return this.docs.has(key);
  }

  /** didOpen — false when already open (or the same file is open on that server under another key). */
  open(doc: SyncDoc): boolean {
    if (this.docs.has(doc.key)) return false;
    for (const d of this.docs.values()) if (d.server === doc.server && d.uri === doc.uri) return false;
    this.docs.set(doc.key, doc);
    this.notify(doc, 'textDocument/didOpen', { textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version(), text: doc.text() } });
    return true;
  }

  change(key: string): void {
    if (!this.docs.has(key)) return;
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => this.flush(key), this.debounceMs),
    );
  }

  /** Send the pending didChange now (before a request on this document). */
  flush(key: string): void {
    const timer = this.timers.get(key);
    const doc = this.docs.get(key);
    if (timer === undefined || !doc) return;
    clearTimeout(timer);
    this.timers.delete(key);
    this.notify(doc, 'textDocument/didChange', { textDocument: { uri: doc.uri, version: doc.version() }, contentChanges: [{ text: doc.text() }] });
  }

  save(key: string): void {
    const doc = this.docs.get(key);
    if (!doc) return;
    this.flush(key);
    this.notify(doc, 'textDocument/didSave', { textDocument: { uri: doc.uri } });
  }

  close(key: string): void {
    const doc = this.docs.get(key);
    if (!doc) return;
    this.drop(key);
    this.notify(doc, 'textDocument/didClose', { textDocument: { uri: doc.uri } });
  }

  /** The server went away: forget the document without telling it, so the next ready re-opens it. */
  forget(key: string): void {
    this.drop(key);
  }

  private drop(key: string): void {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.docs.delete(key);
  }
}
