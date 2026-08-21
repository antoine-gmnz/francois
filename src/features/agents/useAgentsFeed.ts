// useAgentsFeed — pane [3]'s hydration + live event subscription
// (async-agents FR-1/2/3/4), split out of AgentsPanel.tsx onto the shared
// mount→subscribe→buffer→hydrate→drain engine (useHydratedSubscription). Two
// SessionEvent kinds share the one subscription: `agent.update` buffers like
// every other panel; `agent.step` never buffers — it always applies live,
// hydrated or not, straight into the expanded card's trail.

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentInfo, AppError, SessionEvent } from '../../../contract/common';
import { agentsList } from '../../lib/api';
import { useHydratedSubscription } from '../../lib/hooks/useHydratedSubscription';
import { subscribeSessionEvents } from '../../lib/session-events';
import { COLLAPSED_TRAIL, collapseTrail, routeSessionEventToTrail, type TrailState } from './agent-trail';

export interface UseAgentsFeedOptions {
  sessionId: string | null;
  /** agent-tab: keep an open tab's label + status dot live (a no-op with no open tab). */
  syncAgentTab: (ref: { id: string; name: string; status: AgentInfo['status'] }) => void;
}

export interface UseAgentsFeed {
  agents: Map<string, AgentInfo>;
  setAgents: Dispatch<SetStateAction<Map<string, AgentInfo>>>;
  loading: boolean;
  listError: AppError | null;
  trail: TrailState;
  setTrail: Dispatch<SetStateAction<TrailState>>;
  pendingKill: Set<string>;
  setPendingKill: Dispatch<SetStateAction<Set<string>>>;
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
}

export function useAgentsFeed({ sessionId, syncAgentTab }: UseAgentsFeedOptions): UseAgentsFeed {
  const [agents, setAgents] = useState<Map<string, AgentInfo>>(new Map());
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<AppError | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The expanded card + its activity trail (async-agents FR-19..FR-22).
  const [trail, setTrail] = useState<TrailState>(COLLAPSED_TRAIL);
  const [pendingKill, setPendingKill] = useState<Set<string>>(new Set());

  // Fresh per session (FR-4) — runs before the hydration effect below
  // (re)subscribes, since both effects share the [sessionId] dep and React
  // runs same-dep effects in declaration order.
  useEffect(() => {
    setAgents(new Map());
    setSelectedId(null);
    setTrail(collapseTrail); // FR-23: trails go with the agent map
    setPendingKill(new Set());
    setListError(null);
    setLoading(sessionId !== null);
  }, [sessionId]);

  const applyAgent = (agent: AgentInfo) => {
    // agent-tab: keep an open tab's label + status dot live. A no-op when this
    // agent has no tab, and this panel is already the ONE agent.update
    // subscriber for the active session — no second subscription.
    syncAgentTab({ id: agent.id, name: agent.name, status: agent.status });
    setAgents((prev) => {
      const next = new Map(prev);
      next.set(agent.id, agent); // set on existing key preserves position (FR-7)
      return next;
    });
    setPendingKill((prev) => {
      if (!prev.has(agent.id)) return prev;
      const next = new Set(prev);
      next.delete(agent.id);
      return next;
    });
  };

  useHydratedSubscription<SessionEvent, AgentInfo[]>({
    enabled: sessionId !== null,
    // transcript-scale FR-21: through the one router subscription, scoped to
    // this session. `agent.step` carries its own sessionId so the router
    // already filters it per-session (routeSessionEventToTrail's own
    // `e.sessionId !== sessionId` guard is now redundant but harmless);
    // `agent.update` carries no top-level sessionId, so the router treats it
    // as session-agnostic (FR-19) and this hook's own isRelevant below keeps
    // doing the filtering it always did.
    subscribe: (cb) => subscribeSessionEvents(sessionId ?? '', cb),
    fetchInitial: () => agentsList(sessionId ?? ''),
    // async-agents FR-20/FR-22: only the expanded card consumes steps.
    isRelevant: (e) => e.type === 'agent.step' || (e.type === 'agent.update' && e.agent.sessionId === sessionId),
    shouldBuffer: (e) => e.type === 'agent.update', // FR-3: agent.step never buffers
    onHydrated: (data) => {
      setLoading(false);
      // Seed only ids not already present from a buffered event (FR-2).
      setAgents((prev) => {
        const next = new Map(prev);
        for (const agent of data) if (!next.has(agent.id)) next.set(agent.id, agent);
        return next;
      });
    },
    onEvent: (e) => {
      if (e.type === 'agent.step') {
        setTrail((t) => routeSessionEventToTrail(t, sessionId ?? '', e));
        return;
      }
      if (e.type === 'agent.update') applyAgent(e.agent);
    },
    onError: (message) => {
      setLoading(false);
      setListError({ code: 'INTERNAL', message });
    },
    deps: [sessionId],
  });

  return { agents, setAgents, loading, listError, trail, setTrail, pendingKill, setPendingKill, selectedId, setSelectedId };
}
