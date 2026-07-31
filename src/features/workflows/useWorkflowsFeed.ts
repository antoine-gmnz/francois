// useWorkflowsFeed — pane [6]'s hydration + live event subscription, on the
// shared mount→subscribe→buffer→hydrate→drain engine (useHydratedSubscription).
// One event kind, `workflow.update`, and it buffers like every other panel's:
// a run minted before `workflows_list` resolves must not be overwritten by the
// staler snapshot that fetch returns.

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { AppError, SessionEvent, WorkflowRun } from '../../../contract/common';
import { onSessionEvent, workflowsList } from '../../lib/api';
import { useHydratedSubscription } from '../../lib/hooks/useHydratedSubscription';
import { applyRunUpdate, seedRuns } from './workflow-run';

export interface UseWorkflowsFeed {
  runs: Map<string, WorkflowRun>;
  loading: boolean;
  listError: AppError | null;
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  expandedId: string | null;
  setExpandedId: Dispatch<SetStateAction<string | null>>;
}

export function useWorkflowsFeed(sessionId: string | null): UseWorkflowsFeed {
  const [runs, setRuns] = useState<Map<string, WorkflowRun>>(new Map());
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<AppError | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Fresh per session — runs before the hydration effect below (re)subscribes,
  // since both effects share the [sessionId] dep and React runs same-dep effects
  // in declaration order.
  useEffect(() => {
    setRuns(new Map());
    setSelectedId(null);
    setExpandedId(null);
    setListError(null);
    setLoading(sessionId !== null);
  }, [sessionId]);

  useHydratedSubscription<SessionEvent, WorkflowRun[]>({
    enabled: sessionId !== null,
    subscribe: onSessionEvent,
    fetchInitial: () => workflowsList(sessionId ?? ''),
    isRelevant: (e) => e.type === 'workflow.update' && e.run.sessionId === sessionId,
    onHydrated: (data) => {
      setLoading(false);
      setRuns((prev) => seedRuns(prev, data));
    },
    onEvent: (e) => {
      if (e.type === 'workflow.update') setRuns((prev) => applyRunUpdate(prev, e.run));
    },
    onError: (message) => {
      setLoading(false);
      setListError({ code: 'INTERNAL', message });
    },
    deps: [sessionId],
  });

  return { runs, loading, listError, selectedId, setSelectedId, expandedId, setExpandedId };
}
