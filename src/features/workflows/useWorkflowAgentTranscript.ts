// workflow-details FR-17/FR-18 — the selected agent's own transcript.
//
// Unlike the SESSION/agent tabs there is NO live block event for a workflow
// agent: its conversation only exists on disk, so the refresh trigger is the
// run's own `workflow.detail` flush. `activityKey` (workflow-detail.ts) is what
// "this agent moved" means — passing it as a dependency re-fetches exactly when
// the scan reports new activity for the selected agent and costs nothing on a
// flush that moved some other agent.
//
// Every state transition is pure in ./workflow-detail; this is the effect shell.

import { useCallback, useEffect, useRef, useState } from 'react';
import { workflowsAgent } from '../../lib/api';
import {
  CLOSED_TRANSCRIPT,
  openAgentTranscript,
  receiveAgentBlocks,
  refreshAgentTranscript,
  type WorkflowTranscriptState,
} from './workflow-detail';

export interface UseWorkflowAgentTranscript {
  state: WorkflowTranscriptState;
  /** FR-18: the column reports whether the user is still latched to the bottom. */
  setAtBottom: (atBottom: boolean) => void;
}

export function useWorkflowAgentTranscript(
  runId: string,
  agentId: string | null,
  activityKey: string,
): UseWorkflowAgentTranscript {
  const [state, setState] = useState<WorkflowTranscriptState>(CLOSED_TRANSCRIPT);
  const reqRef = useRef(0);

  useEffect(() => {
    if (agentId === null) {
      setState(CLOSED_TRANSCRIPT);
      return;
    }
    let mounted = true;
    const reqId = ++reqRef.current;
    // A re-fetch of the SAME agent keeps its blocks on screen; only a different
    // agent blanks the column (FR-17).
    setState((prev) =>
      prev.agentId === agentId ? refreshAgentTranscript(prev, reqId) : openAgentTranscript(agentId, reqId),
    );
    // `ipc()` REJECTS on a transport failure instead of resolving a Result, so
    // funnel that through the same path or `loading` sticks true forever.
    void workflowsAgent(runId, agentId)
      .then((res) => {
        if (mounted) setState((prev) => receiveAgentBlocks(prev, reqId, res));
      })
      .catch((err: unknown) => {
        if (mounted) {
          setState((prev) =>
            receiveAgentBlocks(prev, reqId, { ok: false, error: { code: 'INTERNAL', message: String(err) } }),
          );
        }
      });
    return () => {
      mounted = false;
    };
  }, [runId, agentId, activityKey]);

  const setAtBottom = useCallback((atBottom: boolean) => {
    setState((prev) => (prev.atBottom === atBottom ? prev : { ...prev, atBottom }));
  }, []);

  return { state, setAtBottom };
}
