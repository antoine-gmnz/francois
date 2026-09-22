// transcript-scale FR-17..22 — the single `onSessionEvent` subscription in the
// webview. Every panel that used to call `onSessionEvent` directly now
// registers through `subscribeSessionEvents`, session-keyed (or `'*'`); the
// underlying Tauri listener is established on the first registration and
// NEVER torn down (FR-17) — a teardown/re-listen cycle re-opens the
// event-loss window `useHydratedSubscription` (FR-18/subscribe-before-fetch)
// was ordered to close. Deliberately module-level state, not a store: nothing
// renders from the registry itself.

import type { UnlistenFn } from '@tauri-apps/api/event';
import type { SessionEvent, SessionId, SessionMeta } from '../../contract/common';
import { onSessionEvent } from './api';
import { useStore } from './store';
import { observeRequestEvent } from './request-replies';
import { sessionIsRetired } from './runtimeCapability';

type Handler = (e: SessionEvent) => void;

/** FR-19: `e.meta.id` for `session.meta`, `e.sessionId` otherwise — mirrors
 *  the rule already duplicated at every former call site. `agent.update` and
 *  `workflow.update` carry their session id INSIDE the payload rather than on
 *  the envelope; reading it there keeps these two high-frequency events (one
 *  per subagent step) from fanning out to every open pane's handlers, which
 *  each re-filtered them out again after delivery. */
function eventSessionId(e: SessionEvent): SessionId | null {
  if (e.type === 'session.meta') return e.meta.id;
  if (e.type === 'agent.update') return e.agent.sessionId;
  if (e.type === 'workflow.update') return e.run.sessionId;
  if ('sessionId' in e) return e.sessionId;
  return null;
}

const registry = new Map<SessionId | '*', Set<Handler>>();
let listenerPromise: Promise<UnlistenFn> | null = null;

/** Last accepted child event per session. A generation changes only through
 * authoritative hydrated/session.meta metadata; accepting a new event generation
 * would let a stale child take over a reconnected session. */
const runtimeCursor = new Map<SessionId, { generation: string; sequence: number }>();
const liveMetadata = new Map<SessionId, SessionMeta | null>();

/** Capture immediately before session_list; events arriving during its request
 * supersede the captured list, including their generation and capabilities. */
export function captureSessionHydration(): (sessions: SessionMeta[]) => SessionMeta[] {
  const before = new Map(liveMetadata);
  return (sessions) => {
    const merged = new Map(sessions.map((meta) => [meta.id, meta]));
    const current = new Map(useStore.getState().sessions.map((meta) => [meta.id, meta]));
    for (const [id, meta] of liveMetadata) {
      if (before.get(id) === meta) continue;
      if (meta === null) {
        merged.delete(id);
      } else {
        const cached = current.get(id);
        merged.set(id, cached && cached.runtimeGeneration === meta.runtimeGeneration ? cached : meta);
      }
    }
    return [...merged.values()];
  };
}

function establishRuntimeGeneration(meta: SessionMeta): void {
  if (!meta.runtimeGeneration) {
    runtimeCursor.delete(meta.id);
  } else if (runtimeCursor.get(meta.id)?.generation !== meta.runtimeGeneration) {
    runtimeCursor.set(meta.id, { generation: meta.runtimeGeneration, sequence: 0 });
  }
}

function acceptsRuntimeEvent(e: Extract<SessionEvent, { type: 'runtime.event' }>): boolean {
  if (!Number.isSafeInteger(e.sequence) || e.sequence <= 0) return false;
  const cursor = runtimeCursor.get(e.sessionId);
  if (!cursor) return false;
  if (cursor.generation !== e.generation || e.sequence <= cursor.sequence) return false;
  cursor.sequence = e.sequence;
  return true;
}

/**
 * FR-19: a `'*'` handler always receives the event; a session-scoped handler
 * receives it when the event names its own session OR the event carries no
 * session id at all (an event with no session id reaches every handler).
 * FR-20: a handler that throws is caught and never blocks the others.
 */
function dispatch(e: SessionEvent): void {
  const ownerId = eventSessionId(e);
  const owner = ownerId ? useStore.getState().sessions.find((s) => s.id === ownerId) ?? liveMetadata.get(ownerId) : null;
  if (sessionIsRetired(owner) && e.type !== 'session.meta' && e.type !== 'session.removed') return;
  if (e.type === 'session.meta') {
    liveMetadata.set(e.meta.id, e.meta);
    establishRuntimeGeneration(e.meta);
  }
  if (e.type === 'session.removed') {
    liveMetadata.set(e.sessionId, null);
    runtimeCursor.delete(e.sessionId);
  }
  if (e.type === 'runtime.event' && !acceptsRuntimeEvent(e)) return;
  if (e.type === 'runtime.event') {
    const meta = useStore.getState().sessions.find((session) => session.id === e.sessionId)
      ?? liveMetadata.get(e.sessionId);
    // A fresh snapshot marks every accepted runtime mutation for reconciliation.
    // Subscribers apply failure/run state to the cache before hydration reads it.
    if (meta) liveMetadata.set(e.sessionId, e.event.kind === 'capabilities'
      ? { ...meta, effectiveCapabilities: e.event.capabilities }
      : { ...meta });
  }
  observeRequestEvent(e, owner);
  const sid = eventSessionId(e);
  for (const [scope, handlers] of registry) {
    if (scope !== '*' && sid !== null && scope !== sid) continue;
    for (const handler of handlers) {
      try {
        handler(e);
      } catch {
        // FR-20: a handler that throws never blocks the others.
      }
    }
  }
}

function ensureListener(): Promise<UnlistenFn> {
  if (!listenerPromise) {
    // Hydration also supplies authoritative metadata, including when it precedes
    // the first subscription. Keep this observer live with the Tauri listener.
    const syncGenerations = (sessions: SessionMeta[]) => {
      for (const meta of sessions) {
        establishRuntimeGeneration(meta);
        observeRequestEvent({ type: 'session.meta', meta }, meta);
      }
    };
    syncGenerations(useStore.getState().sessions);
    useStore.subscribe((state, previous) => {
      if (state.sessions === previous.sessions) return;
      const previousGenerations = new Map(previous.sessions.map((meta) => [meta.id, meta.runtimeGeneration]));
      for (const meta of state.sessions) {
        observeRequestEvent({ type: 'session.meta', meta }, meta);
        if (!previousGenerations.has(meta.id) || previousGenerations.get(meta.id) !== meta.runtimeGeneration) {
          establishRuntimeGeneration(meta);
        }
        previousGenerations.delete(meta.id);
      }
      for (const id of previousGenerations.keys()) {
        runtimeCursor.delete(id);
        observeRequestEvent({ type: 'session.removed', sessionId: id }, null);
      }
    });
    listenerPromise = onSessionEvent(dispatch);
  }
  return listenerPromise;
}

/**
 * FR-17/18: register `handler` for `scope` (a `SessionId`, or `'*'` for
 * every session). Establishes the one underlying Tauri listener on the first
 * registration ever made and never tears it down. Resolves once that
 * listener is live — immediately if it already is — preserving the
 * subscribe-before-fetch guarantee `startHydratedSubscription` depends on.
 * The returned `UnlistenFn` only removes THIS handler from the registry.
 */
export function subscribeSessionEvents(scope: SessionId | '*', handler: Handler): Promise<UnlistenFn> {
  let handlers = registry.get(scope);
  if (!handlers) {
    handlers = new Set();
    registry.set(scope, handlers);
  }
  handlers.add(handler);
  const bucket = handlers;

  return ensureListener().then(
    () => () => {
      bucket.delete(handler);
      if (bucket.size === 0) registry.delete(scope);
      // FR-17: the underlying Tauri listener itself is never removed.
    },
  );
}
