import { describe, expect, it } from 'vitest';
import type { GithubRepoInfo, GithubRepoInfoResponse } from '../../../contract/github-page';
import { startRepositoryInfoRequest } from './useRepositoryInfo';
import { repositoryLabels } from '../repository-provider';

function deferred() {
  let resolve!: (value: GithubRepoInfoResponse) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<GithubRepoInfoResponse>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const repo = (provider?: GithubRepoInfo['provider']): GithubRepoInfo => ({
  root: '/repo', name: 'repo', defaultBranch: 'main', gh: 'ok', upstream: null,
  ...(provider ? { provider } : {}),
});

describe('repository metadata request lifecycle', () => {
  it('discards late scope A metadata after B resolves, including its cache mutation', async () => {
    const cache = new Map<string, GithubRepoInfo>();
    const scopeA = deferred();
    const scopeB = deferred();
    let visible: GithubRepoInfo | null = null;
    const requestA = startRepositoryInfoRequest('A', cache, () => scopeA.promise, data => { visible = data; });
    requestA.cancel();
    const requestB = startRepositoryInfoRequest('B', cache, () => scopeB.promise, data => { visible = data; });
    scopeB.resolve({ ok: true, data: repo('gitlab') });
    await requestB.done;
    scopeA.resolve({ ok: true, data: repo('github') });
    await requestA.done;
    expect(visible).toEqual(repo('gitlab'));
    expect(cache.has('A')).toBe(false);
    expect(cache.get('B')?.provider).toBe('gitlab');
  });

  it('discards old A after A → B → A even when its response arrives last', async () => {
    const cache = new Map<string, GithubRepoInfo>();
    const oldA = deferred();
    const oldB = deferred();
    const newA = deferred();
    const applied: (GithubRepoInfo | null)[] = [];
    const first = startRepositoryInfoRequest('A', cache, () => oldA.promise, data => applied.push(data));
    first.cancel();
    const second = startRepositoryInfoRequest('B', cache, () => oldB.promise, data => applied.push(data));
    second.cancel();
    const third = startRepositoryInfoRequest('A', cache, () => newA.promise, data => applied.push(data));
    newA.resolve({ ok: true, data: repo('gitlab') });
    await third.done;
    oldA.resolve({ ok: true, data: repo('github') });
    oldB.resolve({ ok: false, error: { code: 'GH_FAILED', message: 'Stale failure' } });
    await Promise.all([first.done, second.done]);
    expect(applied).toEqual([repo('gitlab')]);
    expect(cache.get('A')?.provider).toBe('gitlab');
  });

  it.each(['failed Result', 'rejection'])('%s evicts cached metadata and clears current presentation', async kind => {
    const cache = new Map([['A', repo('gitlab')]]);
    const response = deferred();
    const applied: (GithubRepoInfo | null)[] = [];
    const request = startRepositoryInfoRequest('A', cache, () => response.promise, data => applied.push(data));
    if (kind === 'rejection') response.reject(new Error('Transport failed'));
    else response.resolve({ ok: false, error: { code: 'GH_FAILED', message: 'Provider unavailable' } });
    await request.done;
    expect(cache.has('A')).toBe(false);
    expect(applied).toEqual([null]);
  });

  it('does not evict newly loaded A metadata when old A rejects', async () => {
    const cache = new Map<string, GithubRepoInfo>();
    const stale = deferred();
    const first = startRepositoryInfoRequest('A', cache, () => stale.promise, () => { throw new Error('Stale completion'); });
    first.cancel();
    await startRepositoryInfoRequest('A', cache, () => Promise.resolve({ ok: true, data: repo('gitlab') }), () => undefined).done;
    stale.reject(new Error('Old transport error'));
    await first.done;
    expect(cache.get('A')?.provider).toBe('gitlab');
  });

  it('retains absent provider from legacy metadata as GitHub-compatible', async () => {
    const cache = new Map<string, GithubRepoInfo>();
    await startRepositoryInfoRequest('legacy', cache, () => Promise.resolve({ ok: true, data: repo() }), () => undefined).done;
    expect(cache.get('legacy')?.provider).toBeUndefined();
    expect(repositoryLabels(cache.get('legacy')?.provider).name).toBe('GitHub');
  });
});
