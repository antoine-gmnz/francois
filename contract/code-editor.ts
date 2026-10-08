// contract/code-editor.ts — code-editor feature contract (specs/code-editor.md §5).
// Binding per PIPELINE.md: francois:editor:<verb> -> invoke('editor_<verb>') -> Promise<Result<T>>;
// event stream francois:editor:event -> Tauri event 'francois://editor/event'.
// Added ErrorCode members (EDITOR_OUTSIDE_ROOT, EDITOR_FILE_NOT_FOUND, EDITOR_BINARY,
// EDITOR_TOO_LARGE, EDITOR_STALE, EDITOR_WRITE_FAILED) live in contract/common.ts.
// open-in-vscode's OpenInEditorRequest gains optional `file`/`line` (FR-15) in its own file.

import type { ProjectId, Result, SessionId } from './common';
import type { EditorId } from './open-in-vscode';

/** FR-3: a root is always named, never a raw path. The core resolves `project` to the registered
 *  project root and `session` to the session's cwd (its worktree when it has one). */
export type EditorRoot =
  | { kind: 'project'; projectId: ProjectId }
  | { kind: 'session'; sessionId: SessionId };

/** Opaque change token: `${mtimeMs}:${size}:${sha256-16hex}` of the bytes on disk. Compare with ===. */
export type FileVersion = string;

export type LineEnding = 'lf' | 'crlf';

export type ReadOnlyReason = 'too-large' | 'permission';

/** FR-5: porcelain status per changed path — `M` modified, `A` added or untracked. */
export type GitChange = 'M' | 'A';

/** FR-4/6/8 limits — shared so the core and the frontend cannot drift. */
export const EDITOR_EDIT_CAP_BYTES = 2 * 1024 * 1024; // above: opens read-only ('too-large')
export const EDITOR_OPEN_CAP_BYTES = 10 * 1024 * 1024; // above: EDITOR_TOO_LARGE
export const EDITOR_BINARY_SNIFF_BYTES = 8 * 1024; // NUL in the first 8 KiB => EDITOR_BINARY
export const EDITOR_FILES_CAP = 20_000; // FR-4 tree / Go to file list cap
export const EDITOR_MAX_TABS = 12; // FR-6, per root
export const EDITOR_WATCH_DEBOUNCE_MS = 150; // FR-12

export interface EditorFile {
  root: EditorRoot;
  /** Relative to the root, '/'-separated, no leading './'. */
  path: string;
  /** Decoded UTF-8 with the BOM stripped and every CRLF normalised to LF. */
  text: string;
  version: FileVersion;
  /** The file's dominant line ending on disk (CRLF if any CRLF is present, else LF). */
  lineEnding: LineEnding;
  bom: boolean;
  /** Whether the file on disk ends with a newline. */
  trailingNewline: boolean;
  readOnly: boolean;
  readOnlyReason?: ReadOnlyReason;
  /** FR-9: the HEAD blob (LF-normalised), null when untracked or the root is not a git repo. */
  headText: string | null;
}

// ---------- francois:editor:files ----------
export interface EditorFilesRequest {
  root: EditorRoot;
}
export interface EditorFilesData {
  /** Project name or session name — the root picker's label. */
  rootLabel: string;
  /** `git rev-parse --abbrev-ref HEAD`; the short sha when detached; null when not a repo. */
  branch: string | null;
  /** Sorted, '/'-separated, relative to the root. git ls-files --cached --others --exclude-standard,
   *  or a .gitignore-honouring walk when the root is not a repo. Never contains '.git/' entries. */
  paths: string[];
  /** true when the list was capped at EDITOR_FILES_CAP. */
  truncated: boolean;
  /** Only changed paths (from `git status --porcelain=v1 -z`); `{}` when clean or not a repo. */
  changes: Record<string, GitChange>;
}
// invoke('editor_files', req): Promise<Result<EditorFilesData>>
// errors: 'PROJECT_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'INTERNAL'
export type EditorFilesResponse = Result<EditorFilesData>;

// ---------- francois:editor:open ----------
// Idempotent: re-opening a watched path re-reads disk and keeps exactly one watch.
export interface EditorOpenRequest {
  root: EditorRoot;
  path: string; // relative to the root; absolute paths inside the root are accepted and relativised
}
// invoke('editor_open', req): Promise<Result<EditorFile>>
// errors: 'PROJECT_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'EDITOR_OUTSIDE_ROOT' | 'EDITOR_FILE_NOT_FOUND'
//       | 'EDITOR_BINARY' | 'EDITOR_TOO_LARGE' (detail: { size }) | 'INTERNAL'
export type EditorOpenResponse = Result<EditorFile>;

// ---------- francois:editor:save ----------
export interface EditorSaveRequest {
  root: EditorRoot;
  path: string;
  /** LF-normalised, no BOM. The core converts LF -> lineEnding and prepends a BOM when `bom`;
   *  the trailing newline is whatever `text` ends with (the frontend keeps the loaded one). */
  text: string;
  /** The version the buffer was loaded from (or rebased to via "Keep mine"). Mismatch => EDITOR_STALE. */
  baseVersion: FileVersion;
  lineEnding: LineEnding;
  bom: boolean;
}
export interface EditorSaveData {
  version: FileVersion;
}
// invoke('editor_save', req): Promise<Result<EditorSaveData>>
// Atomic: temp file in the same dir, then rename; original permissions preserved. A missing file
// (deleted on disk) is recreated when baseVersion is the version it had.
// The core's own write MUST NOT echo back as an editor.changed event for that version.
// errors: 'PROJECT_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'EDITOR_OUTSIDE_ROOT'
//       | 'EDITOR_STALE' (detail: { version: FileVersion }) | 'EDITOR_WRITE_FAILED' (detail: { reason })
//       | 'INTERNAL'
export type EditorSaveResponse = Result<EditorSaveData>;

// ---------- francois:editor:close ----------
export interface EditorCloseRequest {
  root: EditorRoot;
  path: string;
}
// invoke('editor_close', req): Promise<Result<null>> — stops the watch. Closing an unwatched path is ok.
// errors: 'PROJECT_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'INTERNAL'
export type EditorCloseResponse = Result<null>;

// ---------- francois:editor:openExternal ----------
// FR-15, for `project` roots (session roots use session_open_in_editor with file/line).
// Reuses open-in-vscode's launcher and WSL target rules.
export interface EditorOpenExternalRequest {
  root: EditorRoot;
  editorId: EditorId;
  /** Relative to the root. */
  file: string;
  /** 1-based; launches `<editor> -g <path>:<line>`. */
  line?: number;
}
// invoke('editor_open_external', req): Promise<Result<null>>
// errors: 'PROJECT_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'EDITOR_OUTSIDE_ROOT'
//       | 'EDITOR_NOT_FOUND' (detail: { editorId }) | 'EDITOR_LAUNCH_FAILED' (detail: { path }) | 'INTERNAL'
export type EditorOpenExternalResponse = Result<null>;

// ---------- francois:editor:event ----------
// Tauri event 'francois://editor/event'. Only for watched (open) paths, debounced EDITOR_WATCH_DEBOUNCE_MS.
export type EditorEvent =
  | { type: 'editor.changed'; root: EditorRoot; path: string; version: FileVersion }
  | { type: 'editor.deleted'; root: EditorRoot; path: string };
