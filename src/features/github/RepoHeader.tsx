// github-page FR-2 — the 60px repo header: title + remote chip + meta line on
// the left, the view tabs + Fetch + New pull request on the right.
// Figma frames 29/30/31 share this bar verbatim (`160:15836` / `161:15989` /
// `162:16108`).

import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Tab, TabGroup } from '../../ui/Tab';
import type { GithubRepoInfo } from '../../../contract/github-page';
import type { GithubTab } from './github-tab-state';
import { fetchedText, repoTitleParts, upstreamText } from './repo-header';
import './github.css';

export interface RepoHeaderProps {
  repo: GithubRepoInfo;
  tab: GithubTab;
  onSelectTab: (tab: GithubTab) => void;
  pullCount: number | null;
  branchCount: number | null;
  fetching: boolean;
  onFetch: () => void;
  onNewPullRequest: () => void;
}

export function RepoHeader({ repo, tab, onSelectTab, pullCount, branchCount, fetching, onFetch, onNewPullRequest }: RepoHeaderProps) {
  const title = repoTitleParts(repo.owner, repo.name);
  const fetched = fetchedText(repo.lastFetchedAt);
  return (
    <div className="gh-header">
      <div className="gh-header__title">
        <div className="gh-header__name">
          <h1 className="gh-header__heading">
            <span className="gh-header__owner">{title.owner}</span>
            <span className="gh-header__repo">{title.name}</span>
          </h1>
          {repo.remoteHost && (
            <span className="gh-header__remote">
              <Icon name="cloud" size={11} />
              {repo.remoteHost} · {repo.remoteName ?? 'origin'}
            </span>
          )}
        </div>
        <div className="gh-header__meta">
          {repo.currentBranch ? (
            <>
              <Icon name="branch" size={12} />
              <span className="gh-header__meta-text">
                {repo.currentBranch} · {upstreamText(repo.upstream)}
                {fetched ? ` · ${fetched}` : ''}
              </span>
            </>
          ) : (
            <span className="gh-header__meta-text gh-header__meta-text--dim">detached HEAD</span>
          )}
        </div>
      </div>

      <span className="gh-header__sp" />

      <TabGroup className="gh-header__tabs" label="GitHub view">
        <Tab selected={tab === 'pulls'} onSelect={() => onSelectTab('pulls')} count={pullCount ?? undefined}>
          Pull requests
        </Tab>
        <Tab selected={tab === 'commits'} onSelect={() => onSelectTab('commits')}>
          Commits
        </Tab>
        <Tab selected={tab === 'branches'} onSelect={() => onSelectTab('branches')} count={branchCount ?? undefined}>
          Branches
        </Tab>
        <Tab selected={false} onSelect={() => {}} title="Coming soon" className="gh-header__tab--disabled">
          Checks
        </Tab>
      </TabGroup>

      <IconButton title="Fetch" onClick={onFetch} disabled={fetching} aria-busy={fetching} className="gh-header__fetch">
        <Icon name="refresh" size={15} />
      </IconButton>

      <Button variant="primary" disabled={!repo.webUrl} onClick={onNewPullRequest}>
        New pull request
      </Button>
    </div>
  );
}
