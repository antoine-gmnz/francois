// agent-tab (specs/agent-tab.md FR-9..FR-21) — the tab strip's open/close/evict
// rules, the transcript hydration race, and the agents_transcript contract
// binding. Sibling of agent-trail.test.ts; no DOM involved.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import type { AgentStatus } from '../../../contract/common';
import type { AgentBlock, AgentEvent } from '../../../contract/agent-tab';
import { agentsTranscript } from '../../lib/api';
import {
  AGENT_TAB_CAP,
  AGENT_TAB_NAME_MAX,
  CLOSED_TRANSCRIPT,
  agentBannerMeta,
  agentBannerShowsStop,
  agentIdFromTab,
  agentTabId,
  agentTabLabel,
  blockOrdinal,
  closeTab,
  earlierBlocksNotice,
  mainTabAfterClose,
  mergeAgentBlock,
  openTab,
  openTranscript,
  receiveAgentBlock,
  receiveAgentTranscript,
  routeAgentEventToTranscript,
  syncTab,
  tabIdFor,
  workflowIdFromTab,
  workflowTabId,
  type AgentTabRef,
} from './agent-tab';

function ref(id: string, status: AgentStatus = 'running'): AgentTabRef {
  return { id, name: `agent-${id}`, status };
}

function textBlock(agentId: string, n: number, text = `line ${n}`): AgentBlock {
  return {
    kind: 'assistant',
    blockId: `${agentId}:${n}`,
    isStreaming: false,
    glyph: '●',
    glyphColor: '#8b93a3',
    bodyColor: '#c3c9d4',
    text,
  };
}

function toolBlock(agentId: string, n: number, meta?: string): AgentBlock {
  return {
    kind: 'tool',
    blockId: `${agentId}:${n}`,
    isStreaming: meta === undefined,
    tool: 'Read',
    glyph: '⧉',
    glyphColor: '#8b93a3',
    bodyColor: '#8b93a3',
    summary: 'src/session.rs',
    ...(meta === undefined ? {} : { meta }),
  };
}

// ---------- tab identity (FR-9) ----------

describe('tab identity', () => {
  it('round-trips an agent id through its MainTab value', () => {
    expect(agentTabId('a1')).toBe('agent:a1');
    expect(agentIdFromTab('agent:a1')).toBe('a1');
  });

  it('reads a built-in tab as "no agent"', () => {
    for (const t of ['overview', 'session', 'diff', 'shell']) {
      expect(agentIdFromTab(t)).toBeNull();
    }
  });

  it('truncates a long agent name for the strip (§8)', () => {
    expect(agentTabLabel('explorer')).toBe('explorer');
    expect(agentTabLabel('  ')).toBe('agent');
    const long = agentTabLabel('a-very-long-agent-name');
    expect(long).toHaveLength(AGENT_TAB_NAME_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});

// ---------- the open tab set (FR-10..FR-14) ----------

describe('open tab set', () => {
  it('appends in open order and never duplicates an agent (FR-10)', () => {
    const tabs = openTab(openTab([], ref('a1')), ref('a2'));
    expect(tabs.map((t) => t.id)).toEqual(['a1', 'a2']);
    // clicking a1 again: same array identity, same position — no reshuffle
    expect(openTab(tabs, ref('a1'))).toBe(tabs);
  });

  it('updates an already-open tab in place rather than reordering it', () => {
    const tabs = openTab(openTab([], ref('a1')), ref('a2'));
    const next = openTab(tabs, { id: 'a1', name: 'renamed', status: 'done' });
    expect(next.map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(next[0]).toEqual({ id: 'a1', name: 'renamed', status: 'done' });
  });

  it('evicts the OLDEST tab past the cap, never the one being opened (FR-11)', () => {
    let tabs: AgentTabRef[] = [];
    for (let i = 1; i <= AGENT_TAB_CAP; i++) tabs = openTab(tabs, ref(`a${i}`));
    expect(tabs).toHaveLength(AGENT_TAB_CAP);
    const next = openTab(tabs, ref('new'));
    expect(next).toHaveLength(AGENT_TAB_CAP);
    expect(next[0].id).toBe('a2'); // a1 dropped
    expect(next[next.length - 1].id).toBe('new'); // the opened one survives
  });

  it('syncs an open tab and ignores an agent with no tab', () => {
    const tabs = openTab([], ref('a1'));
    const next = syncTab(tabs, { id: 'a1', name: 'agent-a1', status: 'done' });
    expect(next[0].status).toBe('done');
    // an unchanged ref returns the SAME array — the strip must not re-render on
    // every step of every agent
    expect(syncTab(next, { id: 'a1', name: 'agent-a1', status: 'done' })).toBe(next);
    expect(syncTab(tabs, ref('other'))).toBe(tabs);
  });

  it('closes one tab and leaves the array alone when it is not open', () => {
    const tabs = openTab(openTab([], ref('a1')), ref('a2'));
    expect(closeTab(tabs, 'a1').map((t) => t.id)).toEqual(['a2']);
    expect(closeTab(tabs, 'nope')).toBe(tabs);
  });

  it('falls back to SESSION only when the ACTIVE agent tab closes (FR-13)', () => {
    expect(mainTabAfterClose('agent:a1', ['a1'])).toBe('session');
    expect(mainTabAfterClose('agent:a1', ['a2'])).toBe('agent:a1');
    expect(mainTabAfterClose('diff', ['a1'])).toBe('diff'); // built-ins untouched
  });

  it('closes every agent tab on a session switch (FR-14)', () => {
    expect(mainTabAfterClose('agent:a1', null)).toBe('session');
    expect(mainTabAfterClose('overview', null)).toBe('overview');
  });
});

// ---------- workflow-details FR-12: one dynamic-tab list for both kinds ----------

describe('workflow tabs share this machinery', () => {
  const wf = (id: string): AgentTabRef => ({ id, name: `wf-${id}`, status: 'running', kind: 'workflow' });

  it('round-trips a run id through its MainTab value, distinct from an agent tab', () => {
    expect(workflowTabId('w1')).toBe('workflow:w1');
    expect(workflowIdFromTab('workflow:w1')).toBe('w1');
    expect(workflowIdFromTab('agent:a1')).toBeNull();
    expect(agentIdFromTab('workflow:w1')).toBeNull();
    for (const t of ['overview', 'session', 'diff', 'shell']) expect(workflowIdFromTab(t)).toBeNull();
  });

  it('keys a ref onto the tab id its kind implies, defaulting to agent', () => {
    expect(tabIdFor(wf('w1'))).toBe('workflow:w1');
    expect(tabIdFor(ref('a1'))).toBe('agent:a1');
  });

  it('shares ONE 6-tab cap and one eviction order with agent tabs (FR-12)', () => {
    let tabs: AgentTabRef[] = [];
    for (let i = 1; i <= AGENT_TAB_CAP - 1; i++) tabs = openTab(tabs, ref(`a${i}`));
    tabs = openTab(tabs, wf('w1'));
    expect(tabs).toHaveLength(AGENT_TAB_CAP);
    const next = openTab(tabs, wf('w2'));
    expect(next).toHaveLength(AGENT_TAB_CAP);
    expect(next[0].id).toBe('a2'); // the OLDEST went, agent or not
    expect(next[next.length - 1].id).toBe('w2');
  });

  it('closes an active workflow tab back to SESSION, and wipes both kinds on a session switch (FR-13)', () => {
    expect(mainTabAfterClose('workflow:w1', ['w1'])).toBe('session');
    expect(mainTabAfterClose('workflow:w1', ['w2'])).toBe('workflow:w1');
    expect(mainTabAfterClose('workflow:w1', null)).toBe('session');
  });

  it('re-opening a run refreshes it in place, and a kind change is a real change', () => {
    const tabs = openTab([], wf('w1'));
    expect(openTab(tabs, wf('w1'))).toBe(tabs);
    expect(syncTab(tabs, { id: 'w1', name: 'wf-w1', status: 'done', kind: 'workflow' })[0].status).toBe('done');
  });
});

// ---------- transcript state (FR-16..FR-21) ----------

describe('transcript state', () => {
  it('opening starts empty, loading and bottom-latched with a fresh reqId (FR-16)', () => {
    const t = openTranscript(CLOSED_TRANSCRIPT, 'a1');
    expect(t).toMatchObject({ agentId: 'a1', loading: true, hydrated: false, atBottom: true });
    expect(t.reqId).toBe(CLOSED_TRANSCRIPT.reqId + 1);
  });

  it('orders blocks by the core ordinal, not lexically', () => {
    // "a1:9" vs "a1:10": string order would put 10 first and scramble the tab.
    expect(blockOrdinal('a1:10')).toBe(10);
    expect(blockOrdinal('weird')).toBe(Number.MAX_SAFE_INTEGER);
    const list = mergeAgentBlock(mergeAgentBlock([], textBlock('a1', 10)), textBlock('a1', 9));
    expect(list.map((b) => b.blockId)).toEqual(['a1:9', 'a1:10']);
  });

  it('replaces a known blockId in place — the meta fill (FR-17)', () => {
    const open = mergeAgentBlock([], toolBlock('a1', 1));
    const filled = mergeAgentBlock(open, toolBlock('a1', 1, '120 lines'));
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ isStreaming: false, meta: '120 lines' });
  });

  it('buffers live blocks until hydration, then keeps them over the snapshot (FR-17)', () => {
    let t = openTranscript(CLOSED_TRANSCRIPT, 'a1');
    // a live meta-fill lands BEFORE the response, which still carries the open block
    t = receiveAgentBlock(t, 'a1', toolBlock('a1', 1, '120 lines'));
    expect(t.blocks).toHaveLength(0);
    expect(t.buffer).toHaveLength(1);
    t = receiveAgentTranscript(t, t.reqId, {
      ok: true,
      data: { blocks: [toolBlock('a1', 1), textBlock('a1', 2)], dropped: 3 },
    });
    expect(t.hydrated).toBe(true);
    expect(t.buffer).toHaveLength(0);
    expect(t.dropped).toBe(3);
    expect(t.blocks.map((b) => b.blockId)).toEqual(['a1:1', 'a1:2']);
    expect(t.blocks[0]).toMatchObject({ meta: '120 lines' }); // the live copy won
  });

  it('ignores blocks for another agent and a stale response', () => {
    let t = openTranscript(CLOSED_TRANSCRIPT, 'a1');
    expect(receiveAgentBlock(t, 'a2', textBlock('a2', 1))).toBe(t);
    expect(receiveAgentBlock(CLOSED_TRANSCRIPT, 'a1', textBlock('a1', 1))).toBe(CLOSED_TRANSCRIPT);
    const stale = receiveAgentTranscript(t, t.reqId - 1, { ok: true, data: { blocks: [], dropped: 0 } });
    expect(stale).toBe(t);
    t = receiveAgentTranscript(t, t.reqId, { ok: true, data: { blocks: [], dropped: 0 } });
    const ev: AgentEvent = { type: 'agent.block', sessionId: 's1', agentId: 'a1', block: textBlock('a1', 1) };
    expect(routeAgentEventToTranscript(t, ev).blocks).toHaveLength(1);
  });

  it('stores a transcript error and clears it once a live block proves the agent alive (FR-21)', () => {
    let t = openTranscript(CLOSED_TRANSCRIPT, 'a1');
    t = receiveAgentTranscript(t, t.reqId, {
      ok: false,
      error: { code: 'AGENT_NOT_FOUND', message: 'no such agent' },
    });
    expect(t.error?.code).toBe('AGENT_NOT_FOUND');
    expect(t.loading).toBe(false);
    t = receiveAgentBlock(t, 'a1', textBlock('a1', 1));
    expect(t.error).toBeNull();
    expect(t.blocks).toHaveLength(1);
  });

  it('announces the core window truncation, pluralized (FR-20)', () => {
    expect(earlierBlocksNotice(0)).toBeNull();
    expect(earlierBlocksNotice(1)).toBe('… 1 earlier block');
    expect(earlierBlocksNotice(50)).toBe('… 50 earlier blocks');
  });
});

// ---------- provenance banner (design chore: "you are inside a subagent") ----------

describe('agentBannerMeta', () => {
  it('carries the parent session name and a pluralized, honest step count — no model, no ctx', () => {
    expect(agentBannerMeta(1, 'Refactoring')).toEqual({ sessionName: 'Refactoring', stepsLabel: '1 step' });
    expect(agentBannerMeta(14, 'Refactoring')).toEqual({ sessionName: 'Refactoring', stepsLabel: '14 steps' });
    expect(agentBannerMeta(0, 'Refactoring')).toEqual({ sessionName: 'Refactoring', stepsLabel: '0 steps' });
  });

  it('reports no session name rather than inventing one when the parent is not in the store', () => {
    expect(agentBannerMeta(3, null)).toEqual({ sessionName: null, stepsLabel: '3 steps' });
  });
});

describe('agentBannerShowsStop', () => {
  it('offers Stop only while the agent is actually running — sessionInterrupt has no per-agent kill', () => {
    expect(agentBannerShowsStop('running')).toBe(true);
    for (const status of ['idle', 'done', 'error'] as AgentStatus[]) {
      expect(agentBannerShowsStop(status)).toBe(false);
    }
  });
});

// ---------- agentsTranscript wrapper (contract binding) ----------

describe('agentsTranscript (contract-typed invoke wrapper)', () => {
  beforeEach(() => invokeMock.mockReset());

  it('invokes agents_transcript with the agentId arg and returns the Result verbatim', async () => {
    const data = { blocks: [textBlock('a1', 1)], dropped: 0 };
    invokeMock.mockResolvedValue({ ok: true, data });
    await expect(agentsTranscript('a1')).resolves.toEqual({ ok: true, data });
    expect(invokeMock).toHaveBeenCalledWith('agents_transcript', { agentId: 'a1' });
  });
});
