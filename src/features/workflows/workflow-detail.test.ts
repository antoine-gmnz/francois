// workflow-details (specs/workflow-details.md FR-14..FR-19, FR-25) — the tab's
// pure half: the detail hydration race, the per-agent transcript state, the
// span/token/elapsed derivations, the ask attribution read-model, and the three
// contract-typed invoke wrappers. No DOM involved.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import type { AgentBlock } from '../../../contract/agent-tab';
import type {
  WorkflowAgentInfo,
  WorkflowDetail,
  WorkflowPendingAsk,
  WorkflowTokens,
} from '../../../contract/workflow-details';
import { workflowsAgent, workflowsDetail, workflowsScript } from '../../lib/api';
import {
  CLOSED_DETAIL,
  CLOSED_SCRIPT,
  CLOSED_TRANSCRIPT,
  INFERRED_NOTE,
  SELECT_AGENT_LABEL,
  agentActivityKey,
  agentCountLabel,
  agentElapsedMs,
  agentStatusColor,
  askOwnerLabel,
  asksForAgent,
  findAgent,
  floatingAsks,
  formatTokens,
  openAgentTranscript,
  openDetail,
  openScriptRequest,
  prettyResult,
  receiveAgentBlocks,
  receiveDetail,
  receiveDetailEvent,
  receiveScript,
  refreshAgentTranscript,
  resultPreview,
  rightColumnMode,
  runWindow,
  spanBar,
  spanFillColor,
  sumTokens,
  waitingBannerLabel,
} from './workflow-detail';

const TOKENS: WorkflowTokens = { input: 100, output: 20, cacheRead: 1000, cacheCreation: 80 };

function agent(id: string, over: Partial<WorkflowAgentInfo> = {}): WorkflowAgentInfo {
  return {
    agentId: id,
    agentType: 'frontend',
    status: 'running',
    startedAt: 1_000,
    prompt: 'build the tab',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    ...over,
  };
}

function detail(over: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return {
    id: 'run-1',
    sessionId: 's1',
    transcriptDir: '/tmp/run-1',
    hasScript: true,
    agents: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    pendingAsks: [],
    ...over,
  };
}

function textBlock(n: number): AgentBlock {
  return {
    kind: 'assistant',
    blockId: `b${n}`,
    isStreaming: false,
    glyph: '●',
    glyphColor: '#8b93a3',
    bodyColor: '#c3c9d4',
    text: `line ${n}`,
  };
}

// ---------- detail hydration race (FR-14) ----------

describe('detail state', () => {
  it('opening starts empty and loading under the given request id', () => {
    const s = openDetail('run-1', 7);
    expect(s).toEqual({ ...CLOSED_DETAIL, runId: 'run-1', reqId: 7, loading: true });
  });

  it('applies a workflow.detail event once hydrated', () => {
    let s = openDetail('run-1', 1);
    s = receiveDetail(s, 1, { ok: true, data: detail() });
    s = receiveDetailEvent(s, detail({ agents: [agent('a1')] }));
    expect(s.detail?.agents).toHaveLength(1);
  });

  it('buffers an event that beats the response, and never lets the response overwrite it (FR-14)', () => {
    let s = openDetail('run-1', 1);
    const live = detail({ agents: [agent('a1'), agent('a2')] });
    s = receiveDetailEvent(s, live);
    expect(s.detail).toBeNull(); // nothing rendered before hydration
    s = receiveDetail(s, 1, { ok: true, data: detail({ agents: [agent('a1')] }) });
    expect(s.detail).toEqual(live); // the newer event wins over the staler snapshot
    expect(s.hydrated).toBe(true);
    expect(s.loading).toBe(false);
  });

  it('ignores an event for another run and a stale response', () => {
    const s = openDetail('run-1', 2);
    expect(receiveDetailEvent(s, detail({ id: 'run-2' }))).toBe(s);
    expect(receiveDetail(s, 1, { ok: true, data: detail() })).toBe(s);
  });

  it('stores an error response and clears it when a later event proves the run readable', () => {
    let s = openDetail('run-1', 1);
    s = receiveDetail(s, 1, { ok: false, error: { code: 'WORKFLOW_NO_TRANSCRIPT', message: 'no dir' } });
    expect(s.error?.code).toBe('WORKFLOW_NO_TRANSCRIPT');
    expect(s.loading).toBe(false);
    s = receiveDetailEvent(s, detail());
    expect(s.error).toBeNull();
    expect(s.detail).not.toBeNull();
  });
});

// ---------- the selected agent's transcript (FR-17) ----------

describe('agent transcript state', () => {
  it('opening a different agent starts empty and loading', () => {
    const s = openAgentTranscript('a1', 3);
    expect(s).toEqual({ ...CLOSED_TRANSCRIPT, agentId: 'a1', reqId: 3, loading: true });
  });

  it('refreshing the SAME agent keeps the rendered blocks (no blank flash per flush)', () => {
    let s = openAgentTranscript('a1', 1);
    s = receiveAgentBlocks(s, 1, { ok: true, data: { blocks: [textBlock(1)], dropped: 0 } });
    const refreshed = refreshAgentTranscript(s, 2);
    expect(refreshed.blocks).toEqual([textBlock(1)]);
    expect(refreshed.loading).toBe(false);
    expect(refreshed.reqId).toBe(2);
  });

  it('applies the response, carrying the dropped count (FR-17)', () => {
    let s = openAgentTranscript('a1', 1);
    s = receiveAgentBlocks(s, 1, { ok: true, data: { blocks: [textBlock(1), textBlock(2)], dropped: 12 } });
    expect(s.blocks).toHaveLength(2);
    expect(s.dropped).toBe(12);
    expect(s.hydrated).toBe(true);
    expect(s.loading).toBe(false);
  });

  it('ignores a stale response and stores an error one', () => {
    const s = openAgentTranscript('a1', 4);
    expect(receiveAgentBlocks(s, 3, { ok: true, data: { blocks: [], dropped: 0 } })).toBe(s);
    const errored = receiveAgentBlocks(s, 4, {
      ok: false,
      error: { code: 'WORKFLOW_AGENT_NOT_FOUND', message: 'gone' },
    });
    expect(errored.error?.message).toBe('gone');
    expect(errored.loading).toBe(false);
  });
});

// ---------- derivations (FR-15, FR-16) ----------

describe('tokens', () => {
  it('sums every bucket of a WorkflowTokens', () => {
    expect(sumTokens(TOKENS)).toBe(1200);
  });

  it('formats compactly, lowercase, without a trailing .0', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1200)).toBe('1.2k');
    expect(formatTokens(340_000)).toBe('340k');
    expect(formatTokens(2_000_000)).toBe('2m');
  });
});

describe('agentCountLabel', () => {
  it('counts agents, singular and plural, and appends the running count only when there is one', () => {
    expect(agentCountLabel([])).toBe('0 agents');
    expect(agentCountLabel([agent('a1', { status: 'done' })])).toBe('1 agent');
    expect(agentCountLabel([agent('a1'), agent('a2', { status: 'done' }), agent('a3')])).toBe('3 agents · 2 running');
  });

  it('does not count a waiting agent as running — it is stalled, not working', () => {
    expect(agentCountLabel([agent('a1', { status: 'waiting' })])).toBe('1 agent');
  });
});

describe('agentElapsedMs', () => {
  it('runs to now while the agent is live and freezes at lastAt once it is not', () => {
    expect(agentElapsedMs(agent('a1', { startedAt: 1_000 }), 4_000)).toBe(3_000);
    expect(agentElapsedMs(agent('a1', { startedAt: 1_000, lastAt: 2_500 }), 9_000)).toBe(1_500);
  });

  it('never goes negative on a clock skew', () => {
    expect(agentElapsedMs(agent('a1', { startedAt: 5_000 }), 1_000)).toBe(0);
  });
});

describe('spanBar', () => {
  const run = { startedAt: 1_000, endedAt: 2_000 };

  it('positions a span proportionally inside the run window (FR-16)', () => {
    const bar = spanBar(agent('a1', { startedAt: 1_200, lastAt: 1_700 }), run, 5_000);
    expect(bar.left).toBeCloseTo(20);
    expect(bar.width).toBeCloseTo(50);
  });

  it('shares one origin so concurrent agents overlap', () => {
    const left = spanBar(agent('a1', { startedAt: 1_000, lastAt: 1_600 }), run, 5_000);
    const right = spanBar(agent('a2', { startedAt: 1_400, lastAt: 2_000 }), run, 5_000);
    expect(left.left).toBe(0);
    expect(right.left).toBeCloseTo(40);
    expect(left.left + left.width).toBeGreaterThan(right.left); // they overlap
  });

  it('measures a live run against now, not against a missing endedAt', () => {
    const bar = spanBar(agent('a1', { startedAt: 1_500 }), { startedAt: 1_000 }, 2_000);
    expect(bar.left).toBeCloseTo(50);
    expect(bar.width).toBeCloseTo(50);
  });

  it('clamps to the window and never returns a negative width', () => {
    const bar = spanBar(agent('a1', { startedAt: 500, lastAt: 9_000 }), run, 2_000);
    expect(bar.left).toBe(0);
    expect(bar.width).toBe(100);
    const instant = spanBar(agent('a1', { startedAt: 1_000, lastAt: 1_000 }), { startedAt: 1_000, endedAt: 1_000 }, 1_000);
    expect(instant.width).toBeGreaterThanOrEqual(0);
  });

  // §2b: a waiting agent's fill stays live but the bar stops extending — the
  // caller freezes it at the `now` it first observed `waiting`.
  it('freezes a waiting agent at frozenAt instead of growing with now', () => {
    const waitingAgent = agent('a1', { startedAt: 1_200, status: 'waiting' });
    const frozen = spanBar(waitingAgent, run, 1_400, 1_400);
    const later = spanBar(waitingAgent, run, 1_900, 1_400); // now advanced, frozenAt did not
    expect(later).toEqual(frozen);
    expect(later.width).toBeCloseTo(20); // (1_400 - 1_200) / 1_000 * 100
  });

  it('falls back to now while waiting with no frozenAt supplied yet', () => {
    const waitingAgent = agent('a1', { startedAt: 1_200, status: 'waiting' });
    const bar = spanBar(waitingAgent, run, 1_400);
    expect(bar.width).toBeCloseTo(20);
  });
});

describe('agentStatusColor', () => {
  it('uses the established triple, and --warn only for a blocked agent', () => {
    expect(agentStatusColor('running')).toBe('var(--accent-2)');
    expect(agentStatusColor('done')).toBe('var(--success)');
    // §8: a stopped agent is NOT an error — never --error.
    expect(agentStatusColor('stopped')).toBe('var(--text-muted)');
    expect(agentStatusColor('waiting')).toBe('var(--warn)');
  });
});

describe('result rendering', () => {
  it('previews the first non-blank line, ellipsized', () => {
    expect(resultPreview(undefined)).toBeNull();
    expect(resultPreview('  \n ok, shipped \nmore')).toBe('ok, shipped');
    expect(resultPreview('x'.repeat(200))).toBe(`${'x'.repeat(119)}…`);
  });

  it('pretty-prints a JSON result and leaves plain text alone', () => {
    expect(prettyResult('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyResult('done')).toBe('done');
  });
});

describe('agentActivityKey (FR-17 refetch trigger)', () => {
  it('changes when the agent gained tokens, a newer line, a status or a result', () => {
    const base = agent('a1', { lastAt: 10 });
    expect(agentActivityKey(base)).toBe(agentActivityKey(agent('a1', { lastAt: 10 })));
    expect(agentActivityKey(base)).not.toBe(agentActivityKey(agent('a1', { lastAt: 11 })));
    expect(agentActivityKey(base)).not.toBe(agentActivityKey(agent('a1', { lastAt: 10, status: 'done' })));
    expect(agentActivityKey(base)).not.toBe(
      agentActivityKey(agent('a1', { lastAt: 10, tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 } })),
    );
    expect(agentActivityKey(base)).not.toBe(agentActivityKey(agent('a1', { lastAt: 10, result: 'ok' })));
    expect(agentActivityKey(undefined)).toBe('');
  });
});

// ---------- asks attributed to the run (FR-25) ----------

describe('pending asks', () => {
  const agents = [agent('a1', { agentType: 'backend' }), agent('a2')];
  const exact: WorkflowPendingAsk = { blockId: 'b1', kind: 'permission', agentId: 'a1', toolName: 'Bash', confidence: 'exact' };
  const guessed: WorkflowPendingAsk = { blockId: 'b2', kind: 'question', confidence: 'inferred' };
  const orphan: WorkflowPendingAsk = { blockId: 'b3', kind: 'permission', agentId: 'gone', confidence: 'exact' };

  it('groups an ask under the agent it resolved to', () => {
    expect(asksForAgent([exact, guessed], 'a1')).toEqual([exact]);
    expect(asksForAgent([exact, guessed], 'a2')).toEqual([]);
  });

  it('floats an ask with no agent — or one naming an agent the scan never saw — to the top', () => {
    expect(floatingAsks([exact, guessed, orphan], agents)).toEqual([guessed, orphan]);
  });

  it('labels ownership honestly', () => {
    expect(askOwnerLabel(exact, agents)).toBe('backend · Bash');
    expect(askOwnerLabel({ ...exact, toolName: undefined }, agents)).toBe('backend');
    expect(askOwnerLabel(guessed, agents)).toBe('this workflow');
    expect(askOwnerLabel(orphan, agents)).toBe('this workflow');
    expect(INFERRED_NOTE).toBe('attributed by elimination');
  });

  it('raises the waiting banner only while something is blocking, pluralized', () => {
    expect(waitingBannerLabel([])).toBeNull();
    expect(waitingBannerLabel([exact])).toBe('waiting on you — 1 approval');
    expect(waitingBannerLabel([exact, guessed])).toBe('waiting on you — 2 approvals');
  });

  it('finds an agent by id', () => {
    expect(findAgent(agents, 'a1')?.agentType).toBe('backend');
    expect(findAgent(agents, 'nope')).toBeUndefined();
  });
});

// ---------- the right column's mode (FR-15, §8 2c-bis/2d/2e) ----------

describe('rightColumnMode', () => {
  it('shows the script whenever the toggle is on, over any selection', () => {
    expect(rightColumnMode({ scriptOpen: true, selectedAgentId: 'a1', askCount: 2 })).toBe('script');
  });

  it('shows the selected agent transcript', () => {
    expect(rightColumnMode({ scriptOpen: false, selectedAgentId: 'a1', askCount: 0 })).toBe('transcript');
  });

  // §8 2c-bis: with nothing selected and something blocking, the ask IS the column.
  it('shows the pending ask instead of `select an agent` when nothing is selected', () => {
    expect(rightColumnMode({ scriptOpen: false, selectedAgentId: null, askCount: 1 })).toBe('asks');
  });

  it('falls back to the run summary', () => {
    expect(rightColumnMode({ scriptOpen: false, selectedAgentId: null, askCount: 0 })).toBe('summary');
    expect(SELECT_AGENT_LABEL).toBe('select an agent');
  });
});

// ---------- the script source (FR-9, §8 2d) ----------

describe('script state', () => {
  const script = { path: '/tmp/run-1/script.js', source: 'export default 1', truncated: false };

  it('opening keeps whatever is on screen and marks the request in flight', () => {
    const s = openScriptRequest(CLOSED_SCRIPT, 1);
    expect(s).toEqual({ ...CLOSED_SCRIPT, reqId: 1, loading: true });
    // a re-open never blanks the column — the source is immutable for the run
    expect(openScriptRequest({ ...s, loading: false, script }, 2).script).toEqual(script);
  });

  it('stores the source', () => {
    let s = openScriptRequest(CLOSED_SCRIPT, 1);
    s = receiveScript(s, s.reqId, { ok: true, data: script });
    expect(s.script).toEqual(script);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  // §7: the script file went away between the ack and the click — an inline row
  // in the column, never a closed tab.
  it('stores WORKFLOW_NO_SCRIPT as an inline error', () => {
    let s = openScriptRequest(CLOSED_SCRIPT, 1);
    s = receiveScript(s, s.reqId, { ok: false, error: { code: 'WORKFLOW_NO_SCRIPT', message: 'gone' } });
    expect(s.error?.code).toBe('WORKFLOW_NO_SCRIPT');
    expect(s.script).toBeNull();
    expect(s.loading).toBe(false);
  });

  it('ignores a superseded response', () => {
    const s = openScriptRequest(CLOSED_SCRIPT, 1);
    expect(receiveScript(s, s.reqId - 1, { ok: true, data: script })).toBe(s);
  });
});

// ---------- the one origin every bar is measured against (FR-16, §8 2b) ----------

describe('runWindow', () => {
  const run = { startedAt: 500, endedAt: undefined as number | undefined };

  it('is the run itself once the panel snapshot has landed', () => {
    expect(runWindow(run, [agent('a1', { startedAt: 900 })], 5_000)).toEqual({ startedAt: 500, endedAt: undefined });
    expect(runWindow({ startedAt: 500, endedAt: 900 }, [], 5_000)).toEqual({ startedAt: 500, endedAt: 900 });
  });

  // Bars share ONE origin — that is the entire point — so before the run lands
  // every row still measures against the same earliest start, never its own.
  it('falls back to the earliest agent start, not each row s own, while the run is unknown', () => {
    expect(runWindow(null, [agent('a1', { startedAt: 900 }), agent('a2', { startedAt: 700 })], 5_000)).toEqual({
      startedAt: 700,
      endedAt: undefined,
    });
  });

  it('degenerates to an empty window with no run and no agents', () => {
    expect(runWindow(null, [], 5_000)).toEqual({ startedAt: 5_000, endedAt: undefined });
  });
});

// ---------- the span bar's fill (§8 2b) ----------

describe('spanFillColor', () => {
  it('is live while the agent works — including while it is blocked on the user', () => {
    expect(spanFillColor('running')).toBe('var(--accent-2)');
    expect(spanFillColor('waiting')).toBe('var(--accent-2)');
  });

  it('settles to a dim track once the agent stopped, never an error colour (FR-4)', () => {
    expect(spanFillColor('done')).toBe('var(--text-disabled)');
    expect(spanFillColor('stopped')).toBe('var(--text-disabled)');
  });
});

// ---------- contract bindings (§5) ----------

describe('workflows invoke wrappers', () => {
  beforeEach(() => invokeMock.mockReset());

  it('workflows_detail carries the runId and returns the Result verbatim', async () => {
    const data = detail();
    invokeMock.mockResolvedValue({ ok: true, data });
    await expect(workflowsDetail('run-1')).resolves.toEqual({ ok: true, data });
    expect(invokeMock).toHaveBeenCalledWith('workflows_detail', { runId: 'run-1' });
  });

  it('workflows_agent carries the runId and the agentId', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { blocks: [], dropped: 0 } });
    await workflowsAgent('run-1', 'a1');
    expect(invokeMock).toHaveBeenCalledWith('workflows_agent', { runId: 'run-1', agentId: 'a1' });
  });

  it('workflows_script carries the runId', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { path: '/tmp/s.js', source: '', truncated: false } });
    await workflowsScript('run-1');
    expect(invokeMock).toHaveBeenCalledWith('workflows_script', { runId: 'run-1' });
  });
});
