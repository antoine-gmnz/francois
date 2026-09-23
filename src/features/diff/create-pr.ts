// "Create PR" — the Changes panel footer's second action (Figma "Session panel"
// 130:378, Tab=Changes) and its palette twin. It hands the job to the agent as an
// ordinary turn rather than running git itself: the agent already knows what it
// changed and why, so it writes the commit message and the PR description, and
// it can recover from a missing branch, a rejected push or a missing `gh` login
// where a fixed command sequence would just fail.

import type { SessionId, SessionMeta } from '../../../contract/common';
import { isBusyStatus } from '../../../contract/fleet-board';
import { sessionIsRetired } from '../../lib/runtimeCapability';
import { sendPrompt } from '../../lib/send-prompt';

export const CREATE_PR_PROMPT = [
  'Open a pull request for the work in this session.',
  '',
  "1. If we're on the repository's default branch, create a feature branch first.",
  '2. Commit any uncommitted changes that belong to this work, with a conventional commit message.',
  '3. Push the branch to the remote.',
  '4. Create the pull request against the default branch with `gh pr create`: a concise title, and a description that summarises what changed and why, and how it was tested.',
  '',
  'Reply with the PR URL. If a pull request already exists for this branch, update it instead of opening another.',
].join('\n');

export interface CreatePrAvailability {
  available: boolean;
  reason?: string;
}

/** Whether "Create PR" can go now — a busy session would queue the turn behind the current one. */
export function createPrAvailability(meta: Pick<SessionMeta, 'status' | 'agentRuntime'> | null | undefined): CreatePrAvailability {
  if (!meta) return { available: false, reason: 'Select a session first.' };
  if (sessionIsRetired(meta)) return { available: false, reason: 'This session no longer accepts turns.' };
  if (isBusyStatus(meta.status)) return { available: false, reason: 'Wait for the current turn to finish.' };
  return { available: true };
}

/** Ask the session's agent to commit, push and open the PR. Resolves `true` once the turn is sent. */
export function requestCreatePr(sessionId: SessionId): Promise<boolean> {
  return sendPrompt(sessionId, CREATE_PR_PROMPT);
}
