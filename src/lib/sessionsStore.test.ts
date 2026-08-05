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
  return { id, name: id, lastActivityAt: 1 } as unknown as SessionMeta;
}

beforeEach(() => {
  useStore.setState({
    sessions: [],
    activeSessionId: null,
    agentTabs: [],
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

  it('closes the agent tabs and leaves a dynamic tab on a real switch', () => {
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'agent:a1',
      agentTabs: [{ kind: 'agent', id: 'a1', name: 'a', status: 'running' }],
    });
    useStore.getState().reassignActiveSessionId('s2');
    expect(useStore.getState().agentTabs).toEqual([]);
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('keeps the tabs when the id is unchanged', () => {
    useStore.setState({
      activeSessionId: 's1',
      mainTab: 'agent:a1',
      agentTabs: [{ kind: 'agent', id: 'a1', name: 'a', status: 'running' }],
    });
    useStore.getState().reassignActiveSessionId('s1');
    expect(useStore.getState().agentTabs).toHaveLength(1);
    expect(useStore.getState().mainTab).toBe('agent:a1');
  });

  it('accepts null when the last session goes away, leaving a built-in tab alone', () => {
    useStore.setState({ sessions: [meta('s1')], activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().reassignActiveSessionId(null);
    expect(useStore.getState().activeSessionId).toBeNull();
    expect(useStore.getState().mainTab).toBe('diff');
  });
});
