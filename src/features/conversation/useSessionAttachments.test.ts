// session-attachments — the effectful half of the composer hook.
//
// `useSessionAttachments` itself is React plumbing (no DOM renderer is wired in
// this project's vitest setup, see useHydratedSubscription.test.ts), so the hook
// is split the same way the rest of the codebase splits its hooks: every decision
// and every IPC call lives in `createAttachmentsController`, driven through a
// small port, and the OS drag-drop subscription lives in `subscribeDragDrop`.
// Both are exercised here — the hook body that remains is state wiring only.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../../contract/common';
import type { Attachment } from '../../../contract/session-attachments';

const api = vi.hoisted(() => ({
  sessionAttachFile: vi.fn(),
  sessionAttachClipboardImage: vi.fn(),
  sessionPickAttachments: vi.fn(),
  sessionReleaseAttachment: vi.fn(),
  sessionCommitAttachments: vi.fn(),
}));
vi.mock('../../lib/api', () => api);

const { getCurrentWebviewMock } = vi.hoisted(() => ({ getCurrentWebviewMock: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: getCurrentWebviewMock }));

import {
  ATTACH_FAILED_MESSAGE,
  CLIPBOARD_READ_FAILED_MESSAGE,
  createAttachmentsController,
  isDocumentPasteOurs,
  subscribeDocumentPaste,
  subscribeDragDrop,
  type AttachmentsPort,
  type ClipboardEventLike,
  type ClipboardItemLike,
  type DocumentPasteEvent,
  type DragDropHandlers,
  type PasteHost,
} from './useSessionAttachments';

// ---------- fixtures ----------

function attachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1',
    sessionId: 's1',
    kind: 'image',
    storedPath: 'C:\\repo\\.francois\\attachments\\a3f9c1e2\\shot.png',
    refPath: '.francois/attachments/a3f9c1e2/shot.png',
    name: 'shot.png',
    bytes: 2048,
    copied: true,
    state: 'staged',
    createdAt: 1,
    ...over,
  };
}

const err = (code: AppError['code'], message: string, detail?: unknown): AppError => ({ code, message, detail });

/** A recording port: real text buffer, so ref insertion/removal is asserted on the actual prompt. */
function makePort(initialText = '') {
  const rec = {
    text: initialText,
    caret: initialText.length as number | null,
    selStart: initialText.length,
    selEnd: initialText.length,
    staged: [] as Attachment[],
    added: [] as Attachment[][],
    removed: [] as string[],
    errors: [] as string[],
    writes: 0,
  };
  const port: AttachmentsPort = {
    sessionId: 's1',
    readInput: () => ({ value: rec.text, selStart: rec.selStart, selEnd: rec.selEnd }),
    writeInput: (text, caret) => {
      rec.text = text;
      rec.caret = caret;
      rec.selStart = caret ?? text.length;
      rec.selEnd = caret ?? text.length;
      rec.writes += 1;
    },
    stageAdd: (incoming) => {
      rec.added.push([...incoming]);
      rec.staged.push(...incoming);
    },
    stageRemove: (id) => {
      rec.removed.push(id);
      rec.staged = rec.staged.filter((a) => a.id !== id);
    },
    stagedCount: () => rec.staged.length,
    showError: (message) => rec.errors.push(message),
  };
  return { port, rec };
}

/** A clipboard event fake shaped like React's, with no DOM in sight. */
function clipboardEvent(items: ClipboardItemLike[]): ClipboardEventLike & { prevented: number } {
  const e = {
    prevented: 0,
    clipboardData: { items },
    preventDefault: () => {
      e.prevented += 1;
    },
  };
  return e;
}

function imageItem(bytes = new Uint8Array([1, 2, 3]), type = 'image/png'): ClipboardItemLike {
  return {
    kind: 'file',
    type,
    getAsFile: () => ({
      type,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }),
  };
}

const textItem: ClipboardItemLike = { kind: 'string', type: 'text/plain', getAsFile: () => null };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  getCurrentWebviewMock.mockReset();
});

// ---------- drop / picker ingestion (FR-9) ----------

describe('createAttachmentsController.attachPaths', () => {
  it('attaches each path independently and inserts the successes in drop order (FR-9, FR-11)', async () => {
    const a = attachment({ id: 'a1', refPath: 'a/one.png' });
    const b = attachment({ id: 'b1', refPath: 'a/two.pdf', kind: 'file' });
    api.sessionAttachFile
      .mockResolvedValueOnce({ ok: true, data: a })
      .mockResolvedValueOnce({ ok: true, data: b });
    const { port, rec } = makePort('look');

    await createAttachmentsController(port).attachPaths(['C:\\x\\one.png', 'C:\\x\\two.pdf']);

    expect(api.sessionAttachFile).toHaveBeenCalledTimes(2);
    expect(api.sessionAttachFile).toHaveBeenNthCalledWith(1, 's1', 'C:\\x\\one.png');
    expect(rec.text).toBe('look @a/one.png @a/two.pdf ');
    expect(rec.added).toEqual([[a, b]]);
    expect(rec.errors).toEqual([]);
  });

  it('one refusal never aborts the rest, and every refusal is reported in one line (FR-9)', async () => {
    const a = attachment({ id: 'a1', refPath: 'a/one.png' });
    api.sessionAttachFile
      .mockResolvedValueOnce({ ok: false, error: err('ATTACHMENT_IS_DIRECTORY', 'is a directory') })
      .mockResolvedValueOnce({ ok: true, data: a });
    const { port, rec } = makePort('');

    await createAttachmentsController(port).attachPaths(['C:\\x\\src', 'C:\\x\\one.png']);

    expect(rec.text).toBe('@a/one.png ');
    expect(rec.errors).toEqual(["Folders can't be attached — drop the files instead."]);
  });

  it('a transport rejection becomes a visible error, never an unhandled rejection', async () => {
    api.sessionAttachFile.mockRejectedValue(new Error('ipc down'));
    const { port, rec } = makePort('');

    await expect(createAttachmentsController(port).attachPaths(['C:\\x\\one.png'])).resolves.toBeUndefined();

    expect(rec.errors).toEqual([ATTACH_FAILED_MESSAGE]);
    expect(rec.added).toEqual([]);
  });
});

// ---------- paste (FR-14) ----------

describe('createAttachmentsController.onPaste', () => {
  it('a text-only clipboard falls through untouched — no preventDefault, no IPC (FR-14)', async () => {
    const { port, rec } = makePort('hello');
    const e = clipboardEvent([textItem]);

    await createAttachmentsController(port).onPaste(e);

    expect(e.prevented).toBe(0);
    expect(api.sessionAttachClipboardImage).not.toHaveBeenCalled();
    expect(rec.text).toBe('hello');
    expect(rec.errors).toEqual([]);
  });

  it('an image on the clipboard wins: the default paste is suppressed and the ref is inserted (FR-14, FR-11)', async () => {
    const a = attachment({ refPath: '.francois/attachments/a3f9c1e2/pasted-20260730-142530.png' });
    api.sessionAttachClipboardImage.mockResolvedValue({ ok: true, data: a });
    const { port, rec } = makePort('the header');
    const e = clipboardEvent([textItem, imageItem(new Uint8Array([104, 105]))]);

    await createAttachmentsController(port).onPaste(e);

    expect(e.prevented).toBe(1);
    expect(api.sessionAttachClipboardImage).toHaveBeenCalledWith('s1', 'image/png', 'aGk=');
    expect(rec.text).toBe('the header @.francois/attachments/a3f9c1e2/pasted-20260730-142530.png ');
    expect(rec.added).toEqual([[a]]);
  });

  it('a refused paste names the pasted image in the banner and stages nothing', async () => {
    api.sessionAttachClipboardImage.mockResolvedValue({
      ok: false,
      error: err('ATTACHMENT_TOO_LARGE', 'too large', { bytes: 24 * 1024 * 1024 }),
    });
    const { port, rec } = makePort('');

    await createAttachmentsController(port).onPaste(clipboardEvent([imageItem()]));

    expect(rec.errors).toEqual(['the pasted image is 24 MB — the limit is 10 MB.']);
    expect(rec.added).toEqual([]);
    expect(rec.text).toBe('');
  });

  it('an unreadable clipboard file reports the clipboard, not the core', async () => {
    const { port, rec } = makePort('');
    const broken: ClipboardItemLike = {
      kind: 'file',
      type: 'image/png',
      getAsFile: () => ({
        type: 'image/png',
        arrayBuffer: () => Promise.reject(new Error('gone')),
      }),
    };

    await createAttachmentsController(port).onPaste(clipboardEvent([broken]));

    expect(rec.errors).toEqual([CLIPBOARD_READ_FAILED_MESSAGE]);
    expect(api.sessionAttachClipboardImage).not.toHaveBeenCalled();
  });

  it('a transport rejection becomes a visible error', async () => {
    api.sessionAttachClipboardImage.mockRejectedValue(new Error('ipc down'));
    const { port, rec } = makePort('');

    await expect(createAttachmentsController(port).onPaste(clipboardEvent([imageItem()]))).resolves.toBeUndefined();

    expect(rec.errors).toEqual([ATTACH_FAILED_MESSAGE]);
  });
});

// ---------- picker (FR-9) ----------

describe('createAttachmentsController.onAttachClick', () => {
  it('inserts the attached refs AND reports what the pick refused (FR-9)', async () => {
    const a = attachment({ id: 'a1', refPath: 'a/one.png' });
    api.sessionPickAttachments.mockResolvedValue({
      ok: true,
      data: {
        attached: [a],
        failed: [
          { name: 'huge.psd', error: err('ATTACHMENT_TOO_LARGE', 'too large', { bytes: 24 * 1024 * 1024 }) },
        ],
      },
    });
    const { port, rec } = makePort('');

    await createAttachmentsController(port).onAttachClick();

    expect(api.sessionPickAttachments).toHaveBeenCalledWith('s1');
    expect(rec.text).toBe('@a/one.png ');
    expect(rec.added).toEqual([[a]]);
    expect(rec.errors).toEqual(['huge.psd is 24 MB — the limit is 10 MB.']);
  });

  it('a cancelled dialog is ok:true with both arrays empty and changes nothing (FR-9)', async () => {
    api.sessionPickAttachments.mockResolvedValue({ ok: true, data: { attached: [], failed: [] } });
    const { port, rec } = makePort('draft');

    await createAttachmentsController(port).onAttachClick();

    expect(rec.text).toBe('draft');
    expect(rec.writes).toBe(0);
    expect(rec.added).toEqual([]);
    expect(rec.errors).toEqual([]);
  });

  it('a call-level failure surfaces the core message', async () => {
    api.sessionPickAttachments.mockResolvedValue({ ok: false, error: err('SESSION_NOT_FOUND', 'no such session') });
    const { port, rec } = makePort('');

    await createAttachmentsController(port).onAttachClick();

    expect(rec.errors).toEqual(['no such session']);
  });

  it('a transport rejection becomes a visible error', async () => {
    api.sessionPickAttachments.mockRejectedValue(new Error('ipc down'));
    const { port, rec } = makePort('');

    await expect(createAttachmentsController(port).onAttachClick()).resolves.toBeUndefined();

    expect(rec.errors).toEqual([ATTACH_FAILED_MESSAGE]);
  });
});

// ---------- chip removal (FR-13) ----------

describe('createAttachmentsController.onRemoveAttachment', () => {
  it('removes the first ref from the prompt, unstages it, and releases the copy at once (FR-13)', async () => {
    api.sessionReleaseAttachment.mockResolvedValue({ ok: true, data: null });
    const a = attachment({ id: 'a1', refPath: 'a/one.png' });
    const { port, rec } = makePort('look @a/one.png here');
    rec.staged.push(a);

    await createAttachmentsController(port).onRemoveAttachment(a);

    expect(rec.text).toBe('look here');
    expect(rec.caret).toBeNull(); // removal leaves the caret alone — only insertion moves it
    expect(rec.removed).toEqual(['a1']);
    expect(api.sessionReleaseAttachment).toHaveBeenCalledWith('s1', 'a1');
  });

  it('a failed release surfaces the core message', async () => {
    api.sessionReleaseAttachment.mockResolvedValue({ ok: false, error: err('ATTACHMENT_NOT_FOUND', 'unknown id') });
    const a = attachment({ id: 'a1', refPath: 'a/one.png' });
    const { port, rec } = makePort('@a/one.png');

    await createAttachmentsController(port).onRemoveAttachment(a);

    expect(rec.errors).toEqual(['unknown id']);
  });

  it('a transport rejection becomes a visible error', async () => {
    api.sessionReleaseAttachment.mockRejectedValue(new Error('ipc down'));
    const a = attachment({ id: 'a1', refPath: 'a/one.png' });
    const { port, rec } = makePort('@a/one.png');

    await expect(createAttachmentsController(port).onRemoveAttachment(a)).resolves.toBeUndefined();

    expect(rec.errors).toEqual([ATTACH_FAILED_MESSAGE]);
    expect(rec.removed).toEqual(['a1']); // the local removal already happened
  });
});

// ---------- commit (FR-15) ----------

describe('createAttachmentsController.commit', () => {
  it('is a no-op when nothing is staged', async () => {
    const { port, rec } = makePort('plain text');

    await createAttachmentsController(port).commit('plain text');

    expect(api.sessionCommitAttachments).not.toHaveBeenCalled();
    expect(rec.removed).toEqual([]);
  });

  it('unstages exactly what the core reconciled — sent AND released (FR-15)', async () => {
    api.sessionCommitAttachments.mockResolvedValue({ ok: true, data: { sent: ['a1'], released: ['b1'] } });
    const { port, rec } = makePort('');
    rec.staged.push(attachment({ id: 'a1' }), attachment({ id: 'b1' }), attachment({ id: 'c1' }));

    await createAttachmentsController(port).commit('look @a/one.png');

    expect(api.sessionCommitAttachments).toHaveBeenCalledWith('s1', 'look @a/one.png');
    expect(rec.removed).toEqual(['a1', 'b1']);
    // c1 was never reconciled by the core, so it stays staged rather than
    // vanishing from the UI while its copy is still on disk.
    expect(rec.staged.map((a) => a.id)).toEqual(['c1']);
  });

  it('keeps the staged list when the core refuses — the reconciliation never happened', async () => {
    api.sessionCommitAttachments.mockResolvedValue({ ok: false, error: err('SESSION_NOT_FOUND', 'no such session') });
    const { port, rec } = makePort('');
    rec.staged.push(attachment({ id: 'a1' }));

    await createAttachmentsController(port).commit('sent');

    expect(rec.errors).toEqual(['no such session']);
    expect(rec.removed).toEqual([]);
    expect(rec.staged.map((a) => a.id)).toEqual(['a1']);
  });

  it('a transport rejection becomes a visible error and leaves the staged list intact', async () => {
    api.sessionCommitAttachments.mockRejectedValue(new Error('ipc down'));
    const { port, rec } = makePort('');
    rec.staged.push(attachment({ id: 'a1' }));

    await expect(createAttachmentsController(port).commit('sent')).resolves.toBeUndefined();

    expect(rec.errors).toEqual([ATTACH_FAILED_MESSAGE]);
    expect(rec.staged.map((a) => a.id)).toEqual(['a1']);
  });
});

// ---------- OS drag-drop wiring (design §2) ----------

describe('subscribeDragDrop', () => {
  function handlers() {
    const calls: string[] = [];
    const h: DragDropHandlers = {
      onEnter: (paths) => calls.push(`enter:${paths.join(',')}`),
      onOver: () => calls.push('over'),
      onDrop: (paths) => calls.push(`drop:${paths.join(',')}`),
      onLeave: () => calls.push('leave'),
    };
    return { h, calls };
  }

  it('routes every webview drag-drop payload to its handler and resolves the unlisten fn', async () => {
    let emit: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    getCurrentWebviewMock.mockReturnValue({
      onDragDropEvent: (cb: (event: { payload: unknown }) => void) => {
        emit = cb;
        return Promise.resolve(unlisten);
      },
    });
    const { h, calls } = handlers();

    const un = await subscribeDragDrop(h);
    emit?.({ payload: { type: 'enter', paths: ['a.png', 'b.png'] } });
    emit?.({ payload: { type: 'over' } });
    emit?.({ payload: { type: 'drop', paths: ['a.png'] } });
    emit?.({ payload: { type: 'leave' } });

    expect(calls).toEqual(['enter:a.png,b.png', 'over', 'drop:a.png', 'leave']);
    un();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('resolves a no-op outside Tauri instead of rejecting — the `+` button still works', async () => {
    getCurrentWebviewMock.mockImplementation(() => {
      throw new Error('not a tauri webview');
    });

    const un = await subscribeDragDrop(handlers().h);
    expect(() => un()).not.toThrow();
  });

  it('resolves a no-op when the subscription itself rejects', async () => {
    getCurrentWebviewMock.mockReturnValue({ onDragDropEvent: () => Promise.reject(new Error('gone')) });

    const un = await subscribeDragDrop(handlers().h);
    expect(() => un()).not.toThrow();
  });
});

// ---------- paste ownership: document-level, not textarea-level (FR-14) ----------
// The composer textarea carries the native `disabled` attribute while the session
// is done/error, and a disabled control fires no paste event — so a listener on it
// would make paste the one gesture that dies with the session while drop and `+`
// keep staging (§7 gates *sending*, not *staging*).

describe('isDocumentPasteOurs', () => {
  const composer = { tagName: 'TEXTAREA' }; // identity is what matters, not the tag

  it('claims a paste that landed nowhere in particular — body, a div, no target at all', () => {
    expect(isDocumentPasteOurs({ tagName: 'BODY' }, composer)).toBe(true);
    expect(isDocumentPasteOurs({ tagName: 'DIV' }, composer)).toBe(true);
    expect(isDocumentPasteOurs(null, composer)).toBe(true);
  });

  it('claims the composer textarea itself, so an enabled composer keeps the same path', () => {
    expect(isDocumentPasteOurs(composer, composer)).toBe(true);
  });

  it('leaves a paste that belongs to another editable element alone', () => {
    expect(isDocumentPasteOurs({ tagName: 'INPUT' }, composer)).toBe(false);
    expect(isDocumentPasteOurs({ tagName: 'TEXTAREA' }, composer)).toBe(false);
    expect(isDocumentPasteOurs({ tagName: 'SELECT' }, composer)).toBe(false);
    expect(isDocumentPasteOurs({ tagName: 'DIV', isContentEditable: true }, composer)).toBe(false);
  });

  it('still claims a stray paste when the composer is not mounted', () => {
    expect(isDocumentPasteOurs({ tagName: 'BODY' }, null)).toBe(true);
    expect(isDocumentPasteOurs({ tagName: 'INPUT' }, null)).toBe(false);
  });
});

describe('subscribeDocumentPaste', () => {
  function fakeHost() {
    const listeners: Array<(e: DocumentPasteEvent) => void> = [];
    const host: PasteHost = {
      addEventListener: (_type, listener) => {
        listeners.push(listener);
      },
      removeEventListener: (_type, listener) => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    const emit = (target: DocumentPasteEvent['target']) => {
      const e = { ...clipboardEvent([imageItem()]), target };
      for (const l of [...listeners]) l(e);
      return e;
    };
    return { host, listeners, emit };
  }

  it('routes a paste with no editable target to the handler — this is the disabled-textarea path', () => {
    const seen: ClipboardEventLike[] = [];
    const { host, emit } = fakeHost();
    const composerEl = { tagName: 'TEXTAREA' };

    subscribeDocumentPaste((e) => seen.push(e), () => composerEl, host);
    emit({ tagName: 'BODY' });

    expect(seen).toHaveLength(1);
  });

  it('routes a paste on the composer textarea itself', () => {
    const seen: ClipboardEventLike[] = [];
    const { host, emit } = fakeHost();
    const composerEl = { tagName: 'TEXTAREA' };

    subscribeDocumentPaste((e) => seen.push(e), () => composerEl, host);
    emit(composerEl);

    expect(seen).toHaveLength(1);
  });

  it('ignores a paste that belongs to another input — the palette field keeps its own paste', () => {
    const seen: ClipboardEventLike[] = [];
    const { host, emit } = fakeHost();

    subscribeDocumentPaste((e) => seen.push(e), () => ({ tagName: 'TEXTAREA' }), host);
    emit({ tagName: 'INPUT' });

    expect(seen).toEqual([]);
  });

  it('unsubscribes on teardown', () => {
    const seen: ClipboardEventLike[] = [];
    const { host, listeners, emit } = fakeHost();

    const un = subscribeDocumentPaste((e) => seen.push(e), () => null, host);
    expect(listeners).toHaveLength(1);
    un();
    emit({ tagName: 'BODY' });

    expect(listeners).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('is a no-op without a host (no DOM at all) instead of throwing', () => {
    const un = subscribeDocumentPaste(() => {}, () => null, null);
    expect(() => un()).not.toThrow();
  });
});
