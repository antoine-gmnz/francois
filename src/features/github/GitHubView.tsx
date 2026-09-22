// github-page — the GitHub main tab (specs/github-page.md §2/§3, frames 29/30/31).
// Resolves the repo scope (FR: active project root → active session cwd →
// EmptyPane), loads `GithubRepoInfo` once, and renders RepoHeader + whichever
// body tab is selected. Owns no session-scoped state — see appShell.ts's
// treatment of 'github' (isSessionScopedTab: false, showsPanes: false).

import { useEffect, useState } from 'react';
import type { GithubRepoInfo } from '../../../contract/github-page';
import { githubFetch, githubListBranches, githubListPulls, githubOpenUrl, githubRepoInfo } from '../../lib/api';
import { useStore } from '../../lib/store';
import { EmptyPane } from '../../ui/EmptyPane';
import { LoaderPane, LoaderStitch } from '../../ui/Loader';
import { BranchesTab } from './BranchesTab';
import { CommitsTab } from './CommitsTab';
import { PullsTab } from './PullsTab';
import { getGithubTab, selectPullInTab, setGithubTab, type GithubTab } from './github-tab-state';
import { RepoHeader } from './RepoHeader';
import { useLatestRequest } from './useLatestRequest';
import './github.css';

/** FR: the active project's root, else the active session's cwd, else null. */
function useScopeCwd(): string | null {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projects);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);

  const project = activeProjectId ? (projects.find((p) => p.id === activeProjectId) ?? null) : null;
  if (project) return project.root;
  const session = activeSessionId ? (sessions.find((s) => s.id === activeSessionId) ?? null) : null;
  return session ? session.cwd : null;
}

export default function GitHubView(): JSX.Element {
  const cwd = useScopeCwd();
  const [repo, setRepo] = useState<GithubRepoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [tab, setTab] = useState<GithubTab>(getGithubTab());
  const [refreshKey, setRefreshKey] = useState(0);
  const [pullCount, setPullCount] = useState<number | null>(null);
  const [branchCount, setBranchCount] = useState<number | null>(null);
  const beginRepoRequest = useLatestRequest();
  const beginCountsRequest = useLatestRequest();

  const selectTab = (t: GithubTab) => {
    setGithubTab(t);
    setTab(t);
  };

  /** Branches tab's PULL REQUEST column (FR-10): jump to that PR on Pull requests. */
  const openPull = (number: number) => {
    selectPullInTab(number);
    setTab('pulls');
  };

  async function loadRepo(activeCwd: string): Promise<void> {
    const isCurrent = beginRepoRequest();
    setLoading(true);
    setError(null);
    const res = await githubRepoInfo(activeCwd);
    if (!isCurrent()) return;
    setLoading(false);
    if (res.ok) setRepo(res.data);
    else setError(res.error.message);
  }

  async function loadCounts(activeCwd: string, r: GithubRepoInfo): Promise<void> {
    const isCurrent = beginCountsRequest();
    const branches = await githubListBranches(activeCwd);
    if (!isCurrent()) return;
    if (branches.ok) setBranchCount(branches.data.filter((b) => !b.isDefault).length);
    if (r.gh === 'ok') {
      const pulls = await githubListPulls({ cwd: activeCwd });
      if (!isCurrent()) return;
      if (pulls.ok) setPullCount(pulls.data.filter((p) => p.state === 'open' || p.state === 'draft').length);
    } else {
      setPullCount(null);
    }
  }

  useEffect(() => {
    if (!cwd) {
      setRepo(null);
      return;
    }
    void loadRepo(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- known backlog (PIPELINE.md §Code quality gates)
  }, [cwd]);

  useEffect(() => {
    if (cwd && repo) void loadCounts(cwd, repo);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- known backlog (PIPELINE.md §Code quality gates)
  }, [cwd, repo, refreshKey]);

  if (!cwd) {
    return (
      <div className="gh-root">
        <EmptyPane>Open a project to see its repository.</EmptyPane>
      </div>
    );
  }

  if (loading && !repo) {
    return (
      <div className="gh-root">
        <LoaderPane size={40} label="Reading repository…" />
      </div>
    );
  }

  if (error || !repo) {
    return (
      <div className="gh-root">
        <EmptyPane>
          <p>{error ?? 'Could not load this repository.'}</p>
          <button type="button" className="gh-retry" onClick={() => void loadRepo(cwd)}>
            Retry
          </button>
        </EmptyPane>
      </div>
    );
  }

  const doFetch = async () => {
    setFetching(true);
    const res = await githubFetch(cwd);
    setFetching(false);
    if (res.ok) setRepo(res.data);
    setRefreshKey((k) => k + 1);
  };

  const newPullRequest = () => {
    if (!repo.webUrl || !repo.currentBranch) return;
    void githubOpenUrl({ cwd, url: `${repo.webUrl}/compare/${repo.currentBranch}?expand=1` });
  };

  return (
    <div className="gh-root">
      {fetching && <LoaderStitch edge="top" label="Fetching" />}
      <RepoHeader
        repo={repo}
        tab={tab}
        onSelectTab={selectTab}
        pullCount={pullCount}
        branchCount={branchCount}
        fetching={fetching}
        onFetch={() => void doFetch()}
        onNewPullRequest={newPullRequest}
      />
      <div className="gh-body">
        {tab === 'pulls' && <PullsTab cwd={cwd} repo={repo} refreshKey={refreshKey} />}
        {tab === 'commits' && <CommitsTab cwd={cwd} repo={repo} refreshKey={refreshKey} />}
        {tab === 'branches' && (
          <BranchesTab cwd={cwd} repo={repo} refreshKey={refreshKey} onPruned={() => setRefreshKey((k) => k + 1)} onOpenPull={openPull} />
        )}
      </div>
    </div>
  );
}
