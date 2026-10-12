import { useEffect, useState } from 'react';
import type { GithubRepoInfo, GithubRepoInfoResponse } from '../../../contract/github-page';
import { githubRepoInfo } from '../api';
import { useStore } from '../store';

const repos = new Map<string, GithubRepoInfo>();

export function activeRepositoryCwd(): string | null {
  const state = useStore.getState();
  return state.projects.find((project) => project.id === state.activeProjectId)?.root
    ?? state.sessions.find((session) => session.id === state.activeSessionId)?.cwd
    ?? null;
}

export function repositoryInfoForCwd(cwd: string): GithubRepoInfo | null {
  return repos.get(cwd) ?? null;
}

export function activeRepositoryInfo(): GithubRepoInfo | null {
  const cwd = activeRepositoryCwd();
  return cwd ? repos.get(cwd) ?? null : null;
}

export function useActiveRepositoryInfo(): GithubRepoInfo | null {
  const cwd = useStore((state) => state.projects.find((project) => project.id === state.activeProjectId)?.root
    ?? state.sessions.find((session) => session.id === state.activeSessionId)?.cwd
    ?? null);
  return useRepositoryInfo(cwd);
}

export function useRepositoryInfo(cwd: string | null): GithubRepoInfo | null {
  const [loaded, setLoaded] = useState<{ cwd: string; repo: GithubRepoInfo } | null>(null);
  useEffect(() => {
    if (!cwd) return;
    const request = startRepositoryInfoRequest(cwd, repos, () => githubRepoInfo(cwd), (repo) => {
      setLoaded(repo ? { cwd, repo } : null);
    });
    return request.cancel;
  }, [cwd]);
  return loaded?.cwd === cwd ? loaded.repo : null;
}

/** Applies metadata and cache changes only while the request remains active. */
export function startRepositoryInfoRequest(
  cwd: string,
  cache: Map<string, GithubRepoInfo>,
  load: () => Promise<GithubRepoInfoResponse>,
  apply: (repo: GithubRepoInfo | null) => void,
): { cancel: () => void; done: Promise<void> } {
  let current = true;
  const done = (async () => {
    let result: GithubRepoInfoResponse | null;
    try {
      result = await load();
    } catch {
      result = null;
    }
    if (!current) return;
    const repo = result?.ok ? result.data : null;
    if (repo) cache.set(cwd, repo);
    else cache.delete(cwd);
    apply(repo);
  })();
  return { cancel: () => { current = false; }, done };
}
