// sessions slice of the app store. unbound-panes FR-5 deletes split-by-4
// FR-19's swap-on-reassign AND FR-27's dedup-on-reassignment half: both
// `setActiveSessionId` and `reassignActiveSessionId` are now a PLAIN assign —
// a session already showing in another pane is simply duplicated onto pane 0,
// never swapped out of it or dropped from it.

import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../contract/common';
import { useStore } from './store';

function meta(id: string): SessionMeta {
  return { id, name: id, lastActivityAt: 1 } as unknown as SessionMeta;
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

describe('setActiveSessionId (unbound-panes FR-5)', () => {
  it('is a PLAIN assign — a pick already showing in another pane is duplicated, never swapped', () => {
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'diff',
      extraPanes: [{ kind: 'session', sessionId: 's2', tab: 'shell' }],
    });
    useStore.getState().setActiveSessionId('s2');
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s2');
    // a built-in tab (diff/shell) is left alone on a switch — only a dynamic
    // agent/workflow tab folds (fix-agent-view FR-8, switchTo's own rule)
    expect(s.mainTab).toBe('diff');
    // the other pane keeps ITS session and tab untouched — no swap
    expect(s.extraPanes).toEqual([{ kind: 'session', sessionId: 's2', tab: 'shell' }]);
  });

  it('re-selecting the already-active session is a pure no-op', () => {
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().setActiveSessionId('s1');
    expect(useStore.getState().mainTab).toBe('diff');
  });
});

describe('reassignActiveSessionId (unbound-panes FR-5, supersedes split-by-4 FR-27 dedup)', () => {
  it('is now IDENTICAL to setActiveSessionId — no swap, no drop, duplicates allowed', () => {
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'diff',
      extraPanes: [{ kind: 'session', sessionId: 's2', tab: 'shell' }],
    });
    useStore.getState().reassignActiveSessionId('s2');
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s2');
    // FR-27's own other half (dropping a REMOVED session from every pane)
    // lives in `removeSession`, not here — this path never touches extraPanes.
    expect(s.extraPanes).toEqual([{ kind: 'session', sessionId: 's2', tab: 'shell' }]);
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
