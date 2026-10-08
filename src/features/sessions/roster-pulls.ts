// The roster's open-PR marker — pure half (useRosterPulls.ts is the I/O half).
// A session "has" a PR the same way the Changes panel card decides it
// (session-pull.ts): an open or draft PR whose head is the branch its cwd has
// checked out. The roster asks `gh` once per repo, not once per session.

import type { SessionMeta } from '../../../contract/common';
import type { PullSummary } from '../../../contract/github-page';
import { pullForBranch } from '../github/session-pull';

/** The directory a session's PR list is read from — one `gh pr list` per distinct value. */
export function pullScope(session: SessionMeta): string {
  return session.worktree?.sourceRepoRoot ?? session.cwd;
}

/** session id → its open/draft PR. Sessions with no branch or no matching PR are absent. */
export function joinRosterPulls(
  sessions: readonly SessionMeta[],
  branches: ReadonlyMap<string, string>,
  pullsByScope: ReadonlyMap<string, readonly PullSummary[]>,
): Map<string, PullSummary> {
  const out = new Map<string, PullSummary>();
  for (const s of sessions) {
    const pulls = pullsByScope.get(pullScope(s));
    if (!pulls) continue;
    const pull = pullForBranch(pulls, branches.get(s.id));
    if (pull) out.set(s.id, pull);
  }
  return out;
}

/** The icon's hover title: `PR #42 · Fix the thing` (draft PRs say so). */
export function pullMarkerTitle(pull: PullSummary): string {
  return `${pull.state === 'draft' ? 'Draft PR' : 'PR'} #${pull.number} · ${pull.title}`;
}
