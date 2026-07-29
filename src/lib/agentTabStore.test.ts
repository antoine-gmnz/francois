// agent-tab slice of the app store (specs/agent-tab.md FR-10..FR-14). Covers the
// wiring the pure helpers in features/agents/agent-tab.ts cannot: that opening a
// tab also ACTIVATES it, that closing the active one hands the main pane back to
// SESSION, and that a session switch — but not re-selecting the same session —
// wipes the tabs.

import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentTabRef } from '../features/agents/agent-tab';
import { useStore } from './store';

const A1: AgentTabRef = { id: 'a1', name: 'explorer', status: 'running' };
const A2: AgentTabRef = { id: 'a2', name: 'reviewer', status: 'running' };

beforeEach(() => {
  useStore.setState({ agentTabs: [], mainTab: 'session', activeSessionId: null });
});

describe('agent tab store slice', () => {
  it('opening a tab activates it (FR-10)', () => {
    useStore.getState().openAgentTab(A1);
    expect(useStore.getState().agentTabs.map((t) => t.id)).toEqual(['a1']);
    expect(useStore.getState().mainTab).toBe('agent:a1');

    useStore.getState().openAgentTab(A2);
    expect(useStore.getState().mainTab).toBe('agent:a2');
    // re-opening a1 re-activates without duplicating
    useStore.getState().openAgentTab(A1);
    expect(useStore.getState().agentTabs.map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(useStore.getState().mainTab).toBe('agent:a1');
  });

  it('closing the ACTIVE tab falls back to SESSION, an inactive one does not (FR-13)', () => {
    useStore.getState().openAgentTab(A1);
    useStore.getState().openAgentTab(A2); // a2 active
    useStore.getState().closeAgentTab('a1');
    expect(useStore.getState().agentTabs.map((t) => t.id)).toEqual(['a2']);
    expect(useStore.getState().mainTab).toBe('agent:a2');

    useStore.getState().closeAgentTab('a2');
    expect(useStore.getState().agentTabs).toEqual([]);
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('syncs an open tab from an agent.update without activating anything', () => {
    useStore.getState().openAgentTab(A1);
    useStore.setState({ mainTab: 'diff' });
    useStore.getState().syncAgentTab({ id: 'a1', name: 'explorer', status: 'done' });
    expect(useStore.getState().agentTabs[0].status).toBe('done');
    expect(useStore.getState().mainTab).toBe('diff'); // never steals the pane
    // an update for an agent with no tab is a no-op
    const before = useStore.getState().agentTabs;
    useStore.getState().syncAgentTab({ id: 'nope', name: 'x', status: 'running' });
    expect(useStore.getState().agentTabs).toBe(before);
  });

  it('a session SWITCH closes every agent tab; re-selecting the same one does not (FR-14)', () => {
    useStore.setState({ activeSessionId: 's1' });
    useStore.getState().openAgentTab(A1);

    // clicking the row of the session you are already on must not wipe the tabs
    useStore.getState().setActiveSessionId('s1');
    expect(useStore.getState().agentTabs).toHaveLength(1);
    expect(useStore.getState().mainTab).toBe('agent:a1');

    useStore.getState().setActiveSessionId('s2');
    expect(useStore.getState().agentTabs).toEqual([]);
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('a session switch leaves a built-in tab alone (FR-14)', () => {
    useStore.setState({ activeSessionId: 's1', mainTab: 'diff' });
    useStore.getState().openAgentTab(A1);
    useStore.setState({ mainTab: 'diff' });
    useStore.getState().setActiveSessionId('s2');
    expect(useStore.getState().agentTabs).toEqual([]);
    expect(useStore.getState().mainTab).toBe('diff');
  });

  it('clearAgentTabs is a no-op when nothing is open', () => {
    const before = useStore.getState().agentTabs;
    useStore.getState().clearAgentTabs();
    expect(useStore.getState().agentTabs).toBe(before);
    expect(useStore.getState().mainTab).toBe('session');
  });
});
