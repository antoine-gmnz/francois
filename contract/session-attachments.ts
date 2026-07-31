// contract/session-attachments.ts — session-attachments feature contract.
// Binding per PIPELINE.md: francois:session:<verb> -> invoke('session_<verb>') -> Promise<Result<T>>.
// Request/response only — no new SessionEvent member. The four ATTACHMENT_* error codes live in
// contract/common.ts (spec §5.3).

import type { AppError, SessionId, ProjectId } from './common';

// ---------- types (spec §5.1) ----------

export type AttachmentKind = 'image' | 'file';

/** Lifecycle of a staged ref. 'sent' is terminal — sent attachments are never swept (FR-15). */
export type AttachmentState = 'staged' | 'sent';

export interface Attachment {
  id: string; // uuid v4
  sessionId: SessionId;
  kind: AttachmentKind; // FR-5
  /** Absolute source path the bytes came from; absent for clipboard images. */
  originPath?: string;
  /** Absolute path on disk, HOST dialect. Equals originPath when copied === false. */
  storedPath: string;
  /** POSIX-separated, relative to the session cwd. The composer inserts '@' + this (FR-4). */
  refPath: string;
  name: string; // basename of storedPath
  bytes: number;
  /** false ⇔ the file already lived under the session cwd and is referenced in place (FR-1). */
  copied: boolean;
  state: AttachmentState;
  createdAt: number; // epoch ms
}

export interface CommitAttachmentsResult {
  sent: string[]; // attachment ids now in state 'sent'
  released: string[]; // attachment ids dropped, copies deleted
}

export interface ClearAttachmentsResult {
  removedFiles: number;
  removedBytes: number;
  failed: number; // files that could not be deleted (locked, permissions)
}

export type ClearScope =
  | { kind: 'session'; sessionId: SessionId }
  | { kind: 'project'; projectId: ProjectId };

// ---------- channels (spec §5.2) ----------
// All request/response on the `session` domain; every call resolves to Result<T> and never rejects.

// ---------- francois:session:attachFile ----------
export interface AttachFileRequest {
  sessionId: SessionId;
  path: string; // absolute, host dialect; a directory is refused (FR-8)
}
// invoke('session_attach_file', req): Promise<Result<Attachment>>
// errors: 'SESSION_NOT_FOUND' | 'ATTACHMENT_TOO_LARGE' | 'ATTACHMENT_IS_DIRECTORY'
//       | 'ATTACHMENT_IO_FAILED' | 'INVALID_INPUT'
// FR-1: a path already under the session cwd resolves copied:false with storedPath unchanged and
// refPath relative to the cwd — no attachments dir is created in that case.

// ---------- francois:session:attachClipboardImage ----------
export interface AttachClipboardImageRequest {
  sessionId: SessionId;
  mime: string; // e.g. 'image/png'; drives the extension, default 'png' (FR-6)
  dataBase64: string; // raw image bytes, base64 (no data: URL prefix)
}
// invoke('session_attach_clipboard_image', req): Promise<Result<Attachment>>
// errors: 'SESSION_NOT_FOUND' | 'ATTACHMENT_TOO_LARGE' | 'ATTACHMENT_IO_FAILED' | 'INVALID_INPUT'
// Always copied:true, originPath absent, name `pasted-<YYYYMMDD>-<HHMMSS>.<ext>` in LOCAL time (FR-6).

/**
 * One entry a multi-file ingestion refused. Canonical here because BOTH surfaces need it: the
 * core builds it per refused pick, the frontend renders it (never redefine it feature-side).
 */
export interface AttachFailure {
  /** Basename of what was refused — the copy names the file, not the path. */
  name: string;
  error: AppError;
}

// ---------- francois:session:pickAttachments ----------
export interface PickAttachmentsRequest {
  sessionId: SessionId;
}
/**
 * FR-9: a pick attaches each entry independently AND reports what it refused. Successes and
 * refusals travel together — returning bare successes made the frontend half of FR-9
 * unimplementable, since a silently-dropped file is indistinguishable from one never picked.
 */
export interface PickAttachmentsResponse {
  attached: Attachment[];
  failed: AttachFailure[];
}
// invoke('session_pick_attachments', req): Promise<Result<PickAttachmentsResponse>>
// errors: 'SESSION_NOT_FOUND' | 'ATTACHMENT_IO_FAILED'
// The native multi-select dialog opens IN THE CORE (tauri-plugin-dialog); each pick is ingested
// through the FR-1 pipeline independently. A per-file refusal lands in `failed`, never as a
// call-level error. A cancelled dialog is ok:true with both arrays empty (FR-9), never an error.

// ---------- francois:session:releaseAttachment ----------
export interface ReleaseAttachmentRequest {
  sessionId: SessionId;
  attachmentId: string;
}
// invoke('session_release_attachment', req): Promise<Result<null>>
// errors: 'SESSION_NOT_FOUND' | 'ATTACHMENT_NOT_FOUND'
// Deletes the file immediately when copied:true; a copied:false origin is never touched (FR-13).

// ---------- francois:session:commitAttachments ----------
export interface CommitAttachmentsRequest {
  sessionId: SessionId;
  text: string; // the text just sent, verbatim (FR-10)
}
// invoke('session_commit_attachments', req): Promise<Result<CommitAttachmentsResult>>
// errors: 'SESSION_NOT_FOUND'
// FR-15: staged attachments whose '@' + refPath occurs in `text` become 'sent'; the rest are
// released (copies deleted). Already-'sent' attachments are untouched.

// ---------- francois:session:clearAttachments ----------
export interface ClearAttachmentsRequest {
  scope: ClearScope;
}
// invoke('session_clear_attachments', req): Promise<Result<ClearAttachmentsResult>>
// errors: 'SESSION_NOT_FOUND' | 'PROJECT_NOT_FOUND'
// FR-18: a 'project' scope sweeps the attachments dir of every session registered under that
// project — driven by the session registry, so worktree sessions are included.

// ---------- shared constants & pure helpers ----------
// Both surfaces must agree byte-for-byte; the core mirrors these values.

/** FR-8. Files strictly larger than this are refused with ATTACHMENT_TOO_LARGE. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

/** FR-5. Extensions (lowercase, with dot) that classify as kind: 'image'. */
export const ATTACHMENT_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const;

/** FR-5. Case-insensitive extension test on a file name or path. */
export function attachmentKindForName(name: string): AttachmentKind {
  const lower = name.toLowerCase();
  return ATTACHMENT_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext)) ? 'image' : 'file';
}

/** FR-11. The exact text inserted into the composer for an attachment. */
export function attachmentRef(a: Pick<Attachment, 'refPath'>): string {
  return `@${a.refPath}`;
}

/** FR-2. Directory segments appended to the session cwd: `.francois/attachments/<short8>`. */
export const ATTACHMENTS_DIR_ROOT = '.francois';
export const ATTACHMENTS_DIR_NAME = 'attachments';

/** FR-2. First 8 characters of the session id — the per-session attachments folder. */
export function attachmentsShortId(sessionId: SessionId): string {
  return sessionId.slice(0, 8);
}

/** FR-2/FR-4. POSIX-separated attachments dir relative to the session cwd. */
export function attachmentsDirRefPath(sessionId: SessionId): string {
  return `${ATTACHMENTS_DIR_ROOT}/${ATTACHMENTS_DIR_NAME}/${attachmentsShortId(sessionId)}`;
}

/** FR-3. Contents written to `<cwd>/.francois/.gitignore` on creation. */
export const ATTACHMENTS_GITIGNORE_BODY = '*\n';
