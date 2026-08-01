// workflow-details — the `workflow:{id}` tab's two live feeds (FR-14):
//
//  - the RUN itself (name, description, status, phases, elapsed anchor), seeded
//    from `workflows_list` and kept live by `workflow.update` — the panel's own
//    event. Held here rather than read from pane [6] so the tab does not depend
//    on that panel being mounted, exactly as AgentView does for pane [3].
//  - the DETAIL (what the run directory says), from `workflows_detail` +
//    `workflow.detail`. Subscribed BEFORE the request so a flush that beats the
//    response is buffered and applied after it (FR-14) rather than lost.
//
// All the state transitions are pure in ./workflow-detail; this file is the
// imperative effect shell around them.

import { useEffect, useRef, useState } from 'react';
import type { SessionEvent, WorkflowRun } from '../../../contract/common';
import { onSessionEvent, onWorkflowEvent, workflowsDetail, workflowsList } from '../../lib/api';
import {
  CLOSED_DETAIL,
  openDetail,
  receiveDetail,
  receiveDetailEvent,
  type WorkflowDetailState,
} from './workflow-detail';

export interface UseWorkflowDetail {
  run: WorkflowRun | null;
  state: WorkflowDetailState;
}

export function useWorkflowDetail(runId: string, sessionId: string): UseWorkflowDetail {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [state, setState] = useState<WorkflowDetailState>(CLOSED_DETAIL);
  const reqRef = useRef(0);

  // FR-14: the header's own view of the run.
  useEffect(() => {
    setRun(null);
    let mounted = true;
    let unlisten: (() => void) | undefined;
    void onSessionEvent((e: SessionEvent) => {
      if (e.type === 'workflow.update' && e.run.id === runId) setRun(e.run);
    }).then((unsub) => (mounted ? (unlisten = unsub) : unsub()));
    void workflowsList(sessionId).then((res) => {
      if (!mounted || !res.ok) return;
      // A buffered workflow.update already won — never overwrite it with the snapshot.
      setRun((prev) => prev ?? res.data.find((r) => r.id === runId) ?? null);
    });
    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [runId, sessionId]);

  // FR-14: the detail + its live flushes. `workflows_detail` also starts the
  // core's filesystem watch (FR-6), so this one call is what makes the stream
  // begin — which is precisely why the subscription is installed first.
  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    const reqId = ++reqRef.current;
    setState(openDetail(runId, reqId));
    void onWorkflowEvent((e) => {
      if (e.type === 'workflow.detail') setState((prev) => receiveDetailEvent(prev, e.detail));
    }).then((unsub) => (mounted ? (unlisten = unsub) : unsub()));
    // `ipc()` REJECTS on a transport failure instead of resolving a Result, so
    // funnel that through the same path or `loading` sticks true forever.
    void workflowsDetail(runId)
      .then((res) => {
        if (mounted) setState((prev) => receiveDetail(prev, reqId, res));
      })
      .catch((err: unknown) => {
        if (mounted) {
          setState((prev) =>
            receiveDetail(prev, reqId, { ok: false, error: { code: 'INTERNAL', message: String(err) } }),
          );
        }
      });
    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [runId]);

  return { run, state };
}
