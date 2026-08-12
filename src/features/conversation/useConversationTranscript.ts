// Hydration + live SessionEvent subscription for the SESSION tab
// (conversation-view FR-8/9/10). Extracted from ConversationView so the
// component body is JSX + a thin composer; this hook owns the transcript
// reducer, the hydration/pin state that follows it, and the slash-menu
// registry hydration that piggybacks on the same session.commands events.

import { useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react';
import type { ConversationBlock } from '../../../contract/conversation-view';
import type { SessionEvent, SessionStatus, SlashCommandInfo } from '../../../contract/common';
import { getTranscript, onSessionEvent, sessionListCommands } from '../../lib/api';
import { useHydratedSubscription } from '../../lib/hooks/useHydratedSubscription';
import { useStore } from '../../lib/store';
import { getSessionCommands, setSessionCommands } from '../commands/slash-menu';
import {
  applySessionEvent,
  transcriptReducer,
  type ConversationEventSetters,
  type TranscriptAction,
  type TranscriptState,
} from './conversation-blocks';

function eventSessionId(e: SessionEvent): string | null {
  if (e.type === 'session.meta') return e.meta.id;
  if ('sessionId' in e) return e.sessionId;
  return null;
}

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
}

export function useConversationTranscript(sessionId: string): ConversationTranscript {
  const [state, dispatch] = useReducer(transcriptReducer, { blocks: [] });
  const [hydrated, setHydrated] = useState(false);
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
  };

  // Hydration + live events (FR-8/9/10). Component is keyed by sessionId in the
  // parent, so this runs fresh per session; a stale getTranscript after unmount
  // is discarded via useHydratedSubscription's own mounted guard (FR-9).
  useHydratedSubscription<SessionEvent, ConversationBlock[]>({
    enabled: true,
    subscribe: (cb) =>
      onSessionEvent((e) => {
        // slash-menu edge 7: cache the registry for EVERY session (no UI effect
        // for non-visible ones — they re-seed from this cache when shown).
        if (e.type === 'session.commands') setSessionCommands(e.sessionId, e.commands);
        cb(e);
      }),
    fetchInitial: () => getTranscript(sessionId),
    isRelevant: (e) => eventSessionId(e) === sessionId,
    onHydrated: (blocks) => {
      dispatch({ t: 'seed', blocks });
      setHydrated(true);
      setPinned(true);
    },
    onEvent: (e) => applySessionEvent(dispatch, eventSetters, e),
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

  // Scroll-to-bottom while pinned (FR-17/18).
  useLayoutEffect(() => {
    if (pinnedRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state.blocks, hydrated]);

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
  };
}
