// github-page: the shared session/browser actions every GitHub tab reaches
// for — PullsTab, CommitsTab and BranchesTab alike. Kept here, framework-free
// aside from the store import, so all three tabs (built by different agents)
// import the exact same behaviour rather than three near-identical copies.
//
// "Open a session on this branch" (FR-5/FR-10) reuses the session-worktree /
// attach-to-worktree machinery exactly as the New task dialog's worktree card
// does: `sessionWorktreeProbe` finds out whether the branch already has a
// worktree — attach (adopt) when it does, create one inline via
// `session_create`'s own `worktree` option when it doesn't. Never shells out
// to `github_create_worktree` for this path — that command exists for the
// Branches table's standalone "+ Create" action (FR-10), where no session is
// being spawned at all.

import type { SessionId, SessionMeta } from '../../../contract/common';
import type { CheckRun } from '../../../contract/github-page';
import { githubGetJob, githubGetStepLog, githubOpenUrl, sessionCreate, sessionWorktreeProbe } from '../../lib/api';
import { sendPrompt } from '../../lib/send-prompt';
import { useStore } from '../../lib/store';
import { failureExcerpt, firstFailedStep } from './ci-logs';

/** Select `id` and switch the main pane to its SESSION view (FR-5's "Where
 *  this came from" card, FR-8's "Continue this session", FR-10's roster ⋯
 *  "Open session"). */
export function openSession(id: SessionId): void {
  const st = useStore.getState();
  st.setFocusedPane('main');
  st.setActiveSessionId(id);
  st.setMainTab('session');
}

/**
 * FR-5/FR-10: open a session on `branch`. Attaches to the branch's existing
 * worktree when one is already checked out (adopt, per attach-to-worktree
 * FR-14 — `branch`/`baseRef` sent as `''` and ignored); otherwise creates one
 * inline via `session_create`'s own `worktree` option, based off the repo's
 * default branch. Selects the new session and, when `firstMessage` is given
 * (FR-6's "Fix in a new session"), sends it as the first turn.
 *
 * Returns the created `SessionMeta`, or `null` on any failure — callers
 * surface the failure themselves (there is no shared toast channel here).
 */
export async function startSessionOnBranch(cwd: string, branch: string, firstMessage?: string): Promise<SessionMeta | null> {
  const probe = await sessionWorktreeProbe({ cwd, branch });
  if (!probe.ok || !probe.data.isRepo) return null;

  const worktreePath = probe.data.branchCheckedOutAt;
  const created = worktreePath
    ? await sessionCreate({
        cwd: worktreePath,
        name: branch,
        worktree: { branch: '', baseRef: '', adopt: true },
      })
    : await sessionCreate({
        cwd,
        name: branch,
        worktree: { branch, baseRef: probe.data.defaultBranch ?? branch, adopt: false },
      });
  if (!created.ok) return null;

  openSession(created.data.id);
  if (firstMessage) await sendPrompt(created.data.id, firstMessage);
  return created.data;
}

/**
 * FR-8's "Start a session from this commit": a new worktree session rooted at
 * `sha` rather than at a branch tip. Git has no way to check out a detached
 * worktree via `session_create`'s `WorktreeCreateOptions` (`branch` is
 * required, non-empty) — so this mints a local branch named after the short
 * sha and bases the new worktree there, exactly what "based at the commit"
 * means for a session that is going to keep committing.
 */
export async function startSessionAtCommit(cwd: string, sha: string): Promise<SessionMeta | null> {
  const shortSha = sha.slice(0, 7);
  const branch = `wt/${shortSha}`;
  const created = await sessionCreate({
    cwd,
    name: shortSha,
    worktree: { branch, baseRef: sha, adopt: false },
  });
  return created.ok ? created.data : null;
}

/** FR-5/FR-8/FR-9/FR-10: every "Open on GitHub" ghost button and the
 *  toolbar's "New pull request" — routed through the core so only an
 *  `https://` URL on the repo's own remote host is ever opened (github_open_url
 *  refuses anything else with INVALID_INPUT). Callers that don't need the
 *  result can fire-and-forget this. */
export async function openOnGithub(cwd: string, url: string): Promise<void> {
  await githubOpenUrl({ cwd, url });
}

const FIX_EXCERPT_BUDGET_MS = 5_000;
const FIX_EXCERPT_MAX_JOBS = 3;
const FIX_EXCERPT_MAX_LINES_PER_JOB = 60;
const FIX_EXCERPT_MAX_TOTAL_LINES = 150;

/**
 * github-ci-logs FR-15: appends up to 3 failed jobs' failure excerpts to the
 * base "fix the failing checks" sentence, `<job> › <step>:` followed by a
 * fenced block of `failureExcerpt()`, capped at 150 lines total across jobs.
 * Best-effort within a 5s budget — a job whose getJob/getStepLog call fails,
 * times out, or has no failed step / Actions job id is silently skipped, and
 * with nothing gathered the base sentence is returned unchanged.
 */
export async function fixFailingChecksMessage(cwd: string, baseSentence: string, checkRuns: CheckRun[]): Promise<string> {
  const failedJobs = checkRuns.filter((c) => c.state === 'failed' && c.jobId !== undefined).slice(0, FIX_EXCERPT_MAX_JOBS);
  if (failedJobs.length === 0) return baseSentence;

  const deadline = Date.now() + FIX_EXCERPT_BUDGET_MS;
  const sections: string[] = [];
  let linesLeft = FIX_EXCERPT_MAX_TOTAL_LINES;

  for (const check of failedJobs) {
    if (Date.now() >= deadline || linesLeft <= 0) break;
    const jobRes = await githubGetJob({ cwd, jobId: check.jobId! });
    if (!jobRes.ok || Date.now() >= deadline) continue;
    const failedStep = firstFailedStep(jobRes.data);
    if (!failedStep) continue;
    const logRes = await githubGetStepLog({ cwd, jobId: check.jobId!, stepNumber: failedStep.number });
    if (!logRes.ok) continue;
    const excerpt = failureExcerpt(logRes.data, FIX_EXCERPT_MAX_LINES_PER_JOB);
    if (!excerpt) continue;
    const excerptLines = excerpt.split('\n').slice(0, linesLeft);
    if (excerptLines.length === 0) continue;
    linesLeft -= excerptLines.length;
    sections.push(`\`${jobRes.data.name} › ${failedStep.name}\`:\n\`\`\`\n${excerptLines.join('\n')}\n\`\`\``);
  }

  return sections.length > 0 ? `${baseSentence}\n\n${sections.join('\n\n')}` : baseSentence;
}
