// code-editor-lsp FR-10: document sync — didOpen / debounced full-text didChange
// flushed before requests / didSave / didClose, and the re-open after a restart.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LSP_CHANGE_DEBOUNCE_MS } from '../../../contract/code-editor-lsp';
import { PROJECT_ROOT, SESSION_ROOT } from './code.testutil';
import { DocSync, type SyncDoc } from './lsp-sync';

function doc(key: string, p: Partial<SyncDoc> = {}): SyncDoc & { set(text: string): void } {
  let text = 'a';
  let version = 1;
  return {
    key,
    root: PROJECT_ROOT,
    language: 'typescript',
    server: 'file:///w|typescript',
    uri: `file:///w/${key}.ts`,
    languageId: 'typescript',
    text: () => text,
    version: () => version,
    set(t: string) {
      text = t;
      version++;
    },
    ...p,
  };
}

let notify: ReturnType<typeof vi.fn>;
let sync: DocSync;
const calls = () => notify.mock.calls.map((c) => [c[1], c[2]]);

beforeEach(() => {
  vi.useFakeTimers();
  notify = vi.fn();
  sync = new DocSync((d, method, params) => notify(d, method, params));
});
afterEach(() => vi.useRealTimers());

describe('DocSync', () => {
  it('opens a document once with its language, version and full text', () => {
    const a = doc('a');
    expect(sync.open(a)).toBe(true);
    expect(sync.open(a)).toBe(false);
    expect(calls()).toEqual([['textDocument/didOpen', { textDocument: { uri: 'file:///w/a.ts', languageId: 'typescript', version: 1, text: 'a' } }]]);
    expect(notify.mock.calls[0][0]).toBe(a);
    expect(sync.isOpen('a')).toBe(true);
  });

  it('never opens one file twice on one server (two roots on one directory)', () => {
    sync.open(doc('a'));
    expect(sync.open(doc('a-session', { root: SESSION_ROOT, uri: 'file:///w/a.ts' }))).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('debounces didChange into one full-text change', () => {
    const a = doc('a');
    sync.open(a);
    a.set('ab');
    sync.change('a');
    a.set('abc');
    sync.change('a');
    vi.advanceTimersByTime(LSP_CHANGE_DEBOUNCE_MS - 1);
    expect(notify).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(calls()[1]).toEqual(['textDocument/didChange', { textDocument: { uri: 'file:///w/a.ts', version: 3 }, contentChanges: [{ text: 'abc' }] }]);
  });

  it('flushes a pending change before a request, and only once', () => {
    const a = doc('a');
    sync.open(a);
    a.set('ab');
    sync.change('a');
    sync.flush('a');
    sync.flush('a');
    vi.advanceTimersByTime(LSP_CHANGE_DEBOUNCE_MS * 2);
    expect(calls().map((c) => c[0])).toEqual(['textDocument/didOpen', 'textDocument/didChange']);
  });

  it('ignores changes of documents that are not open', () => {
    sync.change('nope');
    sync.flush('nope');
    sync.save('nope');
    sync.close('nope');
    vi.runAllTimers();
    expect(notify).not.toHaveBeenCalled();
  });

  it('didSave flushes first; didClose drops the pending change', () => {
    const a = doc('a');
    sync.open(a);
    a.set('ab');
    sync.change('a');
    sync.save('a');
    a.set('abc');
    sync.change('a');
    sync.close('a');
    vi.runAllTimers();
    expect(calls().map((c) => c[0])).toEqual(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didSave', 'textDocument/didClose']);
    expect(calls()[2][1]).toEqual({ textDocument: { uri: 'file:///w/a.ts' } });
    expect(calls()[3][1]).toEqual({ textDocument: { uri: 'file:///w/a.ts' } });
    expect(sync.isOpen('a')).toBe(false);
  });

  it('forget drops a document silently (its server went away), so it can be re-opened', () => {
    const a = doc('a');
    sync.open(a);
    a.set('ab');
    sync.change('a');
    sync.forget('a');
    vi.runAllTimers();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(sync.open(a)).toBe(true);
    expect(calls()[1][1]).toMatchObject({ textDocument: { version: 2, text: 'ab' } });
  });
});
