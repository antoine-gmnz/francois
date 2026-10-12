// gitlab-integration: existing github_* IPC names remain stable and dispatch
// by repository provider. All requests/results reuse github-page.ts.
export type RepositoryProvider = 'github' | 'gitlab' | 'unknown';
export type { GithubRepoInfo } from './github-page';
