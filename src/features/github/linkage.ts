// github-page: which session owns a branch. The core never computes this — the
// only link between git and the fleet is `SessionMeta.worktree.branch`, so the
// join happens here, over the session cache every tab already reads.

import type { SessionMeta } from '../../../contract/common';

/**
 * The session working on `branch`, preferring the most recently active. Detached worktrees carry a
 * short sha in `worktree.branch`, never a branch name, so they never match.
 */
export function sessionForBranch(
  sessions: readonly SessionMeta[],
  branch: string,
): SessionMeta | undefined {
  let best: SessionMeta | undefined;
  for (const s of sessions) {
    const wt = s.worktree;
    if (!wt || wt.detached || wt.branch !== branch) continue;
    if (!best || rank(s) > rank(best)) best = s;
  }
  return best;
}

/** Every session attached to a branch, keyed by branch name. */
export function sessionsByBranch(sessions: readonly SessionMeta[]): Map<string, SessionMeta[]> {
  const out = new Map<string, SessionMeta[]>();
  for (const s of sessions) {
    const wt = s.worktree;
    if (!wt || wt.detached) continue;
    const list = out.get(wt.branch);
    if (list) list.push(s);
    else out.set(wt.branch, [s]);
  }
  return out;
}

function rank(s: SessionMeta): number {
  return s.lastActivityAt;
}
