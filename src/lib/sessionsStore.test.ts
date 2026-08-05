// sessions slice of the app store. Covers the two selection paths split-session
// deliberately keeps apart (FR-8 vs FR-20):
//  - `setActiveSessionId` is the USER pick: assigning the right pane's session
//    to the left side SWAPS the two panes.
//  - `reassignActiveSessionId` is the post-REMOVAL fallback: the session it
//    replaces no longer exists, so there is nothing to swap it with — it must
//    stay a plain reassignment even when the nearest remaining session happens
//    to be the one in the right pane.

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
    splitSessionId: null,
    splitTab: 'session',
    focusedSide: 'left',
  });
});

describe('setActiveSessionId (FR-8)', () => {
  it('SWAPS the panes when the pick is the right pane’s session', () => {
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff', splitSessionId: 's2', splitTab: 'shell' });
    useStore.getState().setActiveSessionId('s2');
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s2');
    expect(s.splitSessionId).toBe('s1');
    expect(s.mainTab).toBe('shell');
    expect(s.splitTab).toBe('diff');
  });
});

describe('reassignActiveSessionId (FR-20)', () => {
  it('never swaps, even when the target IS the right pane’s session', () => {
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff', splitSessionId: 's2', splitTab: 'shell' });
    useStore.getState().reassignActiveSessionId('s2');
    const s = useStore.getState();
    expect(s.activeSessionId).toBe('s2');
    // the right pane is untouched — the caller (reassignAfterRemoval) unsplits
    // right after, and a transient swap would smuggle the REMOVED id into it.
    expect(s.splitSessionId).toBe('s2');
    expect(s.splitTab).toBe('shell');
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
