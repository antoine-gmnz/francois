// contract/session-welcome.ts — the SESSION tab's welcome header (the block that
// stands in for an empty transcript).
//
// Most of what the header states the frontend already holds: the model, the
// account, the cwd, and the sessions that ran in this repo before. The one thing
// it cannot know is what the repo itself looks like — whether the project carries
// a CLAUDE.md, and where HEAD sits relative to the trunk. That is this file's one
// command.
//
// Channel: `francois:project:repoBrief` → Tauri command `project_repo_brief`,
// keyed by session (the core owns the cwd, and the git plumbing routes on it —
// wsl-filesystem FR-5). Read-only and idempotent: it spawns git, touches nothing,
// and a failure is never fatal to the header — the frontend simply renders the
// lines it does have.

import type { Result, SessionId } from './common';

/** The repo's own CLAUDE.md, as the header states it. */
export interface ClaudeMdBrief {
  /**
   * Physical line count of the whole file — not just the Francois-managed block
   * (projects FR-11). A trailing newline does not count as a line, so a 41-line
   * file reads as 41 whether or not it ends in one; an empty file is 0.
   */
  lines: number;
  /** mtime, epoch ms. */
  modifiedAt: number;
}

/** Where HEAD sits. Absent from a RepoBrief ⇔ the cwd is not inside a worktree. */
export interface GitBrief {
  /** The checked-out branch, or the short sha when `detached`. */
  branch: string;
  /** true ⇒ `branch` is a sha, not a name — nothing is "ahead" of anything. */
  detached: boolean;
  /**
   * The trunk `ahead` is measured against — the first of `main`/`master` that
   * exists locally and is not the checked-out branch. Absent ⇒ there is no such
   * branch (a trunk-less repo, or HEAD *is* the trunk), and `ahead` is absent too.
   */
  base?: string;
  /** Commits on `branch` that `base` does not have. Present ⇔ `base` is. */
  ahead?: number;
}

export interface RepoBrief {
  /**
   * The worktree root the facts below describe, in the host's dialect (a Linux
   * path for a WSL repo — wsl-filesystem FR-6). Absent ⇔ `git` is absent; the
   * CLAUDE.md probe then falls back to the session cwd itself.
   */
  root?: string;
  /** Absent ⇒ no CLAUDE.md at the root (or it could not be read). */
  claudeMd?: ClaudeMdBrief;
  git?: GitBrief;
}

// francois:project:repoBrief
export interface RepoBriefRequest {
  sessionId: SessionId;
}
export type RepoBriefResponse = Result<RepoBrief>; // errors: 'SESSION_NOT_FOUND'

// The sentences the header builds out of these shapes are presentation, so they
// live with the view — src/features/conversation/welcome.ts (pure, unit-tested).
