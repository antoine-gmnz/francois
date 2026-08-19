// split-session §Right column: the counts the folded 46px rail badges. Each
// right-column panel publishes its own header count here (it is the only mount
// that holds it), keyed by session so the rail can stay focused-session scoped.

import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../contract/common';
import { EMPTY_PANEL_COUNTS } from './panelCountsStore';
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
    permissionModeSince: 0,
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
  };
}

beforeEach(() => {
  useStore.setState({ sessions: [meta('s1'), meta('s2')], panelCounts: new Map() });
});

describe('panelCounts slice', () => {
  it('starts empty and reads back per session and pane', () => {
    expect(useStore.getState().panelCounts.size).toBe(0);
    useStore.getState().setPanelCount('s1', 'mcp', 3);
    useStore.getState().setPanelCount('s1', 'skills', 12);
    useStore.getState().setPanelCount('s2', 'workflows', 1);
    expect(useStore.getState().panelCounts.get('s1')).toEqual({ ...EMPTY_PANEL_COUNTS, mcp: 3, skills: 12 });
    expect(useStore.getState().panelCounts.get('s2')).toEqual({ ...EMPTY_PANEL_COUNTS, workflows: 1 });
  });

  it('bails on a no-op write so the rail never re-renders for an unchanged count', () => {
    useStore.getState().setPanelCount('s1', 'agents', 2);
    const first = useStore.getState().panelCounts;
    useStore.getState().setPanelCount('s1', 'agents', 2);
    expect(useStore.getState().panelCounts).toBe(first);
    useStore.getState().setPanelCount('s1', 'agents', 3);
    expect(useStore.getState().panelCounts).not.toBe(first);
  });

  it('ignores a late count for a session no longer cached (fleet-board FR-7 rule)', () => {
    useStore.getState().setPanelCount('gone', 'mcp', 4);
    expect(useStore.getState().panelCounts.has('gone')).toBe(false);
  });

  it('drops a removed session’s counts, and is a no-op for an unknown id', () => {
    useStore.getState().setPanelCount('s1', 'mcp', 3);
    const before = useStore.getState().panelCounts;
    useStore.getState().dropPanelCounts('s2');
    expect(useStore.getState().panelCounts).toBe(before); // untouched
    useStore.getState().dropPanelCounts('s1');
    expect(useStore.getState().panelCounts.has('s1')).toBe(false);
  });
});
