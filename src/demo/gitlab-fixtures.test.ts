import { expect, it } from 'vitest';
import { gitlabRepo, gitlabPull, gitlabJob, gitlabLog } from './gitlab-fixtures';
import { GITHUB_REPO, GITHUB_PULL_DETAILS, githubJobById } from './github-fixtures';

it('previews GitLab in a nested namespace without mutating GitHub fixtures', () => {
  expect(gitlabRepo(GITHUB_REPO)).toMatchObject({ provider: 'gitlab', remoteHost: 'gitlab.example.com', owner: 'team/platform' });
  const mr = gitlabPull(GITHUB_PULL_DETAILS[128]);
  expect(mr.url).toContain('/team/platform/orbit/-/merge_requests/128');
  expect(mr.mergeMethods).not.toContain('rebase');
  expect(GITHUB_PULL_DETAILS[128].url).toContain('github.com');
});
it('offers a single job log with actual trace content and no invented step timings', () => {
  const job = gitlabJob(githubJobById(5102)!);
  expect(job.steps).toEqual([{ number: 1, name: 'Job log', state: 'failed' }]);
  expect(job.htmlUrl).toContain('/-/jobs/5102');
  expect(gitlabLog(5102, 1)?.lines.some(line => line.kind === 'error')).toBe(true);
  expect(gitlabLog(5102, 0)?.stepNumber).toBe(0);
  expect(gitlabLog(5102, 2)).toBeUndefined();
});
