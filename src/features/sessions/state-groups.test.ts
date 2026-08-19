import { describe, expect, it } from 'vitest';
import type { SessionMeta, SessionStatus } from '../../../contract/common';
import { SESSION_STATUSES, STATUS_COLOR } from '../../../contract/fleet-board';
import {
  COLLAPSED_STATES_KEY,
  DEFAULT_COLLAPSED_STATES,
  flattenStateGroups,
  groupSessionsByState,
  parseCollapsedStates,
  persistCollapsedStates,
  STATE_ORDER,
  STATE_STATUS,
  stateGroupKey,
  stateOf,
  type SessionState,
} from './state-groups';

function session(over: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    name: over.id,
    cwd: '/tmp/repo',
    model: { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    ...over,
  } as SessionMeta;
}

describe('stateOf', () => {
  it('routes every SessionStatus to a bucket', () => {
    for (const status of SESSION_STATUSES) {
      expect(STATE_ORDER).toContain(stateOf(status));
    }
  });

  it('puts both parked states AND error in the attention bucket', () => {
    expect(stateOf('awaiting_approval')).toBe('attention');
    expect(stateOf('awaiting_input')).toBe('attention');
    expect(stateOf('error')).toBe('attention');
  });

  it('treats starting as running, and done as archived', () => {
    expect(stateOf('starting')).toBe('running');
    expect(stateOf('running')).toBe('running');
    expect(stateOf('idle')).toBe('idle');
    expect(stateOf('done')).toBe('archived');
  });
});

describe('STATE_STATUS', () => {
  it('names a status the contract has a colour for, for every state', () => {
    for (const state of STATE_ORDER) {
      const status: SessionStatus = STATE_STATUS[state];
      expect(STATUS_COLOR[status]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('maps each state onto a status that falls back into it', () => {
    for (const state of STATE_ORDER) {
      expect(stateOf(STATE_STATUS[state])).toBe(state);
    }
  });
});

describe('groupSessionsByState', () => {
  it('emits groups in STATE_ORDER whatever the session order', () => {
    const nodes = groupSessionsByState([
      session({ id: 'a', status: 'idle' }),
      session({ id: 'b', status: 'awaiting_approval' }),
      session({ id: 'c', status: 'running' }),
      session({ id: 'd', status: 'done' }),
    ]);
    expect(nodes.map((n) => n.state)).toEqual(['attention', 'running', 'idle', 'archived']);
  });

  it('drops empty groups entirely', () => {
    const nodes = groupSessionsByState([session({ id: 'a', status: 'idle' })]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].key).toBe(stateGroupKey('idle'));
  });

  it('keeps incoming order inside a bucket', () => {
    const nodes = groupSessionsByState([
      session({ id: 'a', status: 'idle' }),
      session({ id: 'b', status: 'running' }),
      session({ id: 'c', status: 'idle' }),
    ]);
    const idle = nodes.find((n) => n.state === 'idle')!;
    expect(idle.sessions.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('returns nothing for an empty fleet', () => {
    expect(groupSessionsByState([])).toEqual([]);
  });
});

describe('flattenStateGroups', () => {
  const nodes = groupSessionsByState([
    session({ id: 'blocked', status: 'awaiting_input' }),
    session({ id: 'live', status: 'running' }),
    session({ id: 'old', status: 'done' }),
  ]);

  it('walks the painted order', () => {
    expect(flattenStateGroups(nodes).map((s) => s.id)).toEqual(['blocked', 'live', 'old']);
  });

  it('skips a collapsed group so its rows cannot take the cursor', () => {
    const collapsed = new Set([stateGroupKey('archived')]);
    expect(flattenStateGroups(nodes, collapsed).map((s) => s.id)).toEqual(['blocked', 'live']);
  });
});

describe('parseCollapsedStates', () => {
  it('defaults ARCHIVED collapsed when nothing has been persisted', () => {
    expect([...parseCollapsedStates(null)]).toEqual([...DEFAULT_COLLAPSED_STATES]);
  });

  it('takes a persisted record verbatim, including an empty one', () => {
    expect([...parseCollapsedStates('[]')]).toEqual([]);
    expect([...parseCollapsedStates('["state:idle"]')]).toEqual(['state:idle']);
  });

  it('degrades malformed input to the default', () => {
    expect([...parseCollapsedStates('not json')]).toEqual([...DEFAULT_COLLAPSED_STATES]);
    expect([...parseCollapsedStates('{"a":1}')]).toEqual([...DEFAULT_COLLAPSED_STATES]);
  });

  it('drops non-string members', () => {
    expect([...parseCollapsedStates('["state:idle",7,null]')]).toEqual(['state:idle']);
  });

  it('reads back what persistCollapsedStates would have written', () => {
    const keys: SessionState[] = ['idle', 'archived'];
    const written = JSON.stringify([...new Set(keys.map(stateGroupKey))]);
    expect([...parseCollapsedStates(written)]).toEqual(['state:idle', 'state:archived']);
  });

  it('persistCollapsedStates never throws without a localStorage', () => {
    expect(() => persistCollapsedStates(new Set(['state:idle']))).not.toThrow();
    expect(COLLAPSED_STATES_KEY).toBe('francois.collapsedStateGroups');
  });
});
