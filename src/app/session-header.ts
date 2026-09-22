// Pure helpers for the session header (SessionHeader.tsx) — redesign "Graphite &
// Signal", Figma "Session header" 131:512.

import type { SessionMeta } from '../../contract/common';
import { displayWslCwd } from '../../contract/wsl-filesystem';
import { abbreviate } from '../lib/path';

export interface SessionMetaLine {
  /** The worktree's branch label, or null for a session in the main checkout. */
  branch: string | null;
  /** What the meta line reads. */
  text: string;
  /** The full (abbreviated) cwd, for the hover title. */
  title: string;
}

/**
 * The line under the session name. A worktree session reads its branch the way
 * the design draws it (`feat/auth-retry  /  worktree`). A session in the main
 * checkout has no branch the frontend knows — the roster runs no branch probe —
 * so it names where it runs instead: the cwd, `~`-abbreviated (Linux form for WSL).
 */
export function sessionMetaLine(session: Pick<SessionMeta, 'cwd'>, home: string, branchLabel: string | null): SessionMetaLine {
  const path = displayWslCwd(session.cwd) ?? abbreviate(session.cwd, home);
  if (branchLabel) return { branch: branchLabel, text: `${branchLabel}  /  worktree`, title: path };
  return { branch: null, text: path, title: path };
}
