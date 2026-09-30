import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppError } from '../../../contract/common';
import type { DiffSummary } from '../../../contract/diff-view';
import { diffGetSummary, onDiffEvent } from '../../lib/api';
import { nextDiffEventAction } from './diff-events';

export interface DiffSummaryState {
  summary: DiffSummary | null;
  error: AppError | null;
}

export interface DiffSummaryHandle extends DiffSummaryState {
  /** Re-read the working tree now — for changes made outside any session (an
   *  editor, a terminal) that no diff.changed event announces. */
  refresh: () => void;
  /** A manual refresh is in flight. */
  refreshing: boolean;
}

/**
 * The working tree's change summary for one session — the session panel's
 * Changes tree. Summary only (no per-file diff), hydrated with the listener
 * already live and kept current by diff.changed, a burst folding into one
 * trailing refetch (the same guard useDiffFeed uses). A per-effect mounted
 * guard, so a late reply for the PREVIOUS session never lands after a switch.
 * `refresh` goes through the same guard, so a click mid-fetch queues one
 * trailing refetch instead of racing it.
 */
export function useDiffSummary(sessionId: string | null): DiffSummaryHandle {
  const [state, setState] = useState<DiffSummaryState>({ summary: null, error: null });
  const [refreshing, setRefreshing] = useState(false);
  const requestRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setState({ summary: null, error: null });
    setRefreshing(false);
    requestRef.current = null;
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
          if (!mounted.current) return;
          if (queued) {
            queued = false;
            load();
          } else setRefreshing(false);
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

    requestRef.current = () => {
      setRefreshing(true);
      if (inFlight) queued = true;
      else load();
    };

    return () => {
      mounted.current = false;
      requestRef.current = null;
      if (unlisten) unlisten();
    };
  }, [sessionId]);

  const refresh = useCallback(() => requestRef.current?.(), []);

  return { ...state, refresh, refreshing };
}
