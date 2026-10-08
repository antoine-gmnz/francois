// The roster's open-PR marker — I/O half. Every POLL_MS: resolve each session's
// checked-out branch (project_repo_brief, so a main-checkout session works as
// well as a worktree one), then one `gh pr list --state open` per repo. gh
// missing / unauthenticated / not a GitHub remote ⇒ that repo has no markers,
// never an error.

import { useEffect, useState } from 'react';
import type { SessionMeta } from '../../../contract/common';
import type { PullSummary } from '../../../contract/github-page';
import { githubListPulls, projectRepoBrief } from '../../lib/api';
import { joinRosterPulls, pullScope } from './roster-pulls';

const POLL_MS = 60_000;

const EMPTY: ReadonlyMap<string, PullSummary> = new Map();

export function useRosterPulls(sessions: readonly SessionMeta[]): ReadonlyMap<string, PullSummary> {
  const [pulls, setPulls] = useState(EMPTY);
  // Re-probe when the set of sessions or where they live changes, not on every meta tick.
  const key = sessions.map((s) => `${s.id}\0${s.cwd}\0${s.worktree?.branch ?? ''}`).join('\n');

  useEffect(() => {
    let live = true;
    const load = async (): Promise<void> => {
      const branches = new Map<string, string>();
      await Promise.all(
        sessions.map(async (s) => {
          const brief = await projectRepoBrief(s.id);
          const git = brief.ok ? brief.data.git : undefined;
          if (git && !git.detached && git.branch) branches.set(s.id, git.branch);
        }),
      );
      const scopes = [...new Set(sessions.filter((s) => branches.has(s.id)).map(pullScope))];
      const byScope = new Map<string, readonly PullSummary[]>();
      await Promise.all(
        scopes.map(async (cwd) => {
          const res = await githubListPulls({ cwd, state: 'open' });
          if (res.ok) byScope.set(cwd, res.data);
        }),
      );
      if (live) setPulls(joinRosterPulls(sessions, branches, byScope));
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `sessions`
  }, [key]);

  return pulls;
}
