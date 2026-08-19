// design 12b: the roster's live per-row signals — activity line, turn clock,
// and the parked ask a WAITING row answers inline.

import { beforeEach, describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../../contract/common';
import type { RosterAsk } from './rosterStore';
import { useStore } from './store';

function ask(pattern: string): RosterAsk {
  const payload: PermissionAsk = {
    toolName: 'Bash',
    summary: 'git push --force',
    inputJson: '{}',
    cwd: '/repo',
    pattern,
    patternLabel: 'git push (any arguments)',
  };
  return { blockId: `blk-${pattern}`, ask: payload };
}

beforeEach(() => {
  useStore.setState({
    sessionActivity: new Map(),
    runningSince: new Map(),
    pendingAsk: new Map(),
  });
});

describe('roster slice', () => {
  it('sets, replaces and clears the activity line', () => {
    useStore.getState().setSessionActivity('s1', 'editing UsageBar.tsx');
    expect(useStore.getState().sessionActivity.get('s1')).toBe('editing UsageBar.tsx');
    useStore.getState().setSessionActivity('s1', 'running npm test');
    expect(useStore.getState().sessionActivity.get('s1')).toBe('running npm test');
    useStore.getState().setSessionActivity('s1', null);
    expect(useStore.getState().sessionActivity.has('s1')).toBe(false);
  });

  it('keeps the SAME map reference when nothing changed', () => {
    useStore.getState().setSessionActivity('s1', 'reading a.ts');
    const before = useStore.getState().sessionActivity;
    useStore.getState().setSessionActivity('s1', 'reading a.ts'); // same value
    expect(useStore.getState().sessionActivity).toBe(before);
    useStore.getState().setSessionActivity('s2', null); // clearing an absent id
    expect(useStore.getState().sessionActivity).toBe(before);
  });

  it('holds the turn start per session', () => {
    useStore.getState().markRunningSince('s1', 1_000);
    expect(useStore.getState().runningSince.get('s1')).toBe(1_000);
    useStore.getState().markRunningSince('s1', null);
    expect(useStore.getState().runningSince.has('s1')).toBe(false);
  });

  it('replaces a pending ask only when the BLOCK changes', () => {
    useStore.getState().setPendingAsk('s1', ask('Bash(git push:*)'));
    const before = useStore.getState().pendingAsk;
    useStore.getState().setPendingAsk('s1', ask('Bash(git push:*)')); // same blockId
    expect(useStore.getState().pendingAsk).toBe(before);
    useStore.getState().setPendingAsk('s1', ask('Bash(rm:*)'));
    expect(useStore.getState().pendingAsk.get('s1')?.blockId).toBe('blk-Bash(rm:*)');
  });

  it('clearRosterSignals drops all three at once', () => {
    useStore.getState().setSessionActivity('s1', 'editing a.ts');
    useStore.getState().markRunningSince('s1', 5);
    useStore.getState().setPendingAsk('s1', ask('Bash(ls:*)'));
    useStore.getState().setSessionActivity('s2', 'reading b.ts');

    useStore.getState().clearRosterSignals('s1');

    expect(useStore.getState().sessionActivity.has('s1')).toBe(false);
    expect(useStore.getState().runningSince.has('s1')).toBe(false);
    expect(useStore.getState().pendingAsk.has('s1')).toBe(false);
    // …and leaves every other session alone.
    expect(useStore.getState().sessionActivity.get('s2')).toBe('reading b.ts');
  });

  it('clearRosterSignals on an unknown session is a no-op', () => {
    const activity = useStore.getState().sessionActivity;
    useStore.getState().clearRosterSignals('nobody');
    expect(useStore.getState().sessionActivity).toBe(activity);
  });
});
