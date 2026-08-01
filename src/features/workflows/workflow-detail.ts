// workflow-details — the `workflow:{id}` tab's pure half (specs/workflow-details.md
// FR-14..FR-19, FR-25): the detail hydration race, the selected agent's transcript
// state, and every derivation the two columns render (spans, elapsed, token
// totals, ask ownership). Framework-free so it is unit-testable without a
// component renderer (this project has none — see REFACTOR-CONVENTIONS.md).
//
// Nothing here is stored: every value is derived from the core's `WorkflowDetail`
// plus the run's own `WorkflowRun` (spec §6, "Derived, not stored").

import type { AppError, Result } from '../../../contract/common';
import type { AgentBlock } from '../../../contract/agent-tab';
import type {
  WorkflowAgentInfo,
  WorkflowAgentStatus,
  WorkflowAgentTranscript,
  WorkflowDetail,
  WorkflowPendingAsk,
  WorkflowScript,
  WorkflowTokens,
} from '../../../contract/workflow-details';

// ---------- the run detail (FR-14) ----------

export interface WorkflowDetailState {
  /** The run this state belongs to, or null before the tab opened one. */
  runId: string | null;
  /** Bumped per open so a stale `workflows_detail` response is ignored. */
  reqId: number;
  detail: WorkflowDetail | null;
  /** FR-14: a `workflow.detail` that beat the response, held until it lands. */
  buffered: WorkflowDetail | null;
  loading: boolean;
  hydrated: boolean;
  error: AppError | null;
}

export const CLOSED_DETAIL: WorkflowDetailState = {
  runId: null,
  reqId: 0,
  detail: null,
  buffered: null,
  loading: false,
  hydrated: false,
  error: null,
};

/** FR-14: opening the tab starts an empty, loading state under `reqId`. */
export function openDetail(runId: string, reqId: number): WorkflowDetailState {
  return { ...CLOSED_DETAIL, runId, reqId, loading: true };
}

/**
 * FR-14: apply one `workflow.detail`. Before hydration it is BUFFERED rather
 * than dropped — the response that follows must not overwrite a newer state.
 * An event also clears a stored error: the run is evidently readable now.
 */
export function receiveDetailEvent(prev: WorkflowDetailState, detail: WorkflowDetail): WorkflowDetailState {
  if (prev.runId === null || prev.runId !== detail.id) return prev; // another run's stream
  if (!prev.hydrated) return { ...prev, buffered: detail };
  return { ...prev, detail, error: null };
}

/**
 * FR-14: the `workflows_detail` response. A buffered event is applied AFTER the
 * snapshot and wins over it, so a run that moved while the request was in flight
 * never rewinds on screen.
 */
export function receiveDetail(
  prev: WorkflowDetailState,
  reqId: number,
  res: Result<WorkflowDetail>,
): WorkflowDetailState {
  if (prev.runId === null || prev.reqId !== reqId) return prev; // stale response
  if (!res.ok) {
    return { ...prev, loading: false, hydrated: true, buffered: null, error: res.error };
  }
  return {
    ...prev,
    loading: false,
    hydrated: true,
    detail: prev.buffered ?? res.data,
    buffered: null,
    error: null,
  };
}

// ---------- the selected agent's transcript (FR-17, FR-18) ----------

export interface WorkflowTranscriptState {
  /** The agent whose transcript this is, or null when none is selected. */
  agentId: string | null;
  reqId: number;
  blocks: AgentBlock[];
  /** FR-17: blocks the core dropped past its 400-block window. */
  dropped: number;
  /** The FIRST request for this agent is in flight — the column renders nothing. */
  loading: boolean;
  hydrated: boolean;
  error: AppError | null;
  /** FR-18: false once the user scrolled up inside the column. */
  atBottom: boolean;
}

export const CLOSED_TRANSCRIPT: WorkflowTranscriptState = {
  agentId: null,
  reqId: 0,
  blocks: [],
  dropped: 0,
  loading: false,
  hydrated: false,
  error: null,
  atBottom: true,
};

/** Selecting a DIFFERENT agent: empty, loading, bottom-latched. */
export function openAgentTranscript(agentId: string, reqId: number): WorkflowTranscriptState {
  return { ...CLOSED_TRANSCRIPT, agentId, reqId, loading: true };
}

/**
 * FR-17 re-fetch: the SAME agent reported new activity. The rendered blocks stay
 * on screen until the response swaps them — reopening would blank the column on
 * every 300 ms flush of a running agent.
 */
export function refreshAgentTranscript(prev: WorkflowTranscriptState, reqId: number): WorkflowTranscriptState {
  return { ...prev, reqId };
}

/** The `workflows_agent` response, ignored when a newer request superseded it. */
export function receiveAgentBlocks(
  prev: WorkflowTranscriptState,
  reqId: number,
  res: Result<WorkflowAgentTranscript>,
): WorkflowTranscriptState {
  if (prev.agentId === null || prev.reqId !== reqId) return prev; // stale response
  if (!res.ok) {
    return { ...prev, loading: false, hydrated: true, error: res.error };
  }
  return {
    ...prev,
    loading: false,
    hydrated: true,
    blocks: res.data.blocks,
    dropped: res.data.dropped,
    error: null,
  };
}

// ---------- the script source (FR-9, §8 2d) ----------

export interface WorkflowScriptState {
  /** Bumped per fetch so a superseded `workflows_script` response is ignored. */
  reqId: number;
  script: WorkflowScript | null;
  loading: boolean;
  error: AppError | null;
}

export const CLOSED_SCRIPT: WorkflowScriptState = { reqId: 0, script: null, loading: false, error: null };

/**
 * Start a `workflows_script` fetch. Whatever is already on screen STAYS — the
 * source is immutable for the run's lifetime, so a re-open must not blank the
 * column while the same bytes come back.
 */
export function openScriptRequest(prev: WorkflowScriptState, reqId: number): WorkflowScriptState {
  return { ...prev, reqId, loading: true, error: null };
}

/** §7: `WORKFLOW_NO_SCRIPT` is an inline row in the column, never a closed tab. */
export function receiveScript(
  prev: WorkflowScriptState,
  reqId: number,
  res: Result<WorkflowScript>,
): WorkflowScriptState {
  if (prev.reqId !== reqId) return prev; // stale response
  if (!res.ok) return { ...prev, loading: false, error: res.error };
  return { ...prev, loading: false, script: res.data, error: null };
}

// ---------- which state the right column is in (FR-15) ----------

export type RightColumnMode = 'script' | 'transcript' | 'asks' | 'summary';

/**
 * FR-15 / §8 2c–2e. `asks` is §8 2c-bis's rule: with nothing selected and a run
 * blocked on the user, the ask IS the column — `select an agent` would be the
 * least useful thing Francois could say at that moment.
 */
export function rightColumnMode(opts: {
  scriptOpen: boolean;
  selectedAgentId: string | null;
  askCount: number;
}): RightColumnMode {
  if (opts.scriptOpen) return 'script';
  if (opts.selectedAgentId !== null) return 'transcript';
  return opts.askCount > 0 ? 'asks' : 'summary';
}

// ---------- tokens (FR-15, FR-16) ----------

export function sumTokens(tokens: WorkflowTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
}

/**
 * §8's compact figure — `1.2k`, `340k`. Lowercase and its own function rather
 * than conversation-view's `formatContextTokens` (`1.2K`), because this view
 * counts a run's spend, not a context window's fill.
 */
export function formatTokens(n: number): string {
  const strip = (x: string) => x.replace(/\.0$/, '');
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${strip((n / 1000).toFixed(1))}k`;
  return `${strip((n / 1_000_000).toFixed(1))}m`;
}

// ---------- the left rail's counts (FR-15) ----------

/** A `waiting` agent is stalled on the user, so it is deliberately NOT running. */
export function runningAgentCount(agents: WorkflowAgentInfo[]): number {
  return agents.filter((a) => a.status === 'running').length;
}

/** §8 line 3: `7 agents · 3 running` — the running clause only when there is one. */
export function agentCountLabel(agents: WorkflowAgentInfo[]): string {
  const head = `${agents.length} agent${agents.length === 1 ? '' : 's'}`;
  const running = runningAgentCount(agents);
  return running > 0 ? `${head} · ${running} running` : head;
}

// ---------- one agent's row (FR-16) ----------

/** FR-16: `(lastAt ?? now) - startedAt`, never negative on a clock skew. */
export function agentElapsedMs(agent: WorkflowAgentInfo, now: number): number {
  return Math.max(0, (agent.lastAt ?? now) - agent.startedAt);
}

export interface RunWindow {
  startedAt: number;
  endedAt?: number;
}

/**
 * FR-16: the window EVERY row's bar is measured against. Normally the run's own
 * span; while `workflows_list` is still in flight it degrades to the earliest
 * agent start — one shared origin either way, because bars that each measured
 * against themselves would show no overlap at all, which is the one thing this
 * bar exists to show.
 */
export function runWindow(
  run: { startedAt: number; endedAt?: number } | null,
  agents: WorkflowAgentInfo[],
  now: number,
): RunWindow {
  if (run !== null) return { startedAt: run.startedAt, endedAt: run.endedAt };
  if (agents.length === 0) return { startedAt: now, endedAt: undefined };
  return { startedAt: Math.min(...agents.map((a) => a.startedAt)), endedAt: undefined };
}

export interface SpanBar {
  /** Percent offset from the run window's origin. */
  left: number;
  /** Percent of the run window the agent occupied. */
  width: number;
}

/**
 * FR-16 / §8: the span bar. Every row measures against ONE origin —
 * `[run.startedAt, run.endedAt ?? now]` — which is the whole point: overlapping
 * bars are how the user sees what `parallel`/`pipeline` actually did. A minimum
 * rendered width is the stylesheet's job (2px), not this function's.
 *
 * §2b: a `waiting` agent keeps its live fill but STOPS EXTENDING — it is
 * stalled, not working. `lastAt` stays absent while blocked (mirrors
 * `running`), so there is no journal timestamp to freeze against; the caller
 * supplies `frozenAt`, the `now` it observed the FIRST render the row was
 * `waiting` (see `WorkflowAgentRow`). Every render before that capture lands,
 * or when `waiting` with no `frozenAt` supplied yet, falls back to `now` so
 * the bar never jumps backward.
 */
export function spanBar(
  agent: WorkflowAgentInfo,
  run: { startedAt: number; endedAt?: number },
  now: number,
  frozenAt?: number,
): SpanBar {
  const window = Math.max(1, (run.endedAt ?? now) - run.startedAt);
  const clampPct = (x: number) => Math.min(100, Math.max(0, x));
  const left = clampPct(((agent.startedAt - run.startedAt) / window) * 100);
  const endAt = agent.status === 'waiting' ? (frozenAt ?? now) : (agent.lastAt ?? now);
  const end = clampPct(((endAt - run.startedAt) / window) * 100);
  return { left, width: Math.max(0, end - left) };
}

/**
 * §8's status triple plus the one blocked colour. `stopped` is NEVER `--error`:
 * the journal records no failure event, so an agent with no result simply never
 * returned (spec FR-4).
 */
export function agentStatusColor(status: WorkflowAgentStatus): string {
  if (status === 'running') return 'var(--accent-2)';
  if (status === 'done') return 'var(--success)';
  if (status === 'waiting') return 'var(--warn)'; // §8's `--warning`; --warn is this codebase's token
  return 'var(--text-muted)'; // stopped
}

/**
 * §8 2b: the span bar's fill. A `waiting` agent keeps the live colour — it is
 * blocked, not finished — and a `stopped` one settles to the same dim track a
 * `done` one gets, because the journal records no failure to colour red (FR-4).
 */
export function spanFillColor(status: WorkflowAgentStatus): string {
  return status === 'running' || status === 'waiting' ? 'var(--accent-2)' : 'var(--text-disabled)';
}

const RESULT_PREVIEW_MAX = 120;

/** FR-16: the row's one-line `→ …` preview of what the agent returned. */
export function resultPreview(result: string | undefined, max = RESULT_PREVIEW_MAX): string | null {
  if (result === undefined) return null;
  const line = result.split('\n').find((l) => l.trim() !== '');
  if (line === undefined) return null;
  const text = line.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** FR-17 / §8: the returned value, pretty-printed when it is JSON. */
export function prettyResult(result: string): string {
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result; // plain text — shown verbatim
  }
}

/**
 * FR-17: what "new activity for this agent" means. Used as the transcript
 * effect's dependency, so a `workflow.detail` flush that moved this agent
 * re-fetches its blocks and one that did not costs nothing.
 */
export function agentActivityKey(agent: WorkflowAgentInfo | undefined): string {
  if (agent === undefined) return '';
  return `${agent.status}:${agent.lastAt ?? 0}:${sumTokens(agent.tokens)}:${agent.result === undefined ? 0 : 1}`;
}

export function findAgent(agents: WorkflowAgentInfo[], agentId: string | null): WorkflowAgentInfo | undefined {
  return agentId === null ? undefined : agents.find((a) => a.agentId === agentId);
}

// ---------- asks raised inside the run (FR-25) ----------

/** §8 2c-bis: the note a rung-3 attribution carries — Francois guessed, and says so. */
export const INFERRED_NOTE = 'attributed by elimination';

/** The asks that resolved to this agent — rendered under its transcript header. */
export function asksForAgent(asks: WorkflowPendingAsk[], agentId: string): WorkflowPendingAsk[] {
  return asks.filter((ask) => ask.agentId === agentId);
}

/**
 * The asks that belong to no agent we can name — no `agentId` (ladder rung 3) or
 * one the scan has not seen yet. They sit at the top of the right column so they
 * are never hidden behind a selection.
 */
export function floatingAsks(asks: WorkflowPendingAsk[], agents: WorkflowAgentInfo[]): WorkflowPendingAsk[] {
  return asks.filter((ask) => ask.agentId === undefined || findAgent(agents, ask.agentId) === undefined);
}

/** §8 2c-bis: `{agentType} · {toolName}`, or `this workflow` when unattributed. */
export function askOwnerLabel(ask: WorkflowPendingAsk, agents: WorkflowAgentInfo[]): string {
  const agent = ask.agentId === undefined ? undefined : findAgent(agents, ask.agentId);
  if (agent === undefined) return 'this workflow';
  return ask.toolName ? `${agent.agentType} · ${ask.toolName}` : agent.agentType;
}

/**
 * §8: the one place this view raises its voice. A blocked run makes no progress
 * and produces no filesystem activity to notice, so the header says so outright.
 */
export function waitingBannerLabel(asks: WorkflowPendingAsk[]): string | null {
  if (asks.length === 0) return null;
  return `waiting on you — ${asks.length} approval${asks.length === 1 ? '' : 's'}`;
}

// ---------- ambient copy (§8: lowercase, English) ----------

export const NO_AGENTS_LABEL = 'no agents yet';
export const SELECT_AGENT_LABEL = 'select an agent';
export const NO_ACTIVITY_LABEL = 'no activity yet';
export const SCRIPT_TRUNCATED_LABEL = '… truncated at 200 KB';
export const RESULT_LABEL = 'returned';
export const SCRIPT_TOGGLE_LABEL = 'script';

/** FR-17: the dim leading row when the core's window dropped older blocks. */
export function earlierBlocksNotice(dropped: number): string | null {
  return dropped > 0 ? `… ${dropped} earlier block${dropped === 1 ? '' : 's'}` : null;
}
