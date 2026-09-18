// contract/command-inspect.ts — command-inspect (SESSION tab: open a transcript
// step to see what actually ran).
// Authored from specs/command-inspect.md §5. Imports shared vocabulary from
// common.ts; never redefines it.
//
// Physical Tauri binding: `francois:conversation:stepDetail` → command
// `conversation_step_detail`.

import type { BlockId, ClaudeRuntime, Result, SessionId } from './common';

// ---------- francois:conversation:stepDetail (request/response) ----------
// Tauri command `conversation_step_detail`.
export interface StepDetailPayload {
  sessionId: SessionId;
  blockId: BlockId;
}

/** The command line of a Bash step (FR-3) — verbatim, never re-quoted. */
export interface StepCommand {
  command: string;
  /** The tool input's own `description`, when it carried one. */
  description?: string;
}

/** The captured slice of a step's result (FR-5/FR-6). */
export interface StepOutput {
  /** Tail-biased slice actually kept, cut on a line boundary at 64 KB. '' when the step was silent. */
  text: string;
  /** TRUE totals of the result as produced — NOT the slice's (FR-5). */
  totalLines: number;
  totalBytes: number;
  /** totalLines − lines(text). 0 ⇒ `text` is the complete result. */
  droppedLines: number;
  /** Only from a runtime that separates the streams; absent for claude-code (FR-6). */
  stderrLines?: number;
}

export type StepBody =
  | { kind: 'command'; command: StepCommand; output: StepOutput }
  /** `inputJson`: the whole tool input, pretty JSON, truncated to 4000 chars (FR-3). */
  | { kind: 'generic'; inputJson: string; output: StepOutput };

export interface StepDetail {
  blockId: BlockId;
  /** Verbatim tool name, e.g. 'Bash'. The header chip renders it lowercased (FR-15). */
  tool: string;
  cwd: string;
  runtime: ClaudeRuntime;
  /** WSL only, derived from the cwd (FR-2). */
  distro?: string;
  startedAt: number; // epoch ms
  endedAt?: number; // absent only if the record was written without one
  isError: boolean;
  /** Only when the runtime states one structurally; never for claude-code (FR-4). */
  exitCode?: number;
  body: StepBody;
}

// errors: SESSION_NOT_FOUND | STEP_DETAIL_NOT_FOUND
export type StepDetailResponse = Result<StepDetail>;
