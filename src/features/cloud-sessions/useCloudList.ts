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
import { cloudListView, type CloudListState } from './cloud-sessions';

const LOADING: CloudListState = { sessions: [], degraded: false, error: null, loading: true };

export function useCloudList(accountId: string | null): CloudListState {
  const [result, setResult] = useState<{ accountId: string | null; state: CloudListState }>({ accountId, state: LOADING });

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    const apply = (state: CloudListState) => { if (live) setResult({ accountId, state }); };
    void cloudList(accountId)
      .then((res) => {
        apply({ ...cloudListView(res), loading: false });
      })
      .catch(() => {
        // The IPC layer itself refused. Same treatment as a bad response: the
        // list is gone, the feature is not.
        apply({ sessions: [], degraded: true, error: null, loading: false });
      });
    return () => { live = false; };
  }, [accountId]);

  if (!accountId) return { sessions: [], degraded: false, error: null, loading: false };
  return result.accountId === accountId ? result.state : LOADING;
}
