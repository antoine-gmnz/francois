// cloud-sessions FR-2/FR-17 — the modal's session list.
//
// A CONVENIENCE, never a gate: the paste field is the authoritative path and
// must work with this list absent (spec §2). So every failure mode collapses to
// the same calm `degraded` state — a rejected invoke included — and only the
// auth refusals, which are the ones a user can actually act on, become an error.
// The fold itself lives in cloud-sessions.ts and is unit-tested there; this is
// the thin fetch-once wrapper around it.

import { useEffect, useState } from 'react';
import { cloudList } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { cloudListView, type CloudListState } from './cloud-sessions';

const LOADING: CloudListState = { sessions: [], degraded: false, error: null, loading: true };

export function useCloudList(): CloudListState {
  const [state, setState] = useState<CloudListState>(LOADING);
  const mounted = useMounted();

  useEffect(() => {
    void cloudList()
      .then((res) => {
        if (mounted.current) setState({ ...cloudListView(res), loading: false });
      })
      .catch(() => {
        // The IPC layer itself refused. Same treatment as a bad response: the
        // list is gone, the feature is not.
        if (mounted.current) setState({ sessions: [], degraded: true, error: null, loading: false });
      });
  }, [mounted]);

  return state;
}
