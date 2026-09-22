import { useEffect, useState } from 'react';
import type { AppError } from '../../../contract/common';
import type { DiffSummary } from '../../../contract/diff-view';
import { diffGetSummary, onDiffEvent } from '../../lib/api';
import { nextDiffEventAction } from './diff-events';

export interface DiffSummaryState {
  summary: DiffSummary | null;
  error: AppError | null;
}

/**
 * The working tree's change summary for one session — the session panel's
 * Changes tree. Summary only (no per-file diff), hydrated with the listener
 * already live and kept current by diff.changed, a burst folding into one
 * trailing refetch (the same guard useDiffFeed uses). A per-effect mounted
 * guard, so a late reply for the PREVIOUS session never lands after a switch.
 */
export function useDiffSummary(sessionId: string | null): DiffSummaryState {
  const [state, setState] = useState<DiffSummaryState>({ summary: null, error: null });

  useEffect(() => {
    setState({ summary: null, error: null });
    if (!sessionId) return;
    const mounted = { current: true };
    let inFlight = false;
    let queued = false;
    let unlisten: (() => void) | undefined;

    const load = () => {
      inFlight = true;
      void diffGetSummary(sessionId)
        .then((res) => {
          if (!mounted.current) return;
          setState(res.ok ? { summary: res.data, error: null } : { summary: null, error: res.error });
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
          if (queued && mounted.current) {
            queued = false;
            load();
          }
        });
    };

    void onDiffEvent((e) => {
      const action = nextDiffEventAction(e, sessionId, inFlight);
      if (action === 'queueRefresh') queued = true;
      else if (action === 'refetch') load();
    }).then((unsub) => {
      if (!mounted.current) {
        unsub();
        return;
      }
      unlisten = unsub;
      load();
    });

    return () => {
      mounted.current = false;
      if (unlisten) unlisten();
    };
  }, [sessionId]);

  return state;
}
