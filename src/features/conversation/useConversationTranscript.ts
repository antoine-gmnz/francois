// Hydration + live SessionEvent subscription for the SESSION tab
// (conversation-view FR-8/9/10). Extracted from ConversationView so the
// component body is JSX + a thin composer; this hook owns the transcript
// reducer, the hydration/pin state that follows it, and the slash-menu
// registry hydration that piggybacks on the same session.commands events.

import { useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react';
import type { TranscriptPage } from '../../../contract/conversation-view';
import type { SessionEvent, SessionStatus, SlashCommandInfo } from '../../../contract/common';
import { getTranscript, sessionListCommands } from '../../lib/api';
import { useHydratedSubscription } from '../../lib/hooks/useHydratedSubscription';
import { subscribeSessionEvents } from '../../lib/session-events';
import { useStore } from '../../lib/store';
import { getSessionCommands, setSessionCommands } from '../commands/slash-menu';
import {
  applySessionEvent,
  decideEarlierActivation,
  drainDeltas,
  earlierRowState,
  isTranscriptRelevantEvent,
  pushDelta,
  RENDER_WINDOW,
  transcriptReducer,
  type ConversationEventSetters,
  type DeltaChunk,
  type EarlierRowState,
  type TranscriptAction,
  type TranscriptState,
} from './conversation-blocks';

export interface ConversationTranscript {
  state: TranscriptState;
  dispatch: (action: TranscriptAction) => void;
  hydrated: boolean;
  hydrationError: string | null;
  status: SessionStatus;
  errorMessage: string | undefined;
  resumeFailed: boolean;
  dismissResumeFailed: () => void;
  /** The raw `USAGE_LIMIT` message behind the plan-limit banner, or null. */
  limitNotice: string | null;
  dismissLimitNotice: () => void;
  commands: SlashCommandInfo[];
  setCommands: (commands: SlashCommandInfo[]) => void;
  isPinned: boolean;
  setPinned: (value: boolean) => void;
  scrollRef: RefObject<HTMLDivElement>;
  onScroll: () => void;
  jumpToLatest: () => void;
  /** transcript-scale FR-12: the earlier-blocks row's visibility + count. */
  earlierRow: EarlierRowState;
  /** transcript-scale FR-13: activate the earlier-blocks row. */
  activateEarlier: () => void;
}

export function useConversationTranscript(sessionId: string): ConversationTranscript {
  const [state, dispatch] = useReducer(transcriptReducer, { blocks: [], windowSize: RENDER_WINDOW });
  const [hydrated, setHydrated] = useState(false);
  // transcript-scale FR-6/FR-7: whether older blocks exist beyond what the
  // reducer holds — hook state beside `hydrated` (spec §6), updated by every
  // page (initial hydration and each "earlier" fetch).
  const [hasMore, setHasMore] = useState(false);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  // Read once at mount (matches the original `useState(meta?.status ?? 'idle')`
  // initializer, which also only ever applied meta's value once).
  const [status, setStatus] = useState<SessionStatus>(
    () => useStore.getState().sessions.find((session) => session.id === sessionId)?.status ?? 'idle',
  );
  const [errorMessage, setErrorMessage] = useState<string | undefined>(
    () => useStore.getState().sessions.find((session) => session.id === sessionId)?.errorMessage,
  );
  const [isPinned, setPinned] = useState(true);
  const [resumeFailed, setResumeFailed] = useState(false); // durable-sessions FR-14 banner
  // The plan-limit banner. Session-scoped like the one above (the keyed remount
  // clears it), and cleared by the next user turn — the limit either lifted, in
  // which case the turn runs, or it did not and a fresh notice replaces this one.
  const [limitNotice, setLimitNotice] = useState<string | null>(null);

  // slash-menu popup state (spec §6): registry mirror for THIS session
  // (cache-seeded, FR-10). Component-local — a session switch remounts (keyed
  // by sessionId) and clears it.
  const [commands, setCommands] = useState<SlashCommandInfo[]>(() => getSessionCommands(sessionId));

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  pinnedRef.current = isPinned;

  const eventSetters: ConversationEventSetters = {
    setStatus,
    setErrorMessage,
    setResumeFailed,
    setLimitNotice,
    setPinned,
    setCommands,
    patchUsage: (usedTokens, limitTokens) => useStore.getState().patchUsage(sessionId, usedTokens, limitTokens),
    setHasMore,
  };

  // transcript-scale FR-13: gates "two rapid activations" (edge case §7) and
  // the mounted guard for a page that resolves after a session switch (§7 —
  // "discarded by the existing mounted guard"). Both refs, not state: neither
  // should itself trigger a render.
  const fetchingRef = useRef(false);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, [sessionId]);
  // FR-14: the scrollHeight captured just before a prepend/expand mutates
  // `state.blocks`, so the layout effect below can correct scrollTop by the
  // exact delta instead of re-pinning or jumping.
  const pendingScrollHeightRef = useRef<number | null>(null);

  const activateEarlier = () => {
    const decision = decideEarlierActivation(state, hasMore, fetchingRef.current);
    if (decision.kind === 'expand') {
      if (scrollRef.current) pendingScrollHeightRef.current = scrollRef.current.scrollHeight;
      dispatch({ t: 'expandWindow' });
    } else if (decision.kind === 'fetch') {
      fetchingRef.current = true;
      void getTranscript(sessionId, { before: decision.before }).then((res) => {
        fetchingRef.current = false;
        if (!liveRef.current || !res.ok) return;
        if (scrollRef.current) pendingScrollHeightRef.current = scrollRef.current.scrollHeight;
        dispatch({ t: 'prepend', blocks: res.data.blocks });
        setHasMore(res.data.hasMore);
      });
    }
  };

  // transcript-perf FR-5..9: the rAF delta coalescer. Ref-held (never state,
  // spec §6) so buffering itself never triggers a render; a burst of
  // `assistant.delta` events inside one animation frame merges into ONE
  // `deltaBatch` dispatch per blockId (arrival order preserved — see
  // pushDelta/drainDeltas), so the existing scroll-pin effect below (keyed on
  // `state.blocks`) writes `scrollTop` at most once per flush too (FR-8).
  const deltaBufferRef = useRef<Map<string, DeltaChunk[]>>(new Map());
  const rafRef = useRef<number | null>(null);

  const flushDeltas = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    for (const action of drainDeltas(deltaBufferRef.current)) dispatch(action);
  };

  const onTranscriptEvent = (e: SessionEvent) => {
    if (e.type === 'assistant.delta') {
      pushDelta(deltaBufferRef.current, e.blockId, e.text, e.offset);
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushDeltas);
      }
      return;
    }
    // FR-6: any non-delta event flushes the pending buffer BEFORE it applies,
    // so a delta can never be reordered behind a tool.start/assistant.done/card.
    flushDeltas();
    applySessionEvent(dispatch, eventSetters, e);
  };

  // FR-7: a pending delta is never dropped on unmount or session switch —
  // both tear down this same [sessionId]-keyed effect.
  useEffect(() => () => flushDeltas(), [sessionId]);

  // Hydration + live events (FR-8/9/10). Component is keyed by sessionId in the
  // parent, so this runs fresh per session; a stale getTranscript after unmount
  // is discarded via useHydratedSubscription's own mounted guard (FR-9).
  useHydratedSubscription<SessionEvent, TranscriptPage>({
    enabled: true,
    // transcript-scale FR-21: through the one router subscription, scoped to
    // this session — the router already guarantees relevance, so isRelevant
    // below is trivially true.
    subscribe: (cb) =>
      subscribeSessionEvents(sessionId, (e) => {
        // slash-menu edge 7: cache the registry for EVERY session (no UI effect
        // for non-visible ones — they re-seed from this cache when shown).
        if (e.type === 'session.commands') setSessionCommands(e.sessionId, e.commands);
        cb(e);
      }),
    fetchInitial: () => getTranscript(sessionId),
    // transcript-scale FR-21 regression fix: agent.update/workflow.update carry
    // no sessionId, so the router (session-events.ts) broadcasts them to every
    // session — filter them out here rather than let them reach
    // onTranscriptEvent, which would force-flush this session's rAF-coalesced
    // deltas for another session's subagent/workflow update.
    isRelevant: isTranscriptRelevantEvent,
    onHydrated: (page) => {
      dispatch({ t: 'seed', blocks: page.blocks });
      setHydrated(true);
      setPinned(true);
      setHasMore(page.hasMore); // transcript-scale FR-6
    },
    onEvent: onTranscriptEvent,
    onError: (message) => setHydrationError(message),
    deps: [sessionId],
  });

  // slash-menu FR-10: seed the registry on mount / session switch (the keyed
  // remount makes both the same path). The cache gave an instant value above;
  // listCommands refreshes it. Errors keep whatever the cache had.
  useEffect(() => {
    let mounted = true;
    void sessionListCommands(sessionId).then((res) => {
      if (!mounted || !res.ok) return;
      setSessionCommands(sessionId, res.data);
      setCommands(res.data);
    });
    return () => {
      mounted = false;
    };
  }, [sessionId]);

  // FR-14: preserve the reading position across an "earlier" expansion — the
  // element at the top of the viewport stays there. Takes priority over the
  // pin-to-bottom effect below (an expansion never sets isPinned and never
  // scrolls to the bottom — decideEarlierActivation/activateEarlier never fire
  // while the user is pinned to a live tail, so the two never race in practice).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const before = pendingScrollHeightRef.current;
    if (before !== null && el) {
      pendingScrollHeightRef.current = null;
      el.scrollTop += el.scrollHeight - before;
      return;
    }
    if (pinnedRef.current && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.blocks, state.windowSize, hydrated]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist > 32 && pinnedRef.current) setPinned(false); // FR-19
    // Scrolling back within the same band re-pins — the "jump to latest" chip
    // must clear on a manual return to the bottom, not only via its own click.
    else if (dist <= 32 && !pinnedRef.current) setPinned(true);
  };

  const jumpToLatest = () => {
    setPinned(true);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  };

  return {
    state,
    dispatch,
    hydrated,
    hydrationError,
    status,
    errorMessage,
    resumeFailed,
    dismissResumeFailed: () => setResumeFailed(false),
    limitNotice,
    dismissLimitNotice: () => setLimitNotice(null),
    commands,
    setCommands,
    isPinned,
    setPinned,
    scrollRef,
    onScroll,
    jumpToLatest,
    earlierRow: earlierRowState(state, hasMore),
    activateEarlier,
  };
}
