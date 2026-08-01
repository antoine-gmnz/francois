// agent-tab — pure logic for the dynamic per-subagent main-pane tab
// (specs/agent-tab.md FR-9..FR-21). Sibling of agent-trail.ts: the tab strip's
// open/close/evict rules and the transcript hydration race live here so they are
// unit-testable without the DOM.

import type { AgentStatus, AppError, Result } from '../../../contract/common';
import type { AgentBlock, AgentEvent, AgentTranscript } from '../../../contract/agent-tab';

// ---------- tab identity (FR-9) ----------

const TAB_PREFIX = 'agent:';

/** FR-9: an agent tab's MainTab value. */
export function agentTabId(agentId: string): string {
  return `${TAB_PREFIX}${agentId}`;
}

/** The agent behind a MainTab value, or null for a built-in tab. */
export function agentIdFromTab(tab: string): string | null {
  return tab.startsWith(TAB_PREFIX) ? tab.slice(TAB_PREFIX.length) : null;
}

// ---------- workflow-details §6: the SAME open/close/evict/cap machinery,
// shared with a workflow run's tab. `agentTabs` is deliberately the ONE
// dynamic-tab list for both kinds (workflow-details FR-12) — see AgentTabRef's
// `kind` below and agentTabStore.ts. ----------

const WORKFLOW_TAB_PREFIX = 'workflow:';

/** workflow-details FR-11: a workflow run's MainTab value. */
export function workflowTabId(runId: string): string {
  return `${WORKFLOW_TAB_PREFIX}${runId}`;
}

/** The workflow run behind a MainTab value, or null for anything else. */
export function workflowIdFromTab(tab: string): string | null {
  return tab.startsWith(WORKFLOW_TAB_PREFIX) ? tab.slice(WORKFLOW_TAB_PREFIX.length) : null;
}

// ---------- the open tab set (FR-9..FR-14) ----------

/** FR-11: at most this many agent tabs are open at once. */
export const AGENT_TAB_CAP = 6;

/** §8: an agent name is truncated to this many chars in the strip. */
export const AGENT_TAB_NAME_MAX = 14;

/** workflow-details §6: which dynamic-tab machinery a ref belongs to. */
export type DynamicTabKind = 'agent' | 'workflow';

export interface AgentTabRef {
  id: string;
  name: string;
  /** Drives the strip's status dot (§8). WorkflowStatus is a subset of
   * AgentStatus's values, so a workflow ref's status widens here for free. */
  status: AgentStatus;
  /**
   * workflow-details §6: 'workflow' for a workflow run's tab. Optional and
   * defaults to 'agent' so every pre-existing agent-tab call site — none of
   * which ever set this — keeps compiling and behaving unchanged.
   */
  kind?: DynamicTabKind;
}

function tabKind(ref: AgentTabRef): DynamicTabKind {
  return ref.kind ?? 'agent';
}

/** workflow-details §6: the tab id a ref opens under, honoring its kind. */
export function tabIdFor(ref: AgentTabRef): string {
  return tabKind(ref) === 'workflow' ? workflowTabId(ref.id) : agentTabId(ref.id);
}

function sameRef(left: AgentTabRef, right: AgentTabRef): boolean {
  return left.id === right.id && left.name === right.name && left.status === right.status && tabKind(left) === tabKind(right);
}

export function agentTabLabel(name: string): string {
  const n = name.trim() || 'agent';
  return n.length > AGENT_TAB_NAME_MAX ? `${n.slice(0, AGENT_TAB_NAME_MAX - 1)}…` : n;
}

/**
 * FR-10/FR-11: open (or refresh) an agent's tab. An already-open agent is never
 * duplicated — its entry is updated in place, keeping its position, so clicking a
 * card twice does not reshuffle the strip. Past the cap the OLDEST tab is
 * dropped, never the one being opened.
 */
export function openTab(tabs: AgentTabRef[], ref: AgentTabRef): AgentTabRef[] {
  const i = tabs.findIndex((t) => t.id === ref.id);
  if (i >= 0) return syncTab(tabs, ref);
  const next = [...tabs, ref];
  return next.length > AGENT_TAB_CAP ? next.slice(next.length - AGENT_TAB_CAP) : next;
}

/**
 * Refresh an OPEN tab's name/status in place (the strip's status dot tracks
 * `agent.update`). Never opens a tab and never reorders one — an update for an
 * agent with no tab is a no-op, and an unchanged ref returns the same array so
 * React does not re-render the strip on every step of every agent.
 */
export function syncTab(tabs: AgentTabRef[], ref: AgentTabRef): AgentTabRef[] {
  const i = tabs.findIndex((t) => t.id === ref.id);
  if (i < 0 || sameRef(tabs[i], ref)) return tabs;
  const next = tabs.slice();
  next[i] = ref;
  return next;
}

export function closeTab(tabs: AgentTabRef[], agentId: string): AgentTabRef[] {
  return tabs.some((t) => t.id === agentId) ? tabs.filter((t) => t.id !== agentId) : tabs;
}

/**
 * FR-13/FR-14: which tab is active after `closedIds` were closed. Closing the
 * ACTIVE dynamic tab (agent OR workflow, workflow-details §6) falls back to
 * SESSION; closing any other leaves the active tab alone. `closedIds === null`
 * means "every dynamic tab" (the session switch, FR-14).
 */
export function mainTabAfterClose(current: string, closedIds: string[] | null): string {
  const id = agentIdFromTab(current) ?? workflowIdFromTab(current);
  if (id === null) return current; // a built-in tab is never disturbed
  if (closedIds === null || closedIds.includes(id)) return 'session';
  return current;
}

// ---------- transcript state (FR-16..FR-21) ----------

export interface TranscriptState {
  /** The agent whose transcript this is, or null when no agent tab is active. */
  agentId: string | null;
  /** Bumped on every open so a stale `agents_transcript` response is ignored. */
  reqId: number;
  blocks: AgentBlock[];
  /** FR-17: `agent.block` events seen before the response landed. */
  buffer: AgentBlock[];
  /** FR-20: blocks evicted past the core's window. */
  dropped: number;
  /** FR-16: the request is in flight — the body renders nothing. */
  loading: boolean;
  hydrated: boolean;
  error: AppError | null;
  /** FR-18: false once the user scrolled up inside the body. */
  atBottom: boolean;
}

export const CLOSED_TRANSCRIPT: TranscriptState = {
  agentId: null,
  reqId: 0,
  blocks: [],
  buffer: [],
  dropped: 0,
  loading: false,
  hydrated: false,
  error: null,
  atBottom: true,
};

/** FR-16: activating a tab starts an empty, loading, bottom-latched body. */
export function openTranscript(prev: TranscriptState, agentId: string): TranscriptState {
  return { ...CLOSED_TRANSCRIPT, agentId, reqId: prev.reqId + 1, loading: true };
}

/**
 * The ordinal the core minted into a `blockId` (`"{agentId}:{n}"`, FR-5). Used to
 * keep the list ordered when a buffered event is folded in after the snapshot;
 * an unparsable id sorts last so it can never displace a real block.
 */
export function blockOrdinal(blockId: string): number {
  const n = Number(blockId.slice(blockId.lastIndexOf(':') + 1));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * FR-17: insert-or-replace by `blockId`, ordered by the core's ordinal. Replacing
 * in place is how FR-2's `meta` fill lands without appending a second card.
 */
export function mergeAgentBlock(list: AgentBlock[], block: AgentBlock): AgentBlock[] {
  const i = list.findIndex((b) => b.blockId === block.blockId);
  if (i >= 0) {
    const next = list.slice();
    next[i] = block;
    return next;
  }
  const next = list.slice();
  const ord = blockOrdinal(block.blockId);
  let at = next.length;
  while (at > 0 && blockOrdinal(next[at - 1].blockId) > ord) at--;
  next.splice(at, 0, block);
  return next;
}

/** FR-17: apply a live `agent.block`, or buffer it until hydration. */
export function receiveAgentBlock(
  prev: TranscriptState,
  agentId: string,
  block: AgentBlock,
): TranscriptState {
  if (prev.agentId === null || prev.agentId !== agentId) return prev; // closed / another agent
  if (!prev.hydrated) return { ...prev, buffer: mergeAgentBlock(prev.buffer, block) };
  // A live block proves the agent is alive — clear a stored hydration error so the
  // body renders blocks again instead of staying on the error branch (the same
  // rule as receiveTrailStep).
  return { ...prev, blocks: mergeAgentBlock(prev.blocks, block), error: null };
}

/** Route a raw AgentEvent into the transcript. Foreign agents pass through. */
export function routeAgentEventToTranscript(prev: TranscriptState, e: AgentEvent): TranscriptState {
  if (e.type !== 'agent.block') return prev;
  return receiveAgentBlock(prev, e.agentId, e.block);
}

/**
 * FR-16/FR-17: the `agents_transcript` response. Buffered events are applied
 * AFTER the snapshot, so a block already seen live is never overwritten by an
 * older copy — the same race rule as async-agents FR-20.
 */
export function receiveAgentTranscript(
  prev: TranscriptState,
  reqId: number,
  res: Result<AgentTranscript>,
): TranscriptState {
  if (prev.agentId === null || prev.reqId !== reqId) return prev; // stale response
  if (!res.ok) {
    return { ...prev, loading: false, hydrated: true, buffer: [], error: res.error };
  }
  let blocks = [...res.data.blocks].sort((left, right) => blockOrdinal(left.blockId) - blockOrdinal(right.blockId));
  for (const block of prev.buffer) blocks = mergeAgentBlock(blocks, block);
  return {
    ...prev,
    loading: false,
    hydrated: true,
    buffer: [],
    blocks,
    dropped: res.data.dropped,
    error: null,
  };
}

/** FR-20: the dim leading row when the core's window dropped older blocks. */
export function earlierBlocksNotice(dropped: number): string | null {
  return dropped > 0 ? `… ${dropped} earlier block${dropped === 1 ? '' : 's'}` : null;
}
