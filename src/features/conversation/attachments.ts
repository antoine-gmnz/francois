// session-attachments (specs/session-attachments.md) — the pure half.
//
// The textarea is the single source of truth for the outgoing prompt (FR-10), so
// every decision this feature makes is a string transform over that text plus the
// contract's `Attachment`: where a ref lands (FR-11), which chips exist (FR-12),
// what `×` removes (FR-13), and what a refusal reads like (§7). Keeping them here
// means the React side (useSessionAttachments / Composer) holds no logic that
// could drift from the prompt.

import type { ProjectId, SessionId } from '../../../contract/common';
import type { AttachFailure, Attachment, ClearAttachmentsResult } from '../../../contract/session-attachments';
import { ATTACHMENT_MAX_BYTES, attachmentRef } from '../../../contract/session-attachments';

// ---------- FR-11: inserting refs at the caret ----------

export interface InsertResult {
  text: string;
  /** Where to put the caret afterwards — just past the trailing space. */
  caret: number;
}

/**
 * Inserts `refs` (already '@'-prefixed) at the caret / over the selection,
 * separated from the surrounding text by exactly one space on each side when one
 * is not already present. A trailing space is always left behind so the user can
 * keep typing straight after a paste without gluing prose onto the path.
 */
export function insertRefsAtCaret(text: string, selStart: number, selEnd: number, refs: readonly string[]): InsertResult {
  const start = Math.max(0, Math.min(selStart, text.length));
  const end = Math.max(start, Math.min(selEnd, text.length));
  if (refs.length === 0) return { text, caret: end };

  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const body = refs.join(' ');
  // Always end on a single space: either the one we add, or the one already there.
  const followedBySpace = /^\s/.test(after);
  const trail = followedBySpace ? '' : ' ';
  const head = before + lead + body + trail;
  // Land the caret PAST the separating space, whether we just added it or it was
  // already there — so typed prose never glues itself onto the path.
  return { text: head + after, caret: head.length + (followedBySpace ? 1 : 0) };
}

// ---------- FR-12/FR-13: locating a ref inside the prompt ----------

/** A ref must stand alone: path-ish characters on either side mean it is a different token. */
const PATH_CHAR = /[A-Za-z0-9._\-/\\]/;

function refIndex(text: string, ref: string): number {
  let from = 0;
  for (;;) {
    const i = text.indexOf(ref, from);
    if (i === -1) return -1;
    const prev = i > 0 ? text[i - 1] : '';
    const next = text[i + ref.length] ?? '';
    if (!(prev && PATH_CHAR.test(prev)) && !(next && PATH_CHAR.test(next))) return i;
    from = i + 1;
  }
}

/** FR-12: does the current prompt still carry this ref? */
export function containsRef(text: string, ref: string): boolean {
  return refIndex(text, ref) !== -1;
}

/** FR-13: drop the FIRST occurrence of `ref`, plus the one space it introduced. */
export function removeFirstRef(text: string, ref: string): string {
  const i = refIndex(text, ref);
  if (i === -1) return text;
  let start = i;
  let end = i + ref.length;
  if (text[end] === ' ') end += 1;
  else if (start > 0 && text[start - 1] === ' ') start -= 1;
  const out = text.slice(0, start) + text.slice(end);
  return out.trim() === '' ? '' : out;
}

// ---------- FR-12: chips are derived, never stored ----------

/** One chip per staged IMAGE whose ref is still in the prompt. Files stay text-only (design §1). */
export function imageChips(text: string, staged: readonly Attachment[]): Attachment[] {
  return staged.filter((a) => a.kind === 'image' && containsRef(text, attachmentRef(a)));
}

// ---------- staged list bookkeeping ----------

/** Appends in arrival order; an id already staged is replaced in place. */
export function addStaged(staged: readonly Attachment[], incoming: readonly Attachment[]): Attachment[] {
  const out = staged.slice();
  for (const a of incoming) {
    const i = out.findIndex((x) => x.id === a.id);
    if (i === -1) out.push(a);
    else out[i] = a;
  }
  return out;
}

export function removeStaged(staged: readonly Attachment[], id: string): Attachment[] {
  return staged.filter((a) => a.id !== id);
}

// ---------- design §1: chip name ----------

/** Middle-truncates so the extension always survives; the result is exactly `max` chars. */
export function truncateMiddle(name: string, max: number): string {
  if (name.length <= max) return name;
  const keep = max - 1; // the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

// ---------- §7 / design §3: refusal copy ----------

/** Human size for composer + palette copy. MB past 1 MiB (one decimal under 10). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return mb < 10 ? `${Math.round(mb * 10) / 10} MB` : `${Math.round(mb)} MB`;
}

// `AttachFailure` is the contract's (contract/session-attachments.ts): the core
// builds one per refused pick and hands it across the boundary in
// `PickAttachmentsResponse.failed`, so it is never redefined feature-side.

function detailBytes(detail: unknown): number | undefined {
  if (detail && typeof detail === 'object' && 'bytes' in detail) {
    const b = (detail as { bytes: unknown }).bytes;
    if (typeof b === 'number' && Number.isFinite(b)) return b;
  }
  return undefined;
}

const CAP = formatFileSize(ATTACHMENT_MAX_BYTES);

/**
 * One `.send-error-banner` line for a batch of refusals (FR-9: the successes in
 * the same drop are unaffected). Null when nothing was refused.
 */
export function refusalLine(failures: readonly AttachFailure[]): string | null {
  if (failures.length === 0) return null;
  if (failures.length === 1) {
    const { name, error } = failures[0];
    if (error.code === 'ATTACHMENT_TOO_LARGE') {
      const bytes = detailBytes(error.detail);
      const size = bytes === undefined ? 'too large' : `${formatFileSize(bytes)}`;
      return bytes === undefined ? `${name} is too large — the limit is ${CAP}.` : `${name} is ${size} — the limit is ${CAP}.`;
    }
    if (error.code === 'ATTACHMENT_IS_DIRECTORY') return "Folders can't be attached — drop the files instead.";
    return error.message;
  }
  const tooLarge = failures.filter((f) => f.error.code === 'ATTACHMENT_TOO_LARGE').length;
  const folders = failures.filter((f) => f.error.code === 'ATTACHMENT_IS_DIRECTORY').length;
  const other = failures.length - tooLarge - folders;
  const parts: string[] = [];
  if (tooLarge > 0) parts.push(`${tooLarge} too large`);
  if (folders > 0) parts.push(`${folders} folder${folders === 1 ? '' : 's'}`);
  if (other > 0) parts.push(`${other} failed`);
  return `${failures.length} files skipped — ${parts.join(', ')}.`;
}

// ---------- §7: the composer's error slots ----------

/**
 * The banner lines the composer shows, top-first. The send path and the attach
 * path fail independently — a turn can be refused while a drop is being refused
 * too — so they get a slot each rather than sharing one (a single slot silently
 * swallowed whichever arrived second). Identical text collapses to one line: the
 * same transport outage reported twice reads as a bug, not as two problems.
 */
export function composerErrorBanners(sendError: string | null, attachError: string | null): string[] {
  const out: string[] = [];
  for (const line of [sendError, attachError]) {
    if (line && !out.includes(line)) out.push(line);
  }
  return out;
}

// ---------- FR-14: clipboard ----------

interface ClipboardLikeItem {
  kind: string;
  type: string;
}

/** The first image FILE entry on the clipboard, or null — a text-only paste must fall through. */
export function firstImageItem<T extends ClipboardLikeItem>(items: readonly T[]): T | null {
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item;
  }
  return null;
}

/** Base64 for `session_attach_clipboard_image` (no data: prefix), chunked so a big paste cannot blow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ---------- design §2: drop overlay ----------

export type DropOverlayState = 'hidden' | 'active' | 'rejecting';

/**
 * Common extensionless filenames a developer routinely drags onto a prompt.
 * Without this allowlist ANY dotless basename reads as a folder — including
 * these — which paints the whole overlay `rejecting` for a drop the core would
 * happily ingest. Not exhaustive: an unlisted extensionless file still falls
 * through to the dotless-basename guess below (documented false positive).
 */
const KNOWN_EXTENSIONLESS_FILES = new Set([
  'dockerfile',
  'makefile',
  'rakefile',
  'gemfile',
  'procfile',
  'vagrantfile',
  'jenkinsfile',
  'license',
  'licence',
  'readme',
  'changelog',
  'authors',
  'contributors',
  'copying',
  'notice',
  'todo',
]);

/**
 * Pre-drop hint only: the OS hands us paths, not stat results, so a dotless
 * basename is the best guess available for "this is a folder". The authoritative
 * refusal is still the core's ATTACHMENT_IS_DIRECTORY on drop (FR-8).
 *
 * A DOTFILE is a file: `.gitignore` / `.env` carry no extension but are the most
 * common thing a developer drags onto a prompt, and calling them folders paints
 * the whole overlay `rejecting` for a drop the core would happily ingest. Only
 * `.` and `..` keep the directory reading. `KNOWN_EXTENSIONLESS_FILES` covers the
 * other common case — `Dockerfile` / `Makefile` / `LICENSE` and the like — but any
 * OTHER dotless basename (an unlisted extensionless file) still reads as a
 * folder: a documented false positive, not a bug.
 */
export function pathLooksLikeDirectory(path: string): boolean {
  const trimmed = path.replace(/[\\/]+$/, '');
  const base = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
  if (base === '' || base === '.' || base === '..') return true;
  if (base.includes('.')) return false;
  return !KNOWN_EXTENSIONLESS_FILES.has(base.toLowerCase());
}

export function dropOverlayState(dragging: boolean, paths: readonly string[]): DropOverlayState {
  if (!dragging) return 'hidden';
  if (paths.length > 0 && paths.every(pathLooksLikeDirectory)) return 'rejecting';
  return 'active';
}

// ---------- FR-18: "Clear project attachments" ----------

interface SessionProjectRef {
  id: SessionId;
  projectId?: ProjectId;
}

/**
 * Which project the palette command sweeps: the selected one, else the project
 * the active session belongs to ("All projects" is selected but a session is
 * focused). Null disables the command — ClearScope has no "everything" member.
 */
export function resolveClearProjectId(
  activeProjectId: ProjectId | null,
  activeSessionId: SessionId | null,
  sessions: readonly SessionProjectRef[],
): ProjectId | null {
  if (activeProjectId) return activeProjectId;
  if (!activeSessionId) return null;
  return sessions.find((s) => s.id === activeSessionId)?.projectId ?? null;
}

/** The one dim line the palette reports after a sweep (design §4). */
export function clearReport(res: ClearAttachmentsResult): string {
  const head =
    res.removedFiles === 0
      ? 'No attachments to clear.'
      : `Removed ${res.removedFiles} file${res.removedFiles === 1 ? '' : 's'} (${formatFileSize(res.removedBytes)}).`;
  return res.failed > 0 ? `${head} ${res.failed} could not be deleted.` : head;
}
