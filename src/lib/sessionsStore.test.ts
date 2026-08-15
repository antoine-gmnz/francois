// sessions slice of the app store. Covers the two selection paths split-by-4
// deliberately keeps apart (FR-19 vs FR-27):
//  - `setActiveSessionId` is the USER pick: assigning another pane's session to
//    pane 0 SWAPS the two panes.
//  - `reassignActiveSessionId` is the post-REMOVAL fallback: the session it
//    replaces no longer exists, so there is nothing to swap it with — it stays a
//    plain reassignment, and DROPS the pane that was already showing the target
//    rather than duplicating it.

import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../contract/common';
import { useStore } from './store';

function meta(id: string): SessionMeta {
  return {
    id,
    name: id,
    cwd: '/repo',
    model: { id: 'm', label: 'M' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt: 1,
    permissionMode: 'default',
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
  };
}

beforeEach(() => {
  useStore.setState({
    sessions: [],
    activeSessionId: null,
    agentTabs: new Map(),
    mainTab: 'session',
    extraPanes: [],
    focusedPaneIndex: 0,
  });
});

describe('setActiveSessionId (FR-19)', () => {
  it('SWAPS the panes when the pick is another pane’s session', () => {
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'diff',
      extraPanes: [{ sessionId: 's2', tab: 'shell' }],
    });
    useStore.getState().setActiveSessionId('s2');
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s2');
    expect(s.mainTab).toBe('shell');
    expect(s.extraPanes).toEqual([{ sessionId: 's1', tab: 'diff' }]);
  });
});

describe('reassignActiveSessionId (FR-27)', () => {
  it('never swaps — it DROPS the pane that was showing the target', () => {
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'diff',
      extraPanes: [{ sessionId: 's2', tab: 'shell' }],
    });
    useStore.getState().reassignActiveSessionId('s2');
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s2');
    // a swap would smuggle the REMOVED id back into a pane; the grid compacts
    // instead, and the session is never shown twice.
    expect(s.extraPanes).toEqual([]);
  });

  it('leaves a dynamic tab on a real switch but KEEPS the outgoing session’s tabs (fix-agent-view FR-8)', () => {
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'agent:a1',
      agentTabs: new Map([['s1', [{ kind: 'agent', id: 'a1', name: 'a', status: 'running' } as const]]]),
    });
    useStore.getState().reassignActiveSessionId('s2');
    // the PANE moves off a tab it no longer holds the session for…
    expect(useStore.getState().mainTab).toBe('session');
    // …but s1's tabs are still there, waiting for you to come back
    expect(useStore.getState().agentTabs.get('s1')).toHaveLength(1);
  });

  it('keeps the tabs when the id is unchanged', () => {
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'agent:a1',
      agentTabs: new Map([['s1', [{ kind: 'agent', id: 'a1', name: 'a', status: 'running' } as const]]]),
    });
    useStore.getState().reassignActiveSessionId('s1');
    expect(useStore.getState().agentTabs.get('s1')).toHaveLength(1);
    expect(useStore.getState().mainTab).toBe('agent:a1');
  });

  it('accepts null when the last session goes away, leaving a built-in tab alone', () => {
    useStore.setState({ sessions: [meta('s1')], activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().reassignActiveSessionId(null);
    expect(useStore.getState().activeSessionId).toBeNull();
    expect(useStore.getState().mainTab).toBe('diff');
  });
});

// multi-provider-seam FR-11a: the frontend gains NO state for `agentRuntime`/
// `protocol` — they are carried fields, set by the core at session_create and
// never re-derived here. Nothing in src reads them (the capability table has
// no frontend consumer), so the only way it can break is a store mutation that
// rebuilds a SessionMeta field-by-field instead of spreading it. That is what
// these lock.
describe('SessionMeta.agentRuntime/protocol are carried through the cache (multi-provider-seam FR-11a)', () => {
  function full(
    id: string,
    agentRuntime: SessionMeta['agentRuntime'],
    protocol: SessionMeta['protocol'],
  ): SessionMeta {
    return {
      id,
      name: id,
      cwd: '/repo',
      model: { id: 'm', label: 'M' },
      status: 'idle',
      contextUsedTokens: 0,
      contextLimitTokens: 0,
      startedAt: 0,
      lastActivityAt: 1,
      permissionMode: 'default',
      runtime: 'native',
      accountId: 'default',
      agentRuntime,
      protocol,
    };
  }

  it('survives every in-place patch (status / error / usage)', () => {
    useStore.getState().setSessions([full('s1', 'claude-code', 'anthropic')]);
    useStore.getState().patchStatus('s1', 'running');
    useStore.getState().patchError('s1', 'boom');
    useStore.getState().patchUsage('s1', 10, 100);
    const s = useStore.getState().sessions[0];
    expect(s.agentRuntime).toBe('claude-code');
    expect(s.protocol).toBe('anthropic');
    expect(s.status).toBe('running');
  });

  it('upsertSession adopts the incoming meta’s agentRuntime/protocol rather than pinning one', () => {
    useStore.getState().setSessions([full('s1', 'claude-code', 'anthropic')]);
    // A meta the core sent for a session created against an endpoint account —
    // the frontend must carry it verbatim, not map it back to 'claude-code'.
    useStore.getState().upsertSession(full('s1', 'francois', 'openai'));
    expect(useStore.getState().sessions).toHaveLength(1);
    expect(useStore.getState().sessions[0].agentRuntime).toBe('francois');
    expect(useStore.getState().sessions[0].protocol).toBe('openai');
    useStore.getState().upsertSession(full('s2', 'francois', 'openai'));
    expect(useStore.getState().sessions.map((x) => x.agentRuntime)).toEqual(['francois', 'francois']);
    expect(useStore.getState().sessions.map((x) => x.protocol)).toEqual(['openai', 'openai']);
  });
});
