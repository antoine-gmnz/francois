// contract/diff-view.ts — diff-view (DIFF tab, main pane [2]).
// Authored from specs/diff-view.md §5. Imports shared vocabulary from common.ts;
// never redefines it.
//
// Physical Tauri binding: `francois:diff:<verb>` → command `diff_<verb>`.
// Event stream `francois:diff:event` → Tauri event `francois://diff/event`.

import type { Result, SessionId } from './common';

// ---------- domain types ----------

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';

export interface DiffFileSummary {
  path: string; // repo-relative, forward-slash separated, e.g. 'src/auth/middleware.ts'
  dir: string; // everything before the last '/', '' at repo root
  name: string; // basename
  additions: number;
  deletions: number;
  status: DiffFileStatus;
}

export interface DiffSummary {
  files: DiffFileSummary[]; // sorted by path ascending
  totalAdd: number;
  totalDel: number;
}

export type DiffLineKind = 'hunk' | 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffLineKind;
  oldNo?: number; // set for 'del' and 'ctx'
  newNo?: number; // set for 'add' and 'ctx'
  text: string; // line content, marker character stripped; full '@@ ... @@' text for 'hunk'
}

export interface DiffHunk {
  header: string; // the raw '@@ -a,b +c,d @@ ...' line
  lines: DiffLine[];
}

export interface FileDiff {
  hunks: DiffHunk[];
  /** True when git reports the file as binary; hunks is [] and the UI shows the
   *  binary-file placeholder row instead of trying to render hunks. */
  binary: boolean;
}

export interface CommitResult {
  commitHash: string; // full 40-char SHA from `git rev-parse HEAD`
}

// ---------- request payloads ----------

export interface DiffGetSummaryRequest {
  sessionId: SessionId;
}

export interface DiffGetFileDiffRequest {
  sessionId: SessionId;
  path: string; // DiffFileSummary.path
}

export interface DiffStageAllRequest {
  sessionId: SessionId;
}

export interface DiffCommitRequest {
  sessionId: SessionId;
  message: string; // non-blank after trim; enforced by the frontend before invoke (FR-24)
  /**
   * Repo-relative paths (DiffFileSummary.path) to commit. When non-empty, ONLY these
   * files are committed (`git add -- <paths>` then `git commit -- <paths>`), leaving
   * every other change in the working tree untouched. An empty array commits the
   * current index as-is (legacy stage-all → commit flow).
   */
  paths: string[];
}

// ---------- IPC channels (frontend -> core, invoke/Result) ----------
// 'francois:diff:getSummary'   (DiffGetSummaryRequest)   -> Promise<Result<DiffSummary>>
// 'francois:diff:getFileDiff'  (DiffGetFileDiffRequest)  -> Promise<Result<FileDiff>>
// 'francois:diff:stageAll'     (DiffStageAllRequest)     -> Promise<Result<void>>
// 'francois:diff:commit'       (DiffCommitRequest)       -> Promise<Result<CommitResult>>
//   paths: [] commits the index; paths: [...] commits only those files

export type DiffSummaryResponse = Result<DiffSummary>;
export type DiffFileDiffResponse = Result<FileDiff>;
export type DiffCommitResponse = Result<CommitResult>;

// ---------- event channel (core -> frontend) ----------
// 'francois:diff:event', payload:
export type DiffEvent = { type: 'diff.changed'; sessionId: SessionId; fileCount: number };

export type { SessionId };
