import type { GithubRepoInfo, GhStatus, MergeMethod } from '../../contract/github-page';
import type { RepositoryProvider } from '../../contract/gitlab-integration';

export function repositoryLabels(provider: RepositoryProvider = 'github') {
  return {
    name: provider === 'gitlab' ? 'GitLab' : provider === 'unknown' ? 'Repository' : 'GitHub',
    request: provider === 'gitlab' ? 'Merge request' : 'Pull request',
    requests: provider === 'gitlab' ? 'Merge requests' : 'Pull requests',
    shortRequest: provider === 'gitlab' ? 'MR' : 'PR',
    cli: provider === 'gitlab' ? 'glab' : 'gh',
    ci: provider === 'gitlab' ? 'CI' : 'Checks',
  };
}

export function providerFromRequestUrl(url: string = ''): RepositoryProvider {
  return url.includes('/-/merge_requests/') ? 'gitlab' : 'github';
}

export function newRequestUrl(repo: Pick<GithubRepoInfo, 'provider' | 'webUrl' | 'currentBranch'>): string | null {
  if (!repo.webUrl || !repo.currentBranch || repo.provider === 'unknown') return null;
  const branch = encodeURIComponent(repo.currentBranch);
  return repo.provider === 'gitlab'
    ? `${repo.webUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${branch}`
    : `${repo.webUrl}/compare/${branch}?expand=1`;
}

export function commitUrl(repo: Pick<GithubRepoInfo, 'provider' | 'webUrl'>, sha: string): string | null {
  if (!repo.webUrl || repo.provider === 'unknown') return null;
  return `${repo.webUrl}/${repo.provider === 'gitlab' ? '-/' : ''}commit/${encodeURIComponent(sha)}`;
}

export function allowedMergeMethods(methods: MergeMethod[], provider: RepositoryProvider = 'github'): MergeMethod[] {
  return provider === 'gitlab' ? methods.filter((method) => method !== 'rebase') : methods;
}

export function repositoryUnavailableMessage(status: GhStatus, provider: RepositoryProvider = 'github', host?: string): string {
  const labels = repositoryLabels(provider);
  if (provider === 'unknown') return 'This remote is not a recognized GitHub or GitLab repository. Local commits, branches and worktrees remain available.';
  if (status === 'missing') return `Install the ${labels.name} CLI (${labels.cli}) to see ${labels.requests.toLowerCase()}.`;
  if (status === 'unauthenticated') return `Run \`${labels.cli} auth login${host ? ` --hostname ${host}` : ''}\` to see ${labels.requests.toLowerCase()}.`;
  if (status === 'not-github') return `This repository's remote isn't on ${labels.name}.`;
  return '';
}
