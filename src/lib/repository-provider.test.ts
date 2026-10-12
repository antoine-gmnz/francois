import { describe, expect, it } from 'vitest';
import { repositoryLabels, newRequestUrl, commitUrl, providerFromRequestUrl, allowedMergeMethods, repositoryUnavailableMessage } from './repository-provider';

describe('repository provider presentation', () => {
  it('keeps legacy GitHub fixtures compatible and distinguishes unknown remotes', () => {
    expect(repositoryLabels(undefined).name).toBe('GitHub');
    expect(repositoryLabels('gitlab')).toMatchObject({ name: 'GitLab', request: 'Merge request', shortRequest: 'MR', cli: 'glab' });
    expect(repositoryLabels('unknown').name).toBe('Repository');
  });
  it('encodes branch names in GitLab new MR URLs for nested private namespaces', () => {
    expect(newRequestUrl({ provider: 'gitlab', webUrl: 'https://gitlab.example/team/sub/project', currentBranch: 'feat/a & b#c' }))
      .toBe('https://gitlab.example/team/sub/project/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fa%20%26%20b%23c');
    expect(newRequestUrl({ webUrl: 'https://github.com/o/r', currentBranch: 'feat/a#b' })).toBe('https://github.com/o/r/compare/feat%2Fa%23b?expand=1');
    expect(newRequestUrl({ provider: 'unknown', webUrl: 'https://example.com/r', currentBranch: 'x' })).toBeNull();
    expect(newRequestUrl({ provider: 'gitlab', webUrl: 'https://gitlab.com/o/r' })).toBeNull();
  });
  it('uses GitLab commit URLs and recognizes MR URLs on private hosts', () => {
    expect(commitUrl({ provider: 'gitlab', webUrl: 'https://host/group/r' }, 'abc')).toBe('https://host/group/r/-/commit/abc');
    expect(commitUrl({ webUrl: 'https://github.com/o/r' }, 'abc')).toBe('https://github.com/o/r/commit/abc');
    expect(providerFromRequestUrl('https://host/g/r/-/merge_requests/3')).toBe('gitlab');
    expect(providerFromRequestUrl('https://github.com/g/r/pull/3')).toBe('github');
  });
  it('never offers rebase as a GitLab merge method or invents methods', () => {
    expect(allowedMergeMethods(['rebase', 'merge', 'squash'], 'gitlab')).toEqual(['merge', 'squash']);
    expect(allowedMergeMethods([], 'gitlab')).toEqual([]);
    expect(allowedMergeMethods(['rebase'], 'github')).toEqual(['rebase']);
  });
  it('names the actual CLI and hostname for authentication and leaves unknown repos locally usable', () => {
    expect(repositoryUnavailableMessage('unauthenticated', 'gitlab', 'gitlab.example')).toContain('glab auth login --hostname gitlab.example');
    expect(repositoryUnavailableMessage('missing', 'gitlab')).toContain('GitLab CLI (glab)');
    expect(repositoryUnavailableMessage('not-github', 'unknown')).toContain('Local commits, branches and worktrees');
  });
});
