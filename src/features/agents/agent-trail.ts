// async-agents — pure activity-trail logic for pane [3] (FR-17..FR-23),
// extracted from AgentsPanel.tsx so the hydration race (FR-20), the auto-scroll
// latch (FR-21), the collapse/expand lifecycle (FR-19/FR-22) and the §8 step
// vocabulary are unit-testable without the DOM.

import type { AgentInfo, AgentStep, AgentStepKind, AppError, Result, SessionEvent } from '../../../contract/common';

// ---------- §8 vocabulary ----------

/** Row-1 marker on a `background` agent (§8, FR-17). */
export const ASYNC_MARKER = 'async';

/** Expanded, hydrated, zero steps (§8). */
export const TRAIL_EMPTY_LABEL = 'no activity yet';

/** §8: the trail box is a fixed 180px scroller; the pane scrolls beyond it. */
export const TRAIL_MAX_HEIGHT_PX = 180;

/** FR-21: within this many px of the bottom still counts as "at the bottom". */
export const TRAIL_BOTTOM_THRESHOLD_PX = 8;

export const STEP_GLYPH: Record<AgentStepKind, string> = {
  text: '●',
  tool: '⧉',
  notice: '·',
};

export const STEP_GLYPH_COLOR: Record<AgentStepKind, string> = {
  text: 'var(--text-dim)',
  tool: 'var(--accent-2)',
  notice: 'var(--text-faint)',
};

/** §8: the literal `error` meta is the only one painted in the error colour. */
export function stepMetaColor(meta: string): string {
  return meta === 'error' ? 'var(--error)' : 'var(--text-faint)';
}

/** §8: `kind: 'tool'` rows prefix the tool name (dim) before the summary. */
export function stepToolPrefix(step: AgentStep): string | null {
  return step.kind === 'tool' && step.tool ? step.tool : null;
}

/** FR-17: the `async` marker rides on the contract's `background` flag. */
export function showAsyncMarker(agent: AgentInfo): boolean {
  return agent.background === true;
}

/** FR-17: ` · {lastActivity}` on the meta row — for every status, absent when blank. */
export function activitySuffix(agent: AgentInfo): string | null {
  const t = agent.lastActivity?.trim();
  return t ? t : null;
}

/** §7: the leading dim row when the 200-step window dropped older steps (FR-12). */
export function earlierStepsNotice(stepCount: number, trailLength: number): string | null {
  const dropped = stepCount - trailLength;
  return dropped > 0 ? `… ${dropped} earlier step${dropped === 1 ? '' : 's'}` : null;
}

/** §7: `AGENT_NOT_FOUND` drops the card from the local map, like `kill` does. */
export function dropsCardOnTrailError(error: AppError): boolean {
  return error.code === 'AGENT_NOT_FOUND';
}

/**
 * §7: the pure decision behind AgentsPanel's delayed card-drop — the agent id
 * to remove from the agent map, or null. Split out from `dropsCardOnTrailError`
 * so the "which agent, if any, right now" question is itself unit-testable: the
 * card must drop only ONE commit after the trail's error row has painted, never
 * in the same batch as the error being set (otherwise the row never renders).
 */
export function agentIdToDropForTrailError(trail: TrailState): string | null {
  if (trail.agentId === null || trail.error === null) return null;
  return dropsCardOnTrailError(trail.error) ? trail.agentId : null;
}

// ---------- FR-21 auto-scroll latch ----------

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function isAtBottom(m: ScrollMetrics): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= TRAIL_BOTTOM_THRESHOLD_PX;
}

// ---------- trail state (FR-19..FR-22) ----------

export interface TrailState {
  /** The expanded card, or null when no card is expanded (at most one, FR-22). */
  agentId: string | null;
  /** Bumped on every expand/collapse so a stale `activity` response is ignored. */
  reqId: number;
  /** The rendered trail, ordered by `seq`. */
  steps: AgentStep[];
  /** FR-20: `agent.step` events seen before the `activity` response landed. */
  buffer: AgentStep[];
  /** FR-19: the request is in flight — the trail area renders nothing. */
  loading: boolean;
  hydrated: boolean;
  error: AppError | null;
  /** FR-21: false once the user scrolled up inside the trail. */
  atBottom: boolean;
}

export const COLLAPSED_TRAIL: TrailState = {
  agentId: null,
  reqId: 0,
  steps: [],
  buffer: [],
  loading: false,
  hydrated: false,
  error: null,
  atBottom: true,
};

/** FR-22: collapsing discards the local copy; the core keeps the authoritative trail. */
export function collapseTrail(prev: TrailState): TrailState {
  return { ...COLLAPSED_TRAIL, reqId: prev.reqId + 1 };
}

/** FR-19: expanding starts an empty, loading, bottom-latched trail and a fresh request. */
export function expandTrail(prev: TrailState, agentId: string): TrailState {
  return {
    agentId,
    reqId: prev.reqId + 1,
    steps: [],
    buffer: [],
    loading: true,
    hydrated: false,
    error: null,
    atBottom: true,
  };
}

/** FR-13/FR-19: `⏎` toggles — the same card collapses, another card expands. */
export function toggleTrail(prev: TrailState, agentId: string): TrailState {
  return prev.agentId === agentId ? collapseTrail(prev) : expandTrail(prev, agentId);
}

/**
 * FR-20: insert-or-replace by `seq`, keeping the list sorted. Replacement in place
 * is how FR-9's `meta` fill lands without appending a second row.
 */
export function mergeStep(list: AgentStep[], step: AgentStep): AgentStep[] {
  const next = list.slice();
  const i = next.findIndex((s) => s.seq === step.seq);
  if (i >= 0) {
    next[i] = step;
    return next;
  }
  let at = next.length;
  while (at > 0 && next[at - 1].seq > step.seq) at--;
  next.splice(at, 0, step);
  return next;
}

/** FR-20/FR-22: apply a live `agent.step`, or buffer it until hydration. */
export function receiveTrailStep(prev: TrailState, agentId: string, step: AgentStep): TrailState {
  if (prev.agentId === null || prev.agentId !== agentId) return prev; // collapsed / other card
  if (!prev.hydrated) return { ...prev, buffer: mergeStep(prev.buffer, step) };
  // A live step still arriving proves the agent is not dead — clear a stored
  // hydration error so the panel renders the step list again instead of being
  // stuck on the error branch until the user collapses/re-expands (Finding 5).
  return { ...prev, steps: mergeStep(prev.steps, step), error: null };
}

/**
 * async-agents FR-20/FR-22: route a raw SessionEvent into the trail. Only
 * `agent.step` events matter here, and only when they belong to this session —
 * everything else (including foreign-session steps) passes the trail through
 * unchanged. Extracted so the routing decision is unit-testable without a DOM.
 */
export function routeSessionEventToTrail(trail: TrailState, sessionId: string, e: SessionEvent): TrailState {
  if (e.type !== 'agent.step') return trail;
  if (e.sessionId !== sessionId) return trail;
  return receiveTrailStep(trail, e.agentId, e.step);
}

/**
 * FR-19/FR-20: the `agents_activity` response. Buffered events are applied AFTER
 * the response, so the (possibly stale) snapshot never overwrites a step already
 * seen live — the same race rule as agents-panel FR-2.
 */
export function receiveTrailActivity(
  prev: TrailState,
  reqId: number,
  res: Result<AgentStep[]>,
): TrailState {
  if (prev.agentId === null || prev.reqId !== reqId) return prev; // stale response
  if (!res.ok) {
    return { ...prev, loading: false, hydrated: true, buffer: [], error: res.error };
  }
  let steps = [...res.data].sort((left, right) => left.seq - right.seq);
  for (const step of prev.buffer) steps = mergeStep(steps, step);
  return { ...prev, loading: false, hydrated: true, buffer: [], steps, error: null };
}
