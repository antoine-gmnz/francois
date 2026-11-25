// token-viewer FR-13 — the focused session's context breakdown. Fetches on mount
// and on session change, refetches (refresh: false) when a turn ends, and drops
// any answer that lands after the session it was asked for stopped being focused.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppError, Result, SessionMeta } from '../../../contract/common';
import type { ContextBreakdownResponse } from '../../../contract/token-viewer';
import { sessionContextBreakdown } from '../../lib/api';
import { sessionSupportsContextBreakdown } from '../../lib/runtimeCapability';
import { mergeResponse, turnEnded } from './context-breakdown';

/** Only the most recent request may settle; `cancel` retires the one in flight. */
export function createLatestOnly() {
  let seq = 0;
  return {
    next: () => ++seq,
    isCurrent: (token: number) => token === seq,
    cancel: () => {
      seq += 1;
    },
  };
}

export interface ContextBreakdownState {
  supported: boolean;
  data: ContextBreakdownResponse | null;
  error: AppError | null;
  loading: boolean;
  /** Force a probe (the header figure, the Retry link). */
  refresh: () => void;
}

export interface Slot {
  sessionId: string;
  data: ContextBreakdownResponse | null;
  error: AppError | null;
  loading: boolean;
}

/** A request starts: same session keeps what it shows; another session starts empty. */
export function slotLoading(s: Slot, sessionId: string): Slot {
  return s.sessionId === sessionId ? { ...s, loading: true } : { sessionId, data: null, error: null, loading: true };
}

/** An answer lands. Ignored if the slot moved on; an error keeps the last good data. */
export function slotSettled(s: Slot, sessionId: string, res: Result<ContextBreakdownResponse>): Slot {
  if (s.sessionId !== sessionId) return s;
  return res.ok ? { ...s, data: mergeResponse(s.data, res.data), error: null, loading: false } : { ...s, error: res.error, loading: false };
}

/** A rejected invoke (e.g. a core without the command) reads as unavailable, so the
 *  section falls back to the legacy meter instead of hanging on "Measuring…". */
export function slotFailed(s: Slot, sessionId: string, reason: unknown): Slot {
  if (s.sessionId !== sessionId) return s;
  return { ...s, error: { code: 'CONTEXT_BREAKDOWN_UNAVAILABLE', message: String(reason) }, loading: false };
}

export function useContextBreakdown(session: SessionMeta): ContextBreakdownState {
  const sessionId = session.id;
  const supported = sessionSupportsContextBreakdown(session);
  const [gate] = useState(createLatestOnly);
  const [slot, setSlot] = useState<Slot>({ sessionId, data: null, error: null, loading: false });

  const load = useCallback(
    (refresh: boolean) => {
      const token = gate.next();
      const settle = (apply: (s: Slot) => Slot) => {
        if (gate.isCurrent(token)) setSlot(apply);
      };
      setSlot((s) => slotLoading(s, sessionId));
      sessionContextBreakdown(sessionId, refresh).then(
        (res) => settle((s) => slotSettled(s, sessionId, res)),
        (e: unknown) => settle((s) => slotFailed(s, sessionId, e)),
      );
    },
    [gate, sessionId],
  );

  useEffect(() => {
    if (supported) load(false);
    return gate.cancel;
  }, [gate, load, supported]);

  // Keyed by session so a switch from a running session to an idle one is not read as a turn ending.
  const prevStatus = useRef({ sessionId, status: session.status });
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = { sessionId, status: session.status };
    if (supported && prev.sessionId === sessionId && turnEnded(prev.status, session.status)) load(false);
  }, [load, session.status, sessionId, supported]);

  const current = slot.sessionId === sessionId ? slot : { data: null, error: null, loading: supported };
  return { supported, data: current.data, error: current.error, loading: current.loading, refresh: () => load(true) };
}
