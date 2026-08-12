// workflow-details FR-25/FR-26 — the payloads behind a run's attributed asks.
//
// This feature's `WorkflowPendingAsk` is CORRELATION ONLY: it carries a
// `blockId` and nothing else the card needs (spec §5). The card's content lives
// exactly where it already lives — in the parent session's transcript, as the
// `permission` / `question` ConversationBlock that `permission-guardrails` and
// `session-questions` already emit. So the tab reads that transcript through the
// SAME reducer the SESSION tab uses (`transcriptReducer` + `applySessionEvent`)
// and looks the blocks up by id. No second source of truth, no second decision
// channel: the card rendered here IS the SESSION tab's card, and answering it
// calls the same command (FR-26).
//
// Gated on `enabled` so a run with nothing blocking never fetches a transcript.

import { useMemo, useReducer } from 'react';
import type { SessionEvent } from '../../../contract/common';
import type { ConversationBlock } from '../../../contract/conversation-view';
import { getTranscript, onSessionEvent } from '../../lib/api';
import { useHydratedSubscription } from '../../lib/hooks/useHydratedSubscription';
import {
  applySessionEvent,
  transcriptReducer,
  type ConversationEventSetters,
} from '../conversation/conversation-blocks';

/** The tab renders cards only — none of the SESSION tab's chrome state applies. */
const IGNORED_SETTERS: ConversationEventSetters = {
  setStatus: () => {},
  setErrorMessage: () => {},
  setResumeFailed: () => {},
  setLimitNotice: () => {},
  setPinned: () => {},
  setCommands: () => {},
  patchUsage: () => {},
};

function eventSessionId(e: SessionEvent): string | null {
  if (e.type === 'session.meta') return e.meta.id;
  if ('sessionId' in e) return e.sessionId;
  return null;
}

/** blockId → the block the existing approval/question card renders. */
export function useWorkflowAskCards(sessionId: string, enabled: boolean): Map<string, ConversationBlock> {
  const [state, dispatch] = useReducer(transcriptReducer, { blocks: [] });

  useHydratedSubscription<SessionEvent, ConversationBlock[]>({
    enabled,
    subscribe: onSessionEvent,
    fetchInitial: () => getTranscript(sessionId),
    isRelevant: (e) => eventSessionId(e) === sessionId,
    onHydrated: (blocks) => dispatch({ t: 'seed', blocks }),
    onEvent: (e) => applySessionEvent(dispatch, IGNORED_SETTERS, e),
    onError: () => {}, // FR-10: fail soft — no card rather than an error surface
    deps: [sessionId, enabled],
  });

  return useMemo(() => new Map(state.blocks.map((b) => [b.blockId, b])), [state.blocks]);
}
