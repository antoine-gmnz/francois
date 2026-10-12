// contract/code-editor-workspace.ts — code-editor-workspace feature contract
// (specs/code-editor-workspace.md §5). Binding per PIPELINE.md:
// francois:editor:<verb> -> invoke('editor_<verb>') -> Promise<Result<T>>.
// No new event stream: a replace-all write reaches open tabs through the existing
// 'francois://editor/event' watch (editor.changed), exactly like any other disk write.
// No new ErrorCode: failures reuse code-editor's EDITOR_* codes and INTERNAL.

import type { Result } from './common';
import type { EditorRoot, FileVersion } from './code-editor';

/** FR-14 limits — shared so the core and the frontend cannot drift. */
export const EDITOR_SEARCH_MAX_MATCHES = 2_000; // stop collecting past this; `truncated: true`
export const EDITOR_SEARCH_MAX_FILES = 500; // stop after this many files with a match
export const EDITOR_SEARCH_PREVIEW_CHARS = 200; // a match line's preview is clipped around the match
export const EDITOR_SEARCH_QUERY_MAX = 1_000; // longer queries are refused (INTERNAL, message says why)

export interface EditorSearchOptions {
  /** Case-sensitive match ("Aa"). */
  matchCase: boolean;
  /** Whole-word match ("ab") — the match must sit between non-word characters. */
  wholeWord: boolean;
  /** `query` is a Rust `regex` pattern (".*"); otherwise it is literal. */
  regex: boolean;
}

// ---------- francois:editor:search ----------
export interface EditorSearchRequest {
  root: EditorRoot;
  /** Non-empty. Matched per line (no multi-line matches). */
  query: string;
  options: EditorSearchOptions;
  /** "files to include": comma-separated globs relative to the root (`services/**, *.ts`).
   *  Empty = every file. A bare folder name (`services`) means `services/**`. */
  include: string;
}

export interface EditorSearchMatch {
  /** 1-based line number. */
  line: number;
  /** 1-based UTF-16 column of the match start in the ORIGINAL line (Monaco's column unit). */
  column: number;
  /** The line (trimmed of leading whitespace) clipped to EDITOR_SEARCH_PREVIEW_CHARS; a clipped
   *  side starts/ends with '…'. */
  preview: string;
  /** The match's [start, end) as UTF-16 offsets into `preview` — what the UI bolds. */
  previewStart: number;
  previewEnd: number;
}

export interface EditorSearchFile {
  /** Relative to the root, '/'-separated. */
  path: string;
  matches: EditorSearchMatch[];
}

export interface EditorSearchData {
  /** Files in path order. Only searches the files `editor_files` lists (git-tracked + untracked
   *  not ignored), skipping binary and > EDITOR_OPEN_CAP_BYTES files. Reads DISK, not buffers. */
  files: EditorSearchFile[];
  /** Total matches across `files`. */
  matchCount: number;
  /** A cap (matches or files) was hit. */
  truncated: boolean;
}
// invoke('editor_search', req): Promise<Result<EditorSearchData>>
// errors: 'PROJECT_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'INTERNAL' (bad regex / bad glob / too long:
//          message names the problem, e.g. "Invalid regular expression: …")
export type EditorSearchResponse = Result<EditorSearchData>;

// ---------- francois:editor:replace ----------
export interface EditorReplaceFileTarget {
  path: string;
  /** Version the frontend last saw for an OPEN tab; omitted for files not open. A mismatch skips
   *  the file (reported in `skipped`, reason 'stale'). */
  baseVersion?: FileVersion;
}

export interface EditorReplaceRequest {
  root: EditorRoot;
  query: string;
  options: EditorSearchOptions;
  /** Literal replacement text; with `options.regex`, `$1`/`${name}` expand capture groups. */
  replacement: string;
  /** "AB" — preserve case: an all-upper match gets an upper-cased replacement, a capitalised one
   *  a capitalised replacement, otherwise the replacement as typed. */
  preserveCase: boolean;
  /** The files to rewrite (the frontend sends the result list minus files with dirty buffers). */
  files: EditorReplaceFileTarget[];
}

export interface EditorReplaceData {
  /** Files written, with their new version. */
  written: Array<{ path: string; version: FileVersion; replacements: number }>;
  /** Files left untouched. */
  skipped: Array<{ path: string; reason: 'stale' | 'not-found' | 'binary' | 'outside-root' | 'write-failed' | 'no-match' }>;
}
// invoke('editor_replace', req): Promise<Result<EditorReplaceData>>
// Each file is rewritten with the same atomic write + line-ending/BOM preservation as editor_save.
// errors: 'PROJECT_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'INTERNAL' (bad regex)
export type EditorReplaceResponse = Result<EditorReplaceData>;

// ---------- francois:editor:blame ----------
export interface EditorBlameRequest {
  root: EditorRoot;
  path: string;
  /** 1-based. */
  line: number;
}

export interface EditorBlameLine {
  /** `git blame --porcelain` author; "You" is NOT substituted by the core. */
  author: string;
  /** Author time, epoch ms. */
  time: number;
  /** Commit subject. */
  summary: string;
  /** Full sha. */
  sha: string;
}
// invoke('editor_blame', req): Promise<Result<EditorBlameLine | null>>
// Blames the file AS ON DISK at HEAD (`git blame --porcelain -L <line>,<line> -- <path>`).
// null when: not a repo, untracked, the line is beyond the file, or the line is not committed yet
// (the all-zero sha). Never an error for those.
// errors: 'PROJECT_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'EDITOR_OUTSIDE_ROOT' | 'INTERNAL'
export type EditorBlameResponse = Result<EditorBlameLine | null>;
