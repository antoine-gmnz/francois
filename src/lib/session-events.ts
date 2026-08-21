// transcript-scale FR-17..22 — the single `onSessionEvent` subscription in the
// webview. Every panel that used to call `onSessionEvent` directly now
// registers through `subscribeSessionEvents`, session-keyed (or `'*'`); the
// underlying Tauri listener is established on the first registration and
// NEVER torn down (FR-17) — a teardown/re-listen cycle re-opens the
// event-loss window `useHydratedSubscription` (FR-18/subscribe-before-fetch)
// was ordered to close. Deliberately module-level state, not a store: nothing
// renders from the registry itself.

import type { UnlistenFn } from '@tauri-apps/api/event';
import type { SessionEvent, SessionId } from '../../contract/common';
import { onSessionEvent } from './api';

type Handler = (e: SessionEvent) => void;

/** FR-19: `e.meta.id` for `session.meta`, `e.sessionId` otherwise — mirrors
 *  the rule already duplicated at every former call site. */
function eventSessionId(e: SessionEvent): SessionId | null {
  if (e.type === 'session.meta') return e.meta.id;
  if ('sessionId' in e) return e.sessionId;
  return null;
}

const registry = new Map<SessionId | '*', Set<Handler>>();
let listenerPromise: Promise<UnlistenFn> | null = null;

/**
 * FR-19: a `'*'` handler always receives the event; a session-scoped handler
 * receives it when the event names its own session OR the event carries no
 * session id at all (an event with no session id reaches every handler).
 * FR-20: a handler that throws is caught and never blocks the others.
 */
function dispatch(e: SessionEvent): void {
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
  if (!listenerPromise) listenerPromise = onSessionEvent(dispatch);
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
