// agent-tab slice of the app store (specs/agent-tab.md FR-10..FR-14, re-homed by
// specs/fix-agent-view.md FR-1..FR-10). Covers the wiring the pure helpers in
// features/agents/agent-tab.ts cannot: that opening a tab ACTIVATES it in the
// pane holding its session, that closing the active one hands that pane back to
// SESSION, and that a session switch keeps the other session's tabs.

import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentTabRef } from '../features/agents/agent-tab';
import { tabsForSession } from '../features/agents/agent-tab';
import type { PaneSlot } from './layoutStore';
import { useStore } from './store';

const A1: AgentTabRef = { id: 'a1', name: 'explorer', status: 'running' };
const A2: AgentTabRef = { id: 'a2', name: 'reviewer', status: 'running' };

/** The tab ids open for `sessionId`, in strip order. */
const idsFor = (sessionId: string) => tabsForSession(useStore.getState().agentTabs, sessionId).map((t) => t.id);

/** Panes 1..n, each holding one session on SESSION. */
const panes = (...sessionIds: (string | null)[]): PaneSlot[] =>
  sessionIds.map((sessionId) => ({ sessionId, tab: 'session' as const }));

beforeEach(() => {
  useStore.setState({
    agentTabs: new Map(),
    mainTab: 'session',
    activeSessionId: 's1',
    extraPanes: [],
    focusedPaneIndex: 0,
  });
});

describe('agent tab store slice', () => {
  it('opening a tab activates it in the pane holding its session (FR-4)', () => {
    useStore.getState().openAgentTab('s1', A1);
    expect(idsFor('s1')).toEqual(['a1']);
    expect(useStore.getState().mainTab).toBe('agent:a1');
    expect(useStore.getState().focusedPane).toBe('main');

    useStore.getState().openAgentTab('s1', A2);
    expect(useStore.getState().mainTab).toBe('agent:a2');
    // re-opening a1 re-activates without duplicating or reordering
    useStore.getState().openAgentTab('s1', A1);
    expect(idsFor('s1')).toEqual(['a1', 'a2']);
    expect(useStore.getState().mainTab).toBe('agent:a1');
  });

  it('is a complete no-op for a session on no pane (FR-4, §7 case 1)', () => {
    useStore.setState({ focusedPane: 'agents' });
    const before = useStore.getState().agentTabs;
    useStore.getState().openAgentTab('s9', A1);
    expect(useStore.getState().agentTabs).toBe(before);
    expect(useStore.getState().mainTab).toBe('session');
    // and it must not pull focus off the panel you clicked in
    expect(useStore.getState().focusedPane).toBe('agents');
  });

  it('opens into pane 1 when THAT pane holds the session (FR-4)', () => {
    useStore.setState({ extraPanes: panes('s2'), focusedPaneIndex: 1 });
    useStore.getState().openAgentTab('s2', A1);
    expect(useStore.getState().extraPanes[0].tab).toBe('agent:a1');
    expect(useStore.getState().mainTab).toBe('session'); // pane 0 untouched (FR-5)
    expect(idsFor('s2')).toEqual(['a1']);
    expect(idsFor('s1')).toEqual([]);
    // FR-5: opening never moves focus between panes
    expect(useStore.getState().focusedPaneIndex).toBe(1);
  });

  it('dismisses a dissolved-panel overlay when it opens in another pane (design 7a)', () => {
    // `mainTab` doubles as "which panel overlays the cell" — leaving it on
    // 'agents' would hide the very pane the tab just landed in.
    useStore.setState({ extraPanes: panes('s2'), focusedPaneIndex: 1, mainTab: 'agents' });
    useStore.getState().openAgentTab('s2', A1);
    expect(useStore.getState().mainTab).toBe('session');
    expect(useStore.getState().extraPanes[0].tab).toBe('agent:a1');
  });

  it('leaves a real pane-0 tab alone when it opens in another pane', () => {
    useStore.setState({ extraPanes: panes('s2'), focusedPaneIndex: 1, mainTab: 'diff' });
    useStore.getState().openAgentTab('s2', A1);
    expect(useStore.getState().mainTab).toBe('diff');
  });

  it('refuses to open in the GRID regime — a dense pane has no strip (FR-13)', () => {
    useStore.setState({ extraPanes: panes('s2', 's3'), focusedPaneIndex: 0 });
    const before = useStore.getState().agentTabs;
    useStore.getState().openAgentTab('s1', A1);
    expect(useStore.getState().agentTabs).toBe(before);
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('the panes hold independent tab sets (FR-1)', () => {
    useStore.setState({ extraPanes: panes('s2') });
    useStore.getState().openAgentTab('s1', A1);
    useStore.getState().openAgentTab('s2', A2);
    expect(idsFor('s1')).toEqual(['a1']);
    expect(idsFor('s2')).toEqual(['a2']);
    expect(useStore.getState().mainTab).toBe('agent:a1');
    expect(useStore.getState().extraPanes[0].tab).toBe('agent:a2');
  });

  it('closing the ACTIVE tab falls back to SESSION, an inactive one does not (FR-6)', () => {
    useStore.getState().openAgentTab('s1', A1);
    useStore.getState().openAgentTab('s1', A2); // a2 active
    useStore.getState().closeAgentTab('a1');
    expect(idsFor('s1')).toEqual(['a2']);
    expect(useStore.getState().mainTab).toBe('agent:a2');

    useStore.getState().closeAgentTab('a2');
    expect(idsFor('s1')).toEqual([]);
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('closing a tab leaves the OTHER pane alone (FR-6)', () => {
    useStore.setState({ extraPanes: panes('s2') });
    useStore.getState().openAgentTab('s1', A1);
    useStore.getState().openAgentTab('s2', A2);
    useStore.getState().closeAgentTab('a2');
    expect(useStore.getState().extraPanes[0].tab).toBe('session');
    expect(useStore.getState().mainTab).toBe('agent:a1'); // untouched
    expect(idsFor('s1')).toEqual(['a1']);
  });

  it('syncs an open tab from an agent.update without activating anything (FR-6)', () => {
    useStore.getState().openAgentTab('s1', A1);
    useStore.setState({ mainTab: 'diff' });
    useStore.getState().syncAgentTab({ id: 'a1', name: 'explorer', status: 'done' });
    expect(tabsForSession(useStore.getState().agentTabs, 's1')[0].status).toBe('done');
    expect(useStore.getState().mainTab).toBe('diff'); // never steals the pane
    // an update for an agent with no tab is a no-op, and keeps the SAME map —
    // this is the common case, several times a second per running agent.
    const before = useStore.getState().agentTabs;
    useStore.getState().syncAgentTab({ id: 'nope', name: 'x', status: 'running' });
    expect(useStore.getState().agentTabs).toBe(before);
    // so is an update that changes nothing
    useStore.getState().syncAgentTab({ id: 'a1', name: 'explorer', status: 'done' });
    expect(useStore.getState().agentTabs).toBe(before);
  });

  it('a session SWITCH keeps both sessions’ tabs and restores them on return (FR-8)', () => {
    useStore.getState().openAgentTab('s1', A1);

    // clicking the row of the session you are already on changes nothing
    useStore.getState().setActiveSessionId('s1');
    expect(idsFor('s1')).toEqual(['a1']);
    expect(useStore.getState().mainTab).toBe('agent:a1');

    // switching away moves PANE 0 off the tab but keeps s1's list
    useStore.getState().setActiveSessionId('s2');
    expect(idsFor('s1')).toEqual(['a1']);
    expect(idsFor('s2')).toEqual([]);
    expect(useStore.getState().mainTab).toBe('session');

    // s2 gets its own, and coming back to s1 finds a1 still there
    useStore.getState().openAgentTab('s2', A2);
    expect(useStore.getState().mainTab).toBe('agent:a2');
    useStore.getState().setActiveSessionId('s1');
    expect(idsFor('s1')).toEqual(['a1']);
    expect(idsFor('s2')).toEqual(['a2']);
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('a session switch leaves a built-in tab alone (FR-8)', () => {
    useStore.getState().openAgentTab('s1', A1);
    useStore.setState({ mainTab: 'diff' });
    useStore.getState().setActiveSessionId('s2');
    expect(idsFor('s1')).toEqual(['a1']);
    expect(useStore.getState().mainTab).toBe('diff');
  });

  it('a removed session takes its tabs with it (FR-9)', () => {
    useStore.getState().openAgentTab('s1', A1);
    useStore.getState().removeSession('s1');
    expect(idsFor('s1')).toEqual([]);
    expect(useStore.getState().agentTabs.size).toBe(0);
  });

  // workflow-details FR-11..FR-13: a run's tab rides the same per-session list.
  it('opens and activates a workflow tab under its own id (FR-11)', () => {
    useStore.getState().openAgentTab('s1', { id: 'w1', name: 'cohorte-cycle', status: 'running', kind: 'workflow' });
    expect(useStore.getState().mainTab).toBe('workflow:w1');
    useStore.getState().openAgentTab('s1', A1);
    expect(useStore.getState().mainTab).toBe('agent:a1');
    expect(idsFor('s1')).toEqual(['w1', 'a1']);
  });

  it('closes the active workflow tab back to SESSION (FR-12)', () => {
    useStore.getState().openAgentTab('s1', { id: 'w1', name: 'cohorte-cycle', status: 'running', kind: 'workflow' });
    useStore.getState().closeAgentTab('w1');
    expect(idsFor('s1')).toEqual([]);
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('clearAgentTabs empties every session and hands EVERY pane back (FR-7)', () => {
    useStore.setState({ extraPanes: panes('s2') });
    useStore.getState().openAgentTab('s1', A1);
    useStore.getState().openAgentTab('s2', { id: 'w1', name: 'cohorte-cycle', status: 'running', kind: 'workflow' });
    useStore.getState().clearAgentTabs();
    expect(useStore.getState().agentTabs.size).toBe(0);
    expect(useStore.getState().mainTab).toBe('session');
    expect(useStore.getState().extraPanes[0].tab).toBe('session');
  });

  it('clearAgentTabs is a no-op when nothing is open', () => {
    const before = useStore.getState().agentTabs;
    useStore.getState().clearAgentTabs();
    expect(useStore.getState().agentTabs).toBe(before);
    expect(useStore.getState().mainTab).toBe('session');
  });

  // fix-agent-view FR-21: a spawned agent puts its own chip in the strip.
  it('trackAgentTab records a chip without activating it or moving focus (FR-21)', () => {
    useStore.setState({ focusedPane: 'sidebar' });
    useStore.getState().trackAgentTab('s1', A1);
    expect(idsFor('s1')).toEqual(['a1']);
    expect(useStore.getState().mainTab).toBe('session'); // never steals the pane
    expect(useStore.getState().focusedPane).toBe('sidebar');

    // a second agent lands after the first, in spawn order
    useStore.getState().trackAgentTab('s1', A2);
    expect(idsFor('s1')).toEqual(['a1', 'a2']);
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('trackAgentTab refreshes an open tab in place and keeps the SAME map (FR-21)', () => {
    useStore.getState().trackAgentTab('s1', A1);
    const before = useStore.getState().agentTabs;
    useStore.getState().trackAgentTab('s1', A1);
    expect(useStore.getState().agentTabs).toBe(before);
    useStore.getState().trackAgentTab('s1', { ...A1, status: 'done' });
    expect(tabsForSession(useStore.getState().agentTabs, 's1')[0].status).toBe('done');
    expect(idsFor('s1')).toEqual(['a1']);
  });

  it('trackAgentTab records for a session on NO pane — the tab belongs to the session (FR-1/FR-21)', () => {
    useStore.getState().trackAgentTab('s9', A1);
    expect(idsFor('s9')).toEqual(['a1']);
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('trackAgentTab records in the GRID regime, where openAgentTab refuses (FR-13/FR-21)', () => {
    // FR-13 only bars a dense pane from SHOWING a dynamic tab; the chips are
    // still the session's, and shrinking back to two panes must find them.
    useStore.setState({ extraPanes: panes('s2', 's3') });
    useStore.getState().trackAgentTab('s1', A1);
    expect(idsFor('s1')).toEqual(['a1']);
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('an auto-tracked chip never evicts the tab a pane is showing (FR-21)', () => {
    useStore.getState().openAgentTab('s1', A1); // pane 0 is now reading a1
    for (let i = 2; i <= 7; i++) {
      useStore.getState().trackAgentTab('s1', { id: `a${i}`, name: `agent-${i}`, status: 'running' });
    }
    expect(useStore.getState().mainTab).toBe('agent:a1'); // still on it
    expect(idsFor('s1')).toContain('a1'); // …and its chip is still in the strip
    expect(idsFor('s1')).toEqual(['a1', 'a3', 'a4', 'a5', 'a6', 'a7']);
  });

  it('caps each session at 6 tabs independently (FR-2)', () => {
    useStore.setState({ extraPanes: panes('s2') });
    for (let i = 1; i <= 7; i++) {
      useStore.getState().openAgentTab('s1', { id: `a${i}`, name: `agent-${i}`, status: 'running' });
    }
    // the OLDEST went, never the one being activated
    expect(idsFor('s1')).toEqual(['a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
    expect(useStore.getState().mainTab).toBe('agent:a7');
    // and the other session is untouched by its neighbour's eviction
    useStore.getState().openAgentTab('s2', A1);
    expect(idsFor('s2')).toEqual(['a1']);
    expect(idsFor('s1')).toHaveLength(6);
  });
});
