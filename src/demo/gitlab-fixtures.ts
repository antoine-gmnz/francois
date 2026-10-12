import type { CheckJob, CheckRun, CommitDetail, GithubRepoInfo, PullSummary, StepLog } from '../../contract/github-page';
import { githubStepLogFor } from './github-fixtures';

const REPO_URL = 'https://gitlab.example.com/team/platform/orbit';

export function gitlabRepo(repo: GithubRepoInfo): GithubRepoInfo {
  return { ...repo, provider: 'gitlab', owner: 'team/platform', remoteHost: 'gitlab.example.com', webUrl: REPO_URL, currentBranch: 'auth-retry' };
}

export function gitlabChecks(checks: CheckRun[]): CheckRun[] {
  return checks.map(check => ({ ...check, detailsUrl: check.jobId ? `${REPO_URL}/-/jobs/${check.jobId}` : `${REPO_URL}/-/pipelines/${check.runId ?? 9200}` }));
}

export function gitlabPull<T extends PullSummary>(pull: T): T {
  return {
    ...pull,
    url: `${REPO_URL}/-/merge_requests/${pull.number}`,
    ...('mergeMethods' in pull ? { mergeMethods: ['squash', 'merge'] } : {}),
    ...('checkRuns' in pull ? { checkRuns: gitlabChecks(pull.checkRuns as CheckRun[]) } : {}),
    ...('comments' in pull ? { comments: (pull.comments as { url: string }[]).map(comment => ({ ...comment, url: `${REPO_URL}/-/merge_requests/${pull.number}#notes` })) } : {}),
  };
}

export function gitlabCommit(commit: CommitDetail): CommitDetail {
  return { ...commit, checkRuns: commit.checkRuns ? gitlabChecks(commit.checkRuns) : undefined };
}

export function gitlabJob(job: CheckJob): CheckJob {
  return {
    ...job,
    workflowName: 'Pipeline',
    htmlUrl: `${REPO_URL}/-/jobs/${job.jobId}`,
    steps: [{ number: 1, name: 'Job log', state: job.state === 'pending' ? 'running' : job.state }],
  };
}

export function gitlabLog(jobId: number, stepNumber: number): StepLog | undefined {
  if (stepNumber !== 0 && stepNumber !== 1) return undefined;
  const lines = [1, 2, 3, 4].flatMap(number => githubStepLogFor(jobId, number)?.lines ?? [])
    .map((line, index) => ({ ...line, n: index + 1 }));
  if (lines.length === 0) return undefined;
  return { jobId, stepNumber, lines, totalLines: lines.length, droppedLines: 0, firstErrorLine: lines.find(line => line.kind === 'error')?.n };
}
