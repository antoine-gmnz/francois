// Send a prompt to a session on the user's behalf — the parked-prompt dance the
// composer does, for buttons that speak for the user (NewTaskDialog's first
// message, the GitHub page's "Fix in a new session", the Changes panel's
// "Create PR"). The message shows in the transcript at once, and a failed send
// falls back to the composer draft so the words are never lost.

import type { SessionId } from '../../contract/common';
import { sessionSend } from './api';
import { setDraft } from './composer-draft';
import { recordSent } from './message-history';
import { parkPrompt, resolvePrompt } from './pending-queue';

/** Resolves `true` when the core accepted the turn (sent or queued). */
export async function sendPrompt(sessionId: SessionId, text: string): Promise<boolean> {
  const blockId = crypto.randomUUID();
  parkPrompt(sessionId, blockId, text);
  const res = await sessionSend(sessionId, blockId, text).catch(() => null);
  if (res?.ok) {
    recordSent(sessionId, text);
    return true;
  }
  resolvePrompt(sessionId, blockId);
  setDraft(sessionId, text);
  return false;
}
