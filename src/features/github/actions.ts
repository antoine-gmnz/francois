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
import { githubOpenUrl, sessionCreate, sessionSend, sessionWorktreeProbe } from '../../lib/api';
import { parkPrompt, resolvePrompt } from '../conversation/pending-queue';
import { setDraft } from '../conversation/composer-draft';
import { recordSent } from '../conversation/message-history';
import { useStore } from '../../lib/store';

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
 * Send `text` as the new session's first message — the same parked-prompt
 * dance NewTaskDialog uses, so the message shows at once and survives a
 * failed send by falling back to the composer draft.
 */
async function sendFirstMessage(sessionId: SessionId, text: string): Promise<void> {
  const blockId = crypto.randomUUID();
  parkPrompt(sessionId, blockId, text);
  const res = await sessionSend(sessionId, blockId, text).catch(() => null);
  if (res?.ok) {
    recordSent(sessionId, text);
    return;
  }
  resolvePrompt(sessionId, blockId);
  setDraft(sessionId, text);
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
  if (firstMessage) await sendFirstMessage(created.data.id, firstMessage);
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
