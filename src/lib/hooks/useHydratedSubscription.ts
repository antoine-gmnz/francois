// Shared "mount → subscribe → buffer pre-hydration events → fetch the initial
// state → drain the buffer → process events live → unlisten on unmount" shape
// (REFACTOR.md audit, the highest-value duplication — ~300 lines across four
// panels). This module covers three of them faithfully:
//
//  - ConversationView (FR-8/9/10): every event is buffered until `getTranscript`
//    resolves, then drained in arrival order before live events apply directly.
//  - AgentsPanel (FR-1/2/3): `agent.update` buffers pre-hydration exactly like
//    ConversationView; `agent.step` never buffers — it always applies live,
//    hydrated or not (`shouldBuffer` lets a caller opt specific event *kinds*
//    out of buffering, matching this exactly).
//  - SkillsPanel: never buffers at all (`shouldBuffer: () => false`) — every
//    `skills.changed` triggers an immediate refetch regardless of hydration,
//    which is what its current `refetch()`-on-every-event code already does.
//
// DiffView is deliberately NOT modeled here. Its shape is structurally
// different: it subscribes *before* the first `diff_get_summary` call
// specifically so that call's own echo can be counted and swallowed
// (`pendingEchoRef`), and coalesces concurrent external refreshes into one
// trailing re-run (`refreshQueuedRef`/`summaryInFlightRef`) rather than
// buffering raw events to drain later. Forcing it through a buffer-then-drain
// abstraction would either drop that echo/coalescing behaviour or bolt an
// unrelated mechanism onto this one — a worse fit than leaving it alone.
//
// `initHydrationBuffer`/`routeIncoming`/`hydrateBuffer` are the pure engine
// (framework-free, fully covered by tests below); `useHydratedSubscription` is
// the imperative `useEffect` wrapper most call sites will actually use.

import { useEffect, type DependencyList } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { Result } from '../../../contract/common';

/** Buffer state for one subscription lifetime. */
export interface HydrationBuffer<E> {
  hydrated: boolean;
  buffer: E[];
}

export function initHydrationBuffer<E>(): HydrationBuffer<E> {
  return { hydrated: false, buffer: [] };
}

/**
 * Routes one incoming event: pre-hydration, a bufferable event queues (FIFO)
 * instead of applying; an already-hydrated state, or an event `shouldBuffer`
 * excludes (default: buffer everything), applies immediately. Never mutates
 * `state`.
 */
export function routeIncoming<E>(
  state: HydrationBuffer<E>,
  event: E,
  shouldBuffer: (e: E) => boolean = () => true,
): { next: HydrationBuffer<E>; applyNow: boolean } {
  if (!state.hydrated && shouldBuffer(event)) {
    return { next: { hydrated: state.hydrated, buffer: [...state.buffer, event] }, applyNow: false };
  }
  return { next: state, applyNow: true };
}

/** Marks hydrated and returns the buffered events to drain in arrival order, clearing the buffer. */
export function hydrateBuffer<E>(state: HydrationBuffer<E>): { next: HydrationBuffer<E>; drained: E[] } {
  return { next: { hydrated: true, buffer: [] }, drained: state.buffer };
}

export interface UseHydratedSubscriptionOptions<E, D> {
  /** Gate — mirrors every `if (!sessionId) { …; return; }` early-out. */
  enabled: boolean;
  /** The `onSessionEvent`/`onSkillsEvent`-shaped subscribe call. */
  subscribe: (cb: (e: E) => void) => Promise<UnlistenFn>;
  /** The one hydration read (`getTranscript`/`agentsList`/`skillsList`/…). */
  fetchInitial: () => Promise<Result<D>>;
  /** Whether an event belongs to this subscription at all — irrelevant events are dropped, never buffered. */
  isRelevant: (e: E) => boolean;
  /** Whether an event should wait for hydration before applying. Default: buffer everything. */
  shouldBuffer?: (e: E) => boolean;
  /** Apply the initial fetch's data (the "seed"). */
  onHydrated: (data: D) => void;
  /** Apply one event — called for both drained and live events, in that order. */
  onEvent: (e: E) => void;
  /** Fetch failure. */
  onError: (message: string) => void;
  /** Effect dependency list (typically `[sessionId]`). */
  deps: DependencyList;
}

/**
 * Wires `initHydrationBuffer`/`routeIncoming`/`hydrateBuffer` to a live
 * subscription and a one-shot hydration fetch, guarding both against a stale
 * result after unmount / `deps` change.
 */
export function useHydratedSubscription<E, D>(options: UseHydratedSubscriptionOptions<E, D>): void {
  const { enabled, subscribe, fetchInitial, isRelevant, shouldBuffer, onHydrated, onEvent, onError, deps } = options;

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    let unlisten: UnlistenFn | undefined;
    let state = initHydrationBuffer<E>();

    void subscribe((e) => {
      if (!isRelevant(e)) return;
      const routed = routeIncoming(state, e, shouldBuffer);
      state = routed.next;
      if (routed.applyNow) onEvent(e);
    }).then((u) => {
      if (!mounted) u();
      else unlisten = u;
    });

    void fetchInitial().then((res) => {
      if (!mounted) return;
      if (res.ok) {
        onHydrated(res.data);
        const drained = hydrateBuffer(state);
        state = drained.next;
        for (const e of drained.drained) onEvent(e);
      } else {
        onError(res.error.message);
      }
    });

    return () => {
      mounted = false;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
