import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../contract/common';
import { resolveAgentKeyAction, type AgentKeyContext } from './agent-keys';

const agent = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  sessionId: 's1',
  name: `agent-${id}`,
  task: 'do the thing',
  status: 'running',
  startedAt: 1_700_000_000_000,
  background: false,
  stepCount: 0,
  ...over,
});

const ctx = (over: Partial<AgentKeyContext> = {}): AgentKeyContext => ({
  list: [],
  selectedId: null,
  agents: new Map(),
  pendingKill: new Set(),
  ...over,
});

describe('resolveAgentKeyAction — ArrowDown/ArrowUp', () => {
  const list = [agent('a'), agent('b'), agent('c')];

  it('selects the first item when nothing is selected', () => {
    expect(resolveAgentKeyAction('ArrowDown', ctx({ list }))).toEqual({ kind: 'select', id: 'a' });
    expect(resolveAgentKeyAction('ArrowUp', ctx({ list }))).toEqual({ kind: 'select', id: 'a' });
  });

  it('moves down to the next item', () => {
    expect(resolveAgentKeyAction('ArrowDown', ctx({ list, selectedId: 'a' }))).toEqual({ kind: 'select', id: 'b' });
  });

  it('clamps at the bottom of the list', () => {
    expect(resolveAgentKeyAction('ArrowDown', ctx({ list, selectedId: 'c' }))).toEqual({ kind: 'select', id: 'c' });
  });

  it('moves up to the previous item', () => {
    expect(resolveAgentKeyAction('ArrowUp', ctx({ list, selectedId: 'c' }))).toEqual({ kind: 'select', id: 'b' });
  });

  it('clamps at the top of the list', () => {
    expect(resolveAgentKeyAction('ArrowUp', ctx({ list, selectedId: 'a' }))).toEqual({ kind: 'select', id: 'a' });
  });

  it('produces no action on an empty list', () => {
    expect(resolveAgentKeyAction('ArrowDown', ctx())).toEqual({ kind: 'none' });
    expect(resolveAgentKeyAction('ArrowUp', ctx())).toEqual({ kind: 'none' });
  });

  it('a selectedId absent from the list is treated like nothing selected', () => {
    expect(resolveAgentKeyAction('ArrowDown', ctx({ list, selectedId: 'ghost' }))).toEqual({ kind: 'select', id: 'a' });
  });
});

describe('resolveAgentKeyAction — Enter', () => {
  it('toggles the selected agent', () => {
    expect(resolveAgentKeyAction('Enter', ctx({ selectedId: 'a' }))).toEqual({ kind: 'toggle', id: 'a' });
  });

  it('does nothing with no selection', () => {
    expect(resolveAgentKeyAction('Enter', ctx())).toEqual({ kind: 'none' });
  });
});

describe('resolveAgentKeyAction — x/X (kill)', () => {
  it('kills a running, non-pending selected agent', () => {
    const a = agent('a', { status: 'running' });
    const context = ctx({ selectedId: 'a', agents: new Map([['a', a]]) });
    expect(resolveAgentKeyAction('x', context)).toEqual({ kind: 'kill', id: 'a' });
    expect(resolveAgentKeyAction('X', context)).toEqual({ kind: 'kill', id: 'a' });
  });

  it('does nothing when the selected agent is not running', () => {
    const a = agent('a', { status: 'idle' });
    const context = ctx({ selectedId: 'a', agents: new Map([['a', a]]) });
    expect(resolveAgentKeyAction('x', context)).toEqual({ kind: 'none' });
  });

  it('does nothing when a kill is already pending', () => {
    const a = agent('a', { status: 'running' });
    const context = ctx({ selectedId: 'a', agents: new Map([['a', a]]), pendingKill: new Set(['a']) });
    expect(resolveAgentKeyAction('x', context)).toEqual({ kind: 'none' });
  });

  it('does nothing with no selection', () => {
    expect(resolveAgentKeyAction('x', ctx())).toEqual({ kind: 'none' });
  });
});

describe('resolveAgentKeyAction — unmapped keys', () => {
  it('returns none for a key with no handler', () => {
    expect(resolveAgentKeyAction('Tab', ctx({ selectedId: 'a' }))).toEqual({ kind: 'none' });
  });
});
