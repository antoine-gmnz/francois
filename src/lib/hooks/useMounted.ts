// Shared "is this component still mounted" guard for async results (REFACTOR.md
// audit: the same shape was hand-rolled 4 times — App.tsx's `let live = true` /
// `{ current: true }` object-literal effects, ProjectsModal/RemoteControlBadge/
// ProjectSwitcher's `useRef(true)` toggled in a mount effect, McpPanel's inline
// `let mounted = true`, and Sidebar's inverted `let cancelled = false`). All of
// them exist to answer one question inside an async `.then`: "is it still safe
// to call setState / unlisten?" — this hook is that single answer.
//
// `createMountedRef` is the pure, framework-free half (a plain mutable ref plus
// a `dispose()` to flip it) so the on/off behaviour is unit-testable without a
// component renderer; `useMounted` is the one-line React wrapper that toggles it
// off on unmount via `useEffect`.
//
// Scope note (see the frontend HANDOFF): this hook answers "is the component
// mounted", which is a strict superset of "is this specific effect run still
// current" ONLY when the effect's own dependencies never change without the
// component itself remounting. That holds for every call site above except
// App.tsx's session-scoped diff-count effect (`useEffect(..., [activeSessionId])`
// on the never-remounted root component) and McpPanel's `DetailPopover`, whose
// `[sessionId, name]` effect can re-run when the popover switches to a different
// server without unmounting. Those two need a guard that is fresh per effect run
// (what their current inline `let`/object-literal flag already gives them) —
// swapping in a whole-of-component `useMounted()` there would let a stale
// resolution from the PREVIOUS run apply after the run moved on. Every other
// call site remounts on the same key that the guard is meant to track (parent
// `key={sessionId}` panels, or a `[]`-deps mount-once effect), so `useMounted()`
// is an exact, lossless replacement there.

import { useEffect, useRef, type MutableRefObject } from 'react';

/** A mounted flag plus the means to flip it off — the non-hook half, for tests. */
export interface MountedRefHandle {
  /** Mutable; `.current` is `true` until `dispose()` runs. */
  readonly ref: MutableRefObject<boolean>;
  /** Flips `ref.current` to `false`. Idempotent. */
  dispose: () => void;
}

/** Pure factory: a fresh `{ current: true }` ref and its disposer. No React. */
export function createMountedRef(): MountedRefHandle {
  const ref: MutableRefObject<boolean> = { current: true };
  return {
    ref,
    dispose: () => {
      ref.current = false;
    },
  };
}

/**
 * Returns a ref that is `true` from mount until unmount — check `.current`
 * inside an async `.then`/`.catch` before applying a result or storing an
 * `unlisten` function, exactly like the call sites this replaces:
 *
 * ```ts
 * const mountedRef = useMounted();
 * useEffect(() => {
 *   let unlisten: (() => void) | undefined;
 *   void subscribe(cb).then((u) => {
 *     if (!mountedRef.current) u();
 *     else unlisten = u;
 *   });
 *   return () => unlisten?.();
 * }, []);
 * ```
 */
export function useMounted(): MutableRefObject<boolean> {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}
