// cohorte-integration FR-85/FR-86 — what the Cohorte prefs change in the
// roster. Pure, unit-tested; Sidebar applies the plan to its state groups.
//
//   gatesInNeedsYou       a gated run's origin session joins NEEDS YOU with a
//                         gate card; a gated run with no origin in scope is a
//                         run row at the top of NEEDS YOU.
//   groupSessionsUnderRun a run's step sessions follow its origin row within
//                         one state group (indented); a step in a different
//                         group carries a `<short id>` tag instead.

import type { CohortePrefs, CohorteRun, CohorteSessionLink } from '../../../contract/cohorte-integration';
import type { SessionId } from '../../../contract/common';
import { originSessionId } from './linkage';
import { shortRunId } from './run-view';

export interface RosterCohortePlan {
  /** origin sessions whose run waits at a gate → NEEDS YOU, with the run for their card */
  gated: ReadonlyMap<SessionId, CohorteRun>;
  /** gated runs whose origin session is not in scope → run rows */
  orphanGates: readonly CohorteRun[];
  /** step session → its run's origin session, for nesting */
  originOf: ReadonlyMap<SessionId, SessionId>;
}

export const EMPTY_PLAN: RosterCohortePlan = { gated: new Map(), orphanGates: [], originOf: new Map() };

export function planRoster(
  inScope: readonly { id: SessionId }[],
  runs: readonly CohorteRun[],
  links: readonly CohorteSessionLink[],
  prefs: Pick<CohortePrefs, 'gatesInNeedsYou' | 'groupSessionsUnderRun'>,
): RosterCohortePlan {
  const ids = new Set(inScope.map((s) => s.id));
  const gated = new Map<SessionId, CohorteRun>();
  const orphanGates: CohorteRun[] = [];
  const originOf = new Map<SessionId, SessionId>();
  for (const run of runs) {
    const origin = originSessionId(links, run.runId);
    if (prefs.gatesInNeedsYou && run.view === 'gate' && run.gate) {
      if (origin && ids.has(origin)) gated.set(origin, run);
      else orphanGates.push(run);
    }
    if (prefs.groupSessionsUnderRun && origin) {
      for (const l of links) {
        if (l.runId === run.runId && l.role === 'step' && l.sessionId !== origin && ids.has(l.sessionId)) originOf.set(l.sessionId, origin);
      }
    }
  }
  return { gated, orphanGates, originOf };
}

export interface NestedRow<S> {
  session: S;
  /** indented under the row before it (its run's origin, or a sibling step) */
  nested: boolean;
  /** a step whose origin sits in another group: the run's short id */
  runTag: string | null;
}

/**
 * FR-86 — one group's rows with each run's step sessions moved directly after
 * their origin. Rows keep their incoming order otherwise.
 */
export function nestRows<S extends { id: SessionId }>(
  sessions: readonly S[],
  plan: RosterCohortePlan,
  runIdOfOrigin: (originId: SessionId) => string | null,
): NestedRow<S>[] {
  const here = new Set(sessions.map((s) => s.id));
  const childrenOf = new Map<SessionId, S[]>();
  const moved = new Set<SessionId>();
  for (const s of sessions) {
    const origin = plan.originOf.get(s.id);
    if (origin && here.has(origin)) {
      const list = childrenOf.get(origin) ?? [];
      list.push(s);
      childrenOf.set(origin, list);
      moved.add(s.id);
    }
  }
  const out: NestedRow<S>[] = [];
  for (const s of sessions) {
    if (moved.has(s.id)) continue;
    const origin = plan.originOf.get(s.id);
    const runId = origin ? runIdOfOrigin(origin) : null;
    out.push({ session: s, nested: false, runTag: origin && runId ? shortRunId(runId) : null });
    for (const child of childrenOf.get(s.id) ?? []) out.push({ session: child, nested: true, runTag: null });
  }
  return out;
}

interface NestableNode<S> {
  sessions: S[];
  tiers?: { sessions: S[] }[] | null;
}

/**
 * FR-86 over the roster's state nodes (and their group tiers): each list is
 * reordered by `nestRows`, and the painted marks come back beside it — which
 * rows are indented, which carry a run tag. Reordering the nodes themselves
 * keeps the keyboard cursor's flat order equal to the painted one.
 */
export function nestNodes<S extends { id: SessionId }, N extends NestableNode<S>>(
  nodes: readonly N[],
  plan: RosterCohortePlan,
  runIdOfOrigin: (originId: SessionId) => string | null,
): { nodes: N[]; nested: ReadonlySet<SessionId>; runTags: ReadonlyMap<SessionId, string> } {
  const nested = new Set<SessionId>();
  const runTags = new Map<SessionId, string>();
  if (plan.originOf.size === 0) return { nodes: [...nodes], nested, runTags };
  const order = (list: S[]): S[] =>
    nestRows(list, plan, runIdOfOrigin).map((row) => {
      if (row.nested) nested.add(row.session.id);
      if (row.runTag) runTags.set(row.session.id, row.runTag);
      return row.session;
    });
  const out = nodes.map((node) => ({
    ...node,
    sessions: order(node.sessions),
    tiers: node.tiers ? node.tiers.map((t) => ({ ...t, sessions: order(t.sessions) })) : node.tiers,
  }));
  return { nodes: out, nested, runTags };
}
