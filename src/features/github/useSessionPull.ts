// Loads the pull request open on a session's branch for the Changes panel card.
// The branch comes from the session's own cwd (project_repo_brief), so a
// worktree session and a main-checkout session both resolve correctly. Polls
// while mounted: a PR opened from the terminal shows up without a click.

import { useCallback, useEffect, useState } from 'react';
import type { SessionId } from '../../../contract/common';
import type { PullDetail } from '../../../contract/github-page';
import { githubGetPull, githubListPulls, projectRepoBrief } from '../../lib/api';
import { pullForBranch } from './session-pull';
import { useLatestRequest } from './useLatestRequest';

const POLL_MS = 60_000;

export interface SessionPull {
  pull: PullDetail | null;
  /** Re-reads the PR. After a merge, pass its number so the card shows the merged state. */
  refresh: (keepNumber?: number) => void;
}

export function useSessionPull(sessionId: SessionId, cwd: string): SessionPull {
  const [pull, setPull] = useState<PullDetail | null>(null);
  const begin = useLatestRequest();

  const load = useCallback(
    async (keepNumber?: number): Promise<void> => {
      const isCurrent = begin();
      let number = keepNumber;
      if (number === undefined) {
        const brief = await projectRepoBrief(sessionId);
        const git = brief.ok ? brief.data.git : undefined;
        if (!isCurrent()) return;
        if (!git || git.detached) return setPull(null);
        const pulls = await githubListPulls({ cwd });
        if (!isCurrent()) return;
        // gh missing / unauthenticated / not a GitHub remote: no card, no error.
        if (!pulls.ok) return setPull(null);
        number = pullForBranch(pulls.data, git.branch)?.number;
        if (number === undefined) return setPull(null);
      }
      const detail = await githubGetPull({ cwd, number });
      if (!isCurrent()) return;
      if (detail.ok) setPull(detail.data);
    },
    [begin, sessionId, cwd],
  );

  useEffect(() => {
    setPull(null);
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const refresh = useCallback((keepNumber?: number) => void load(keepNumber), [load]);
  return { pull, refresh };
}
