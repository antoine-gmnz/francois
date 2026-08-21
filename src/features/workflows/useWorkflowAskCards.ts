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
import type { ConversationBlock, TranscriptPage } from '../../../contract/conversation-view';
import { getTranscript } from '../../lib/api';
import { useHydratedSubscription } from '../../lib/hooks/useHydratedSubscription';
import { subscribeSessionEvents } from '../../lib/session-events';
import {
  applySessionEvent,
  RENDER_WINDOW,
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
  setHasMore: () => {},
};

/** blockId → the block the existing approval/question card renders. */
export function useWorkflowAskCards(sessionId: string, enabled: boolean): Map<string, ConversationBlock> {
  const [state, dispatch] = useReducer(transcriptReducer, { blocks: [], windowSize: RENDER_WINDOW });

  // transcript-scale FR-10: correct against the tail alone (no paging here) —
  // FR-2 pins every unresolved ask into the core's held buffer, so the plain
  // tail `getTranscript` resolves is never missing a pending card.
  // FR-21: through the one router subscription, scoped to this session.
  useHydratedSubscription<SessionEvent, TranscriptPage>({
    enabled,
    subscribe: (cb) => subscribeSessionEvents(sessionId, cb),
    fetchInitial: () => getTranscript(sessionId),
    isRelevant: () => true,
    onHydrated: (page) => dispatch({ t: 'seed', blocks: page.blocks }),
    onEvent: (e) => applySessionEvent(dispatch, IGNORED_SETTERS, e),
    onError: () => {}, // FR-10: fail soft — no card rather than an error surface
    deps: [sessionId, enabled],
  });

  return useMemo(() => new Map(state.blocks.map((b) => [b.blockId, b])), [state.blocks]);
}
