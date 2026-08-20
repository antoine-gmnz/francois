// contract/diff-view.ts — DIFF tab: one-scroll body, tree rail, commits block, commit form.
// Rewritten in place for diff-review (decision 2026-08-04 `api`: re-keying an existing IPC
// domain rewrites that domain's contract file, never a second file for the same domain).
// Authored from specs/diff-review.md §5. Imports shared vocabulary from common.ts;
// never redefines it. Added ErrorCode members ('DIFF_COMMIT_NOT_FOUND', 'DIFF_NOTHING_TO_AMEND')
// live in contract/common.ts.
//
// Physical Tauri binding: `francois:diff:<verb>` → command `diff_<verb>`.
// Event stream `francois:diff:event` → Tauri event `francois://diff/event`.

import type { Result, SessionId } from './common';

// ---------- domain types ----------

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';

export interface DiffFileSummary {
  // unchanged
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
  branch: string | null; // NEW — current branch, null when detached (FR-4)
  headShort: string | null; // NEW — short HEAD hash, for the detached label (FR-4)
  baseBranch: string | null; // NEW — the default branch we count ahead of, null if none (FR-13)
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

/** One commit ahead of the branch's base (FR-13). */
export interface DiffCommitSummary {
  hash: string; // full 40-char
  shortHash: string; // git's own abbreviation
  subject: string; // first line
  body: string; // remainder, '' when none — feeds the amend pre-fill (FR-38)
  authoredAt: number; // epoch ms
  isHead: boolean; // true for exactly one row, the first
  pushed: boolean; // reachable from any remote-tracking ref (FR-39)
}

export interface DiffCommitList {
  commits: DiffCommitSummary[]; // newest first, capped at 50
  baseBranch: string | null;
  truncated: boolean; // true when the branch is >50 ahead
}

// ---------- request payloads ----------

export interface DiffGetSummaryRequest {
  sessionId: SessionId;
  /** Full hash; when set, the summary is that commit vs its first parent (FR-15). */
  commit?: string;
}

export interface DiffGetFileDiffRequest {
  sessionId: SessionId;
  path: string; // DiffFileSummary.path
  /** Same ref semantics as DiffGetSummaryRequest.commit. */
  commit?: string;
  /** `git diff -U<n>`; default 3, clamped to [0, 10000] (FR-26). */
  context?: number;
}

export interface DiffListCommitsRequest {
  sessionId: SessionId;
}

export interface DiffCommitRequest {
  sessionId: SessionId;
  message: string; // subject; non-blank after trim, re-validated by the core
  body?: string; // extended description, passed as a second -m
  /** MUST be non-empty unless amend is true; [] no longer means "the index" (FR-43). */
  paths: string[];
  amend: boolean; // `git commit --amend`
}

// ---------- IPC channels (frontend -> core, invoke/Result) ----------
// 'francois:diff:getSummary'   (DiffGetSummaryRequest)   -> Promise<Result<DiffSummary>>
// 'francois:diff:getFileDiff'  (DiffGetFileDiffRequest)  -> Promise<Result<FileDiff>>
// 'francois:diff:listCommits'  (DiffListCommitsRequest)  -> Promise<Result<DiffCommitList>>
// 'francois:diff:commit'       (DiffCommitRequest)       -> Promise<Result<CommitResult>>
// 'francois:diff:stageAll' is DELETED (FR-43) — do not reintroduce.
//
// Core behaviour, normative (§5):
// - diff_commit with amend:false runs `git add -- <paths>` then
//   `git commit -m <message> [-m <body>] -- <paths>`. With amend:true it runs the same add, then
//   `git commit --amend -m <message> [-m <body>] [-- <paths>]`; empty paths + amend amends the
//   message alone. paths empty with amend:false => INVALID_INPUT.
// - diff_list_commits resolves the base with the existing diff_base helper, then
//   `git log --format=… <base>..HEAD -n 50`, and marks `pushed` from
//   `git branch --remotes --contains <hash>` for HEAD only (a commit reachable from a remote
//   implies its ancestors are).
// - Every git call routes through git_routed/git_program, so WSL path translation is inherited
//   untouched (wsl-filesystem).
// - `commit` on getSummary/getFileDiff is compared against `git rev-parse --verify <ref>^{commit}`
//   before use; anything else is DIFF_COMMIT_NOT_FOUND. It is a hash from listCommits, never
//   user-typed, but it is re-validated at the entry point regardless (decision 2026-08-17 `security`).
//
// errors:
// - getSummary/getFileDiff: 'SESSION_NOT_FOUND' | 'NOT_A_GIT_REPO' | 'GIT_ERROR' |
//   'DIFF_COMMIT_NOT_FOUND' | 'INTERNAL'
// - listCommits: 'SESSION_NOT_FOUND' | 'NOT_A_GIT_REPO' | 'GIT_ERROR' | 'INTERNAL'
// - commit: 'SESSION_NOT_FOUND' | 'NOT_A_GIT_REPO' | 'INVALID_INPUT' | 'GIT_ERROR' |
//   'DIFF_NOTHING_TO_AMEND' | 'INTERNAL'

export type DiffSummaryResponse = Result<DiffSummary>;
export type DiffFileDiffResponse = Result<FileDiff>;
export type DiffCommitListResponse = Result<DiffCommitList>;
export type DiffCommitResponse = Result<CommitResult>;

// ---------- event channel (core -> frontend) ----------
// 'francois:diff:event', payload: unchanged.
export type DiffEvent = { type: 'diff.changed'; sessionId: SessionId; fileCount: number };

export type { SessionId };
