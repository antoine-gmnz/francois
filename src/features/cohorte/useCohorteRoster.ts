// cohorte-integration FR-85/FR-86 — the roster's Cohorte plan as a hook: which
// sessions NEEDS YOU gains, the orphan gate rows, and the nesting pass.

import { useMemo } from 'react';
import type { SessionId } from '../../../contract/common';
import { useCohorteStore } from '../../lib/cohorteStore';
import { EMPTY_PLAN, nestNodes, planRoster, type RosterCohortePlan } from './roster';
import { CASE_INSENSITIVE_FS, useCohorteLinks } from './useCohorte';
import { watchedRunList } from './watch';

export interface CohorteRoster {
  plan: RosterCohortePlan;
  forced: ReadonlySet<SessionId>;
  nest: <S extends { id: SessionId }, N extends { sessions: S[]; tiers?: { sessions: S[] }[] | null }>(
    nodes: readonly N[],
  ) => { nodes: N[]; nested: ReadonlySet<SessionId>; runTags: ReadonlyMap<SessionId, string> };
}

export function useCohorteRoster(inScope: readonly { id: SessionId }[]): CohorteRoster {
  const links = useCohorteLinks();
  const runs = useCohorteStore((s) => s.runs);
  const roots = useCohorteStore((s) => s.watchedRoots);
  const gatesInNeedsYou = useCohorteStore((s) => s.prefs.gatesInNeedsYou);
  const groupSessionsUnderRun = useCohorteStore((s) => s.prefs.groupSessionsUnderRun);
  return useMemo(() => {
    // R-13: only watched roots reach the roster.
    const list = watchedRunList(runs, roots, CASE_INSENSITIVE_FS);
    const plan = list.length === 0 ? EMPTY_PLAN : planRoster(inScope, list, links, { gatesInNeedsYou, groupSessionsUnderRun });
    const runOfOrigin = new Map<SessionId, string>();
    for (const l of links) if (l.role === 'origin' || !runOfOrigin.has(l.sessionId)) runOfOrigin.set(l.sessionId, l.runId);
    return {
      plan,
      forced: new Set(plan.gated.keys()),
      nest: (nodes) => nestNodes(nodes, plan, (origin) => runOfOrigin.get(origin) ?? null),
    };
  }, [inScope, runs, roots, links, gatesInNeedsYou, groupSessionsUnderRun]);
}
