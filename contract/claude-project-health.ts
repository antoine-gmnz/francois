// contract/claude-project-health.ts — two `claude -p` preconditions Francois
// checks before they bite a turn (core: src-tauri/src/session/project_health.rs).
//
// 1. Folder trust as `-p` reads it: Claude Code ignores the project's
//    `.claude/settings.json` `permissions.allow` rules until
//    `projects[<key>].hasTrustDialogAccepted` is true in the account's
//    `.claude.json`, for EXACTLY the key — the git repo root of the cwd (the
//    MAIN repo root for a linked worktree), realpath, forward slashes; no
//    ancestor walk.
// 2. Cohorte's fail-closed PreToolUse guard (`cohorte-gate.py`, onFailure
//    "block") refuses every covered tool call when its interpreter is not on
//    the PATH Francois gives `claude`.
//
// A non-Claude runtime answers the neutral value (trusted, empty key, 0 rules,
// no guard) — nothing to report.

import type { Result, SessionId } from './common';

export interface ClaudeTrustHealth {
  /** `projects[key].hasTrustDialogAccepted === true` for the exact key. */
  trusted: boolean;
  /** The `projects` key a `claude -p` in this session's cwd reads trust from. */
  key: string;
  /** `permissions.allow` entries across `<cwd>/.claude/settings.json` + `settings.local.json`. */
  allowRuleCount: number;
}

export interface ClaudeGuardHealth {
  /** A PreToolUse hook in the cwd's settings references `cohorte-gate.py`. */
  registered: boolean;
  /** The interpreter the guard needs (e.g. "python3") when it does not resolve on
   *  the login-shell PATH; null when fine, unregistered, or not checkable (WSL). */
  interpreterMissing: string | null;
}

export interface ClaudeProjectHealth {
  trust: ClaudeTrustHealth;
  guard: ClaudeGuardHealth;
}

// Channels (physical Tauri binding per CONVENTIONS §Conventions):
// francois:session:projectHealth → invoke('session_project_health', { sessionId }) → Result<ClaudeProjectHealth>
// francois:session:trustFolder   → invoke('session_trust_folder',   { sessionId }) → Result<ClaudeProjectHealth>
//   Writes `hasTrustDialogAccepted: true` on the exact key; only ever from an explicit click.

export interface SessionProjectHealthRequest {
  sessionId: SessionId;
}
export type SessionProjectHealthResponse = Result<ClaudeProjectHealth>;
export type SessionTrustFolderResponse = Result<ClaudeProjectHealth>;
