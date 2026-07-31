// session-attachments — the React half: the staged list plus the three ingestion
// gestures (drop / paste / picker).
//
// Split in three, the way the rest of the codebase splits its hooks
// (useTimedError, useHydratedSubscription): the *decisions* are pure and live in
// ./attachments, the *effects* (every IPC call, every prompt edit) live in
// `createAttachmentsController` behind an `AttachmentsPort`, and the two
// subscriptions live in `subscribeDragDrop` (the OS drag-drop channel) and
// `subscribeDocumentPaste` (FR-14). All three are unit-tested
// (./useSessionAttachments.test.ts); the hook itself is state wiring only, which
// is all that is left untestable without a DOM renderer.
//
// State lives here rather than in a store because it is per-composer and must
// die with it: ConversationView is keyed by sessionId, so a session switch drops
// the staged list — exactly what FR-17's start-up sweep treats those records as
// (abandoned). Chips are recomputed from (input, staged) on every render (FR-12),
// so nothing here can disagree with the prompt.

import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { AttachFailure, Attachment } from '../../../contract/session-attachments';
import { attachmentRef } from '../../../contract/session-attachments';
import {
  sessionAttachClipboardImage,
  sessionAttachFile,
  sessionCommitAttachments,
  sessionPickAttachments,
  sessionReleaseAttachment,
} from '../../lib/api';
import { basename } from '../../lib/path';
import { useTimedError } from '../../lib/hooks/useTimedError';
import {
  addStaged,
  bytesToBase64,
  dropOverlayState,
  firstImageItem,
  imageChips,
  insertRefsAtCaret,
  refusalLine,
  removeFirstRef,
  removeStaged,
  type DropOverlayState,
} from './attachments';

const ERROR_MS = 4000;

/** Shown when a call never reaches the core at all (the transport itself rejected). */
export const ATTACH_FAILED_MESSAGE = 'Attaching failed unexpectedly.';
/** Shown when the clipboard hands us an image the browser then cannot read. */
export const CLIPBOARD_READ_FAILED_MESSAGE = "That image couldn't be read from the clipboard.";

// ---------- the port: everything the controller needs from React ----------

export interface AttachmentsPort {
  sessionId: string;
  /** The live prompt plus its selection — the textarea when mounted, the state mirror otherwise. */
  readInput(): { value: string; selStart: number; selEnd: number };
  /** Writes the prompt. `caret` is null when the edit must not move the caret (chip removal). */
  writeInput(text: string, caret: number | null): void;
  stageAdd(incoming: readonly Attachment[]): void;
  stageRemove(id: string): void;
  stagedCount(): number;
  showError(message: string): void;
}

// Structural clipboard types: React's ClipboardEvent satisfies them, and a test
// can build one without a DOM (vitest runs in the node environment here).
export interface ClipboardFileLike {
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface ClipboardItemLike {
  kind: string;
  type: string;
  getAsFile(): ClipboardFileLike | null;
}
export interface ClipboardEventLike {
  clipboardData: { items: ArrayLike<ClipboardItemLike> } | null;
  preventDefault(): void;
}

export interface AttachmentsController {
  /** FR-9: each path is ingested independently — one refusal never aborts the rest. */
  attachPaths(paths: readonly string[]): Promise<void>;
  /** FR-14: attaches when the clipboard carries an image; a text-only paste falls through. */
  onPaste(e: ClipboardEventLike): Promise<void>;
  /** The `+` button — the native multi-select dialog opens in the core. */
  onAttachClick(): Promise<void>;
  /** A chip's `×` (FR-13). */
  onRemoveAttachment(attachment: Attachment): Promise<void>;
  /** FR-15 — call with the text just sent, only on a SUCCESSFUL send. */
  commit(text: string): Promise<void>;
}

/**
 * Every effect this feature performs. Each method resolves — a transport-level
 * rejection is turned into a visible error rather than an unhandled rejection,
 * mirroring `delegate()` in ../palette/paletteCommands.ts.
 */
export function createAttachmentsController(port: AttachmentsPort): AttachmentsController {
  /** Runs `work`, converting a rejection (IPC down, webview gone) into one banner line. */
  const guarded = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch {
      port.showError(ATTACH_FAILED_MESSAGE);
    }
  };

  /** FR-11: append the refs at the caret and leave the caret past them. */
  const insertRefs = (refs: readonly string[]) => {
    if (refs.length === 0) return;
    const { value, selStart, selEnd } = port.readInput();
    const { text, caret } = insertRefsAtCaret(value, selStart, selEnd, refs);
    port.writeInput(text, caret);
  };

  /** The shared tail of a drop and a pick: stage + insert the successes, report the refusals. */
  const applyIngestion = (attached: readonly Attachment[], failed: readonly AttachFailure[]) => {
    if (attached.length > 0) {
      port.stageAdd(attached);
      insertRefs(attached.map(attachmentRef));
    }
    const line = refusalLine(failed);
    if (line) port.showError(line);
  };

  const attachPaths = (paths: readonly string[]) =>
    guarded(async () => {
      const attached: Attachment[] = [];
      const failed: AttachFailure[] = [];
      for (const path of paths) {
        const res = await sessionAttachFile(port.sessionId, path);
        if (res.ok) attached.push(res.data);
        else failed.push({ name: basename(path), error: res.error });
      }
      applyIngestion(attached, failed);
    });

  const onPaste = (e: ClipboardEventLike): Promise<void> => {
    const data = e.clipboardData;
    if (!data) return Promise.resolve();
    const item = firstImageItem(Array.from(data.items));
    if (!item) return Promise.resolve(); // text-only clipboard: the default paste is untouched
    const file = item.getAsFile();
    if (!file) return Promise.resolve();
    e.preventDefault(); // the image wins; suppress the default text paste
    return guarded(async () => {
      let dataBase64: string;
      try {
        dataBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      } catch {
        // The bytes never left the browser — name the clipboard, not the core.
        port.showError(CLIPBOARD_READ_FAILED_MESSAGE);
        return;
      }
      const res = await sessionAttachClipboardImage(port.sessionId, file.type || 'image/png', dataBase64);
      if (!res.ok) {
        applyIngestion([], [{ name: 'the pasted image', error: res.error }]);
        return;
      }
      applyIngestion([res.data], []);
    });
  };

  const onAttachClick = () =>
    guarded(async () => {
      const res = await sessionPickAttachments(port.sessionId);
      if (!res.ok) {
        port.showError(res.error.message);
        return;
      }
      // FR-9: successes and per-file refusals arrive together. A cancelled dialog
      // is ok:true with both arrays empty, so this is a no-op by construction.
      applyIngestion(res.data.attached, res.data.failed);
    });

  const onRemoveAttachment = (attachment: Attachment) => {
    const { value } = port.readInput();
    const next = removeFirstRef(value, attachmentRef(attachment));
    port.writeInput(next, null); // a removal must not yank the caret out of the user's text
    port.stageRemove(attachment.id);
    // `×` is unambiguous intent, so the copy is deleted at once — hand-editing is
    // ambiguous mid-typing and is reconciled at send instead (FR-15).
    return guarded(async () => {
      const res = await sessionReleaseAttachment(port.sessionId, attachment.id);
      if (!res.ok) port.showError(res.error.message);
    });
  };

  const commit = (text: string): Promise<void> => {
    if (port.stagedCount() === 0) return Promise.resolve();
    return guarded(async () => {
      const res = await sessionCommitAttachments(port.sessionId, text);
      if (!res.ok) {
        // The core never reconciled anything, so the staged list stays exactly as
        // it was: dropping the chips here would hide copies that are still on
        // disk and only the FR-17 restart sweep could recover.
        port.showError(res.error.message);
        return;
      }
      // Unstage what the core actually resolved (FR-15) rather than blanket-
      // clearing: `sent` is terminal, `released` had its copy deleted, and
      // anything it did not name is still live and still ours to show.
      for (const id of [...res.data.sent, ...res.data.released]) port.stageRemove(id);
    });
  };

  return { attachPaths, onPaste, onAttachClick, onRemoveAttachment, commit };
}

// ---------- drop (design §2) ----------
// Tauri intercepts OS file drags before the DOM sees them, so the drop target is
// the webview's own drag-drop channel, not dragover/drop handlers.

export interface DragDropHandlers {
  onEnter(paths: string[]): void;
  onOver(): void;
  onDrop(paths: string[]): void;
  onLeave(): void;
}

const NOOP = () => {};

/**
 * Subscribes to the webview's OS-level drag-drop channel. Never rejects: outside
 * Tauri (or once the webview is gone) it resolves to a no-op unlisten and the `+`
 * button keeps working.
 */
export function subscribeDragDrop(handlers: DragDropHandlers): Promise<() => void> {
  try {
    return getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'enter') handlers.onEnter(p.paths);
        else if (p.type === 'over') handlers.onOver();
        else if (p.type === 'drop') handlers.onDrop(p.paths);
        else handlers.onLeave();
      })
      .catch(() => NOOP);
  } catch {
    return Promise.resolve(NOOP);
  }
}

// ---------- paste (FR-14): listened for at the document, not the textarea ----------
// The composer textarea carries the native `disabled` attribute while the session
// is done/error, and a disabled control receives NO paste event — a listener bound
// to it would make paste the one gesture that dies with the session while drop
// (unconditional) and `+` (never disabled) keep staging. §7 gates *sending*, not
// *staging*, so all three gestures must stay live in every state.
//
// Ownership rule: a paste that landed on some OTHER editable element belongs to
// that element (the palette field, a modal input) and is left strictly alone.
// Anything else — body, a plain div, the composer textarea itself — is ours. The
// listener is scoped in time by the SESSION tab: MainPaneBody unmounts
// ConversationView when another tab is active.

export interface PasteTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/** A native ClipboardEvent, narrowed to what this feature reads. */
export type DocumentPasteEvent = ClipboardEventLike & { target?: PasteTargetLike | null };

/** `document`, narrowed — so the subscription can be driven by a fake in tests. */
export interface PasteHost {
  addEventListener(type: 'paste', listener: (e: DocumentPasteEvent) => void): void;
  removeEventListener(type: 'paste', listener: (e: DocumentPasteEvent) => void): void;
}

const EDITABLE_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

/** True when a document-level paste is the composer's to handle (see the note above). */
export function isDocumentPasteOurs(target: PasteTargetLike | null | undefined, composer: unknown): boolean {
  if (!target) return true;
  if (composer && target === composer) return true;
  if (target.isContentEditable) return false;
  return !EDITABLE_TAGS.includes((target.tagName ?? '').toUpperCase());
}

/** `document` when there is one (there is none under vitest's node environment). */
export function documentPasteHost(): PasteHost | null {
  return typeof document === 'undefined' ? null : (document as unknown as PasteHost);
}

/**
 * Installs the paste listener. `composer` is read per event so a remount of the
 * textarea never leaves a stale element behind. Returns the unsubscribe.
 */
export function subscribeDocumentPaste(
  handle: (e: ClipboardEventLike) => void,
  composer: () => unknown,
  host: PasteHost | null = documentPasteHost(),
): () => void {
  if (!host) return NOOP;
  const listener = (e: DocumentPasteEvent) => {
    if (!isDocumentPasteOurs(e.target, composer())) return;
    handle(e);
  };
  host.addEventListener('paste', listener);
  return () => host.removeEventListener('paste', listener);
}

// ---------- the hook ----------

export interface SessionAttachments {
  /** design §1: one chip per staged image whose ref is still in the prompt. */
  chips: Attachment[];
  /** design §2: hidden · active · rejecting. */
  overlay: DropOverlayState;
  /** §7: the refusal line, rendered in its own composer banner slot (never merged with the send error). */
  attachError: string | null;
  /** The `+` button — the native multi-select dialog opens in the core. */
  onAttachClick: () => void;
  /** A chip's `×` (FR-13). */
  onRemoveAttachment: (attachment: Attachment) => void;
  /** FR-15 — call with the text just sent, only on a SUCCESSFUL send. */
  commit: (text: string) => void;
}

export interface UseSessionAttachmentsOptions {
  sessionId: string;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLTextAreaElement>;
  /** The composer's own auto-grow, so an inserted ref resizes the textarea like typing does. */
  autoGrow?: (el: HTMLTextAreaElement) => void;
}

export function useSessionAttachments({
  sessionId,
  input,
  setInput,
  inputRef,
  autoGrow,
}: UseSessionAttachmentsOptions): SessionAttachments {
  const [staged, setStaged] = useState<Attachment[]>([]);
  const [drag, setDrag] = useState<{ dragging: boolean; paths: string[] }>({ dragging: false, paths: [] });
  const { error: attachError, setError, schedule } = useTimedError();

  // Handlers are installed once (the Tauri drag-drop listener) but must see the
  // live text and staged list — refs keep the effect off the render loop.
  const inputValueRef = useRef(input);
  inputValueRef.current = input;
  const stagedRef = useRef(staged);
  stagedRef.current = staged;

  const showError = (message: string) => {
    setError(message);
    schedule(() => setError(null), ERROR_MS);
  };

  const port: AttachmentsPort = {
    sessionId,
    readInput: () => {
      const el = inputRef.current;
      if (!el) {
        const value = inputValueRef.current;
        return { value, selStart: value.length, selEnd: value.length };
      }
      const value = el.value;
      return { value, selStart: el.selectionStart ?? value.length, selEnd: el.selectionEnd ?? value.length };
    },
    writeInput: (text, caret) => {
      setInput(text);
      inputValueRef.current = text;
      // The DOM value updates on the next render; restore focus + caret after it.
      requestAnimationFrame(() => {
        const node = inputRef.current;
        if (!node) return;
        if (caret !== null) {
          node.focus();
          node.setSelectionRange(caret, caret);
        }
        autoGrow?.(node);
      });
    },
    stageAdd: (incoming) => setStaged((s) => addStaged(s, incoming)),
    stageRemove: (id) => setStaged((s) => removeStaged(s, id)),
    stagedCount: () => stagedRef.current.length,
    showError,
  };

  // Rebuilt every render (it is a handful of closures), but read through a ref so
  // the drag-drop listener installed once per session never calls a stale one.
  const controller = createAttachmentsController(port);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  // Every controller method already resolves on failure; this is the one place a
  // promise leaves the hook, so it carries the final guard — no bare `void
  // promise` anywhere, mirroring `delegate()` in ../palette/paletteCommands.ts.
  const fireAndForget = (work: Promise<void>): void => {
    work.catch(() => showError(ATTACH_FAILED_MESSAGE));
  };

  // The listener lives with the SESSION tab: MainPaneBody unmounts
  // ConversationView when another tab is active, so a drop elsewhere never
  // reaches this session.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void subscribeDragDrop({
      onEnter: (paths) => setDrag({ dragging: true, paths }),
      onOver: () => setDrag((d) => (d.dragging ? d : { dragging: true, paths: [] })),
      onDrop: (paths) => {
        setDrag({ dragging: false, paths: [] });
        fireAndForget(controllerRef.current.attachPaths(paths));
      },
      onLeave: () => setDrag({ dragging: false, paths: [] }),
    })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch(() => {
        /* subscribeDragDrop never rejects; this only guards a throwing unlisten */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId]);

  // FR-14 — bound to the document, not the textarea, because a disabled textarea
  // fires no paste event (see the note above `isDocumentPasteOurs`). Mounted and
  // unmounted with the SESSION tab, exactly like the drag-drop listener.
  useEffect(
    () =>
      subscribeDocumentPaste(
        (e) => fireAndForget(controllerRef.current.onPaste(e)),
        () => inputRef.current,
      ),
    [sessionId],
  );

  return {
    chips: imageChips(input, staged),
    overlay: dropOverlayState(drag.dragging, drag.paths),
    attachError,
    onAttachClick: () => fireAndForget(controllerRef.current.onAttachClick()),
    onRemoveAttachment: (attachment) => fireAndForget(controllerRef.current.onRemoveAttachment(attachment)),
    commit: (text) => fireAndForget(controllerRef.current.commit(text)),
  };
}
