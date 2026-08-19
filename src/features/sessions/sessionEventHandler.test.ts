import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo, SessionEvent, SessionMeta } from '../../../contract/common';
import { handleSessionEvent, type SessionEventContext } from './sessionEventHandler';

type MockContext = { [K in keyof SessionEventContext]: ReturnType<typeof vi.fn> };

function makeCtx(): MockContext {
  return {
    onMeta: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
    onUsage: vi.fn(),
    onAgentUpdate: vi.fn(),
    onRemoved: vi.fn(),
  };
}

function calledCount(ctx: MockContext): number {
  return Object.values(ctx).reduce((n, fn) => n + fn.mock.calls.length, 0);
}

const meta: SessionMeta = {
  id: 's1',
  name: 'session one',
  cwd: '/home/u/project',
  model: { id: 'm', label: 'Model' },
  status: 'running',
  contextUsedTokens: 0,
  contextLimitTokens: 100,
  startedAt: 0,
  lastActivityAt: 0,
  permissionMode: 'default',
  permissionModeSince: 0,
  runtime: 'native',
  accountId: 'default',
  agentRuntime: 'claude-code',
  protocol: 'anthropic',
};

const agent: AgentInfo = {
  id: 'a1',
  sessionId: 's1',
  name: 'test-writer',
  task: 'write tests',
  status: 'running',
  startedAt: 0,
  background: false,
  stepCount: 0,
};

describe('handleSessionEvent', () => {
  it('routes session.meta to onMeta with the meta', () => {
    const ctx = makeCtx();
    handleSessionEvent({ type: 'session.meta', meta }, ctx);
    expect(ctx.onMeta).toHaveBeenCalledWith(meta);
    expect(calledCount(ctx)).toBe(1);
  });

  it('routes session.status to onStatus', () => {
    const ctx = makeCtx();
    handleSessionEvent({ type: 'session.status', sessionId: 's1', status: 'idle' }, ctx);
    expect(ctx.onStatus).toHaveBeenCalledWith('s1', 'idle');
    expect(calledCount(ctx)).toBe(1);
  });

  it('routes session.error to onError with the message', () => {
    const ctx = makeCtx();
    handleSessionEvent(
      { type: 'session.error', sessionId: 's1', error: { code: 'INTERNAL', message: 'boom' } },
      ctx,
    );
    expect(ctx.onError).toHaveBeenCalledWith('s1', 'boom');
    expect(calledCount(ctx)).toBe(1);
  });

  it('routes context.usage to onUsage', () => {
    const ctx = makeCtx();
    handleSessionEvent({ type: 'context.usage', sessionId: 's1', usedTokens: 10, limitTokens: 200 }, ctx);
    expect(ctx.onUsage).toHaveBeenCalledWith('s1', 10, 200);
    expect(calledCount(ctx)).toBe(1);
  });

  it('routes agent.update to onAgentUpdate', () => {
    const ctx = makeCtx();
    handleSessionEvent({ type: 'agent.update', agent }, ctx);
    expect(ctx.onAgentUpdate).toHaveBeenCalledWith(agent);
    expect(calledCount(ctx)).toBe(1);
  });

  it('routes session.removed to onRemoved', () => {
    const ctx = makeCtx();
    handleSessionEvent({ type: 'session.removed', sessionId: 's1' }, ctx);
    expect(ctx.onRemoved).toHaveBeenCalledWith('s1');
    expect(calledCount(ctx)).toBe(1);
  });

  // Every event type the sidebar does not act on: no ctx callback fires.
  const ignored: SessionEvent[] = [
    { type: 'message.user', sessionId: 's1', blockId: 'b1', text: 'hi' },
    { type: 'assistant.delta', sessionId: 's1', blockId: 'b1', text: 'hi', offset: 0 },
    { type: 'assistant.done', sessionId: 's1', blockId: 'b1', text: 'hi' },
    { type: 'tool.start', sessionId: 's1', blockId: 'b1', tool: 'Read', summary: 'x' },
    { type: 'tool.done', sessionId: 's1', blockId: 'b1', meta: '1 line' },
    { type: 'command.started', sessionId: 's1', blockId: 'b1', command: '/x' },
    { type: 'command.output', sessionId: 's1', blockId: 'b1', card: { kind: 'notice', text: 'x' } },
    { type: 'question.asked', sessionId: 's1', blockId: 'b1', questions: [] },
    { type: 'question.resolved', sessionId: 's1', blockId: 'b1', state: 'answered' },
    {
      type: 'permission.asked',
      sessionId: 's1',
      blockId: 'b1',
      ask: { toolName: 'Bash', summary: 'x', inputJson: '{}', cwd: '/', pattern: 'Bash(*)', patternLabel: 'any bash' },
    },
    { type: 'permission.resolved', sessionId: 's1', blockId: 'b1', state: 'allowed' },
    { type: 'session.commands', sessionId: 's1', commands: [] },
    { type: 'agent.step', sessionId: 's1', agentId: 'a1', step: { seq: 1, kind: 'tool', at: 0, label: 'x' } },
    { type: 'mcp.update', sessionId: 's1', server: { name: 'srv', scope: 'project', status: 'connected' } },
    { type: 'session.resumeFailed', sessionId: 's1' },
    { type: 'session.cleared', sessionId: 's1' },
  ];

  it.each(ignored)('does not call any ctx callback for $type', (e) => {
    const ctx = makeCtx();
    handleSessionEvent(e, ctx);
    expect(calledCount(ctx)).toBe(0);
  });
});
