// audio-cues FR-1/FR-2/FR-3 — the single trigger source shared by every sink
// (banners in notifications.ts, tones in sound.ts). `DeriveState`,
// `deriveTrigger`, `settleTrigger` and the one module-level `deriveState`
// moved verbatim from notifications.ts; behaviour is unchanged, including the
// two shipped divergences from notifications.md §5: `isBusyStatus(previous)`
// (not `previous === 'running'`) and the settle-out-of-park/starting cases.

import type { BlockId, SessionEvent, SessionId, SessionStatus } from '../../../contract/common';
import { isBusyStatus } from '../../../contract/fleet-board';
import type { NotifyTrigger } from '../../../contract/notifications';
import { isSettleStatus } from '../../../contract/notifications';
import { subscribeSessionEvents } from '../../lib/session-events';

export interface DeriveState {
  lastStatus: Map<SessionId, SessionStatus>;
  seenAsks: Set<BlockId>;
}

/** Shared by the three settle sources (§5): one map, so an ask-then-error pair fires at most once. */
function settleTrigger(sessionId: SessionId, nextStatus: SessionStatus, state: DeriveState): NotifyTrigger | null {
  const previous = state.lastStatus.get(sessionId);
  state.lastStatus.set(sessionId, nextStatus);
  // isBusyStatus, not `=== 'running'`: a turn can settle out of any in-flight
  // status. Interrupting an approval card goes awaiting_approval → idle, and a
  // spawn failure goes starting → error — both are turns the user was waiting
  // on, and both fired no notification while this only recognised `running`.
  if (previous !== undefined && isBusyStatus(previous) && isSettleStatus(nextStatus)) {
    return { class: 'turnDone', kind: 'settle', sessionId, status: nextStatus };
  }
  return null;
}

/**
 * FR-6/FR-14 (notifications) — maps an event to a trigger, mutating `state`.
 * Pure otherwise: gating (whether a sink actually fires) is each sink's own
 * job, not this one's — a muted class must still update
 * `lastStatus`/`seenAsks` so re-enabling it later sees the correct baseline.
 */
export function deriveTrigger(e: SessionEvent, state: DeriveState): NotifyTrigger | null {
  switch (e.type) {
    case 'permission.asked': {
      if (state.seenAsks.has(e.blockId)) return null; // never re-fire a resolved/replayed ask
      state.seenAsks.add(e.blockId);
      return { class: 'attention', kind: 'approval', sessionId: e.sessionId, toolName: e.ask.toolName };
    }
    case 'question.asked': {
      if (state.seenAsks.has(e.blockId)) return null;
      state.seenAsks.add(e.blockId);
      return { class: 'attention', kind: 'question', sessionId: e.sessionId };
    }
    case 'session.status':
      return settleTrigger(e.sessionId, e.status, state);
    case 'session.meta':
      return settleTrigger(e.meta.id, e.meta.status, state);
    case 'session.error':
      return settleTrigger(e.sessionId, 'error', state);
    default:
      return null;
  }
}

// ---------- runtime wiring (FR-2/FR-3): one subscription, many sinks ----------

const deriveState: DeriveState = { lastStatus: new Map(), seenAsks: new Set() };
const sinks: Array<(t: NotifyTrigger) => void> = [];
let subscribed = false;

function handleSessionEvent(e: SessionEvent): void {
  const trigger = deriveTrigger(e, deriveState);
  if (!trigger) return;
  for (const sink of sinks) {
    try {
      sink(trigger);
    } catch {
      /* FR-2: a sink that throws never blocks the others */
    }
  }
}

/**
 * FR-2 — appends a sink, run in registration order on every non-null trigger.
 * FR-22 (transcript-scale): registers as a `'*'` consumer through the one
 * router subscription, exactly once, on the first registration.
 */
export function registerTriggerSink(sink: (t: NotifyTrigger) => void): void {
  sinks.push(sink);
  if (!subscribed) {
    subscribed = true;
    void subscribeSessionEvents('*', handleSessionEvent);
  }
}
