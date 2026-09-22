// github-page — race guard for the tab/detail loaders (review fix #3). Each
// `GitHubView`/`PullsTab`/`CommitsTab`/`BranchesTab`/`PullDetail`/`CommitDetail`
// load effect re-runs when its own inputs change (cwd, ref, refreshKey, the
// selected number/sha) WITHOUT the component remounting — so `useMounted`
// (src/lib/hooks/useMounted.ts) is the wrong tool here: its own scope note
// says a whole-of-component mounted flag lets a stale resolution from the
// PREVIOUS run apply once a newer run has started, because both runs are
// still "mounted". This hook hands out a fresh generation id per run instead;
// a run's `isCurrent()` flips false as soon as a later run starts (or the
// component unmounts), so an in-flight response for a superseded ref/cwd/sha
// is silently dropped instead of overwriting the newer request's state.
//
// `createGenerationGuard` is the pure, framework-free half — unit-tested
// directly, same split as `createMountedRef` in useMounted.ts.

import { useEffect, useRef } from 'react';

export interface GenerationGuard {
  /** Call at the start of an async run; returns that run's `isCurrent` check. */
  begin: () => () => boolean;
  /** Invalidates every run started so far (used on unmount). */
  invalidate: () => void;
}

/** Pure factory: a mutable generation counter. No React. */
export function createGenerationGuard(): GenerationGuard {
  const generation = { current: 0 };
  return {
    begin: () => {
      generation.current += 1;
      const id = generation.current;
      return () => generation.current === id;
    },
    invalidate: () => {
      generation.current += 1;
    },
  };
}

/**
 * Returns `beginRequest`: call it synchronously at the top of a load effect
 * to get `isCurrent()`, then check `isCurrent()` before applying the async
 * result:
 *
 * ```ts
 * const beginRequest = useLatestRequest();
 * useEffect(() => {
 *   const isCurrent = beginRequest();
 *   void load().then((res) => {
 *     if (!isCurrent()) return; // a newer cwd/ref/refreshKey superseded this
 *     setState(res);
 *   });
 * }, [cwd, ref, refreshKey]);
 * ```
 */
export function useLatestRequest(): () => () => boolean {
  const guard = useRef<GenerationGuard>();
  if (!guard.current) guard.current = createGenerationGuard();

  useEffect(() => {
    const g = guard.current!;
    return () => g.invalidate();
  }, []);

  return guard.current.begin;
}
