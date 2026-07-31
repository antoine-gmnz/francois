// Sidebar pane [1]'s SessionEvent router (fleet-board FR-2..7, overview feed).
// A plain `switch` over the SessionEvent tagged union so the compiler enforces
// exhaustiveness: every member of the union must appear in a `case` (handled
// or explicitly ignored) or the `default` branch's `never` narrowing fails to
// compile — adding a new SessionEvent variant without updating this switch is
// a build error, not a silently-dropped branch.
//
// Side effects are fully delegated to `ctx` so this stays pure/testable: the
// switch only decides WHICH callback fires for which event, never how the
// store is touched.

import type { AgentInfo, SessionEvent, SessionId, SessionStatus } from '../../../contract/common';

export interface SessionEventContext {
  onMeta: (meta: Extract<SessionEvent, { type: 'session.meta' }>['meta']) => void;
  onStatus: (sessionId: SessionId, status: SessionStatus) => void;
  onError: (sessionId: SessionId, message: string) => void;
  onUsage: (sessionId: SessionId, usedTokens: number, limitTokens: number) => void;
  onAgentUpdate: (agent: AgentInfo) => void;
  onRemoved: (sessionId: SessionId) => void;
}

/** Routes one SessionEvent to its `ctx` callback. Unhandled types are a documented no-op. */
export function handleSessionEvent(e: SessionEvent, ctx: SessionEventContext): void {
  switch (e.type) {
    case 'session.meta':
      ctx.onMeta(e.meta);
      break;
    case 'session.status':
      ctx.onStatus(e.sessionId, e.status);
      break;
    case 'session.error':
      ctx.onError(e.sessionId, e.error.message);
      break;
    case 'context.usage':
      ctx.onUsage(e.sessionId, e.usedTokens, e.limitTokens);
      break;
    case 'agent.update':
      ctx.onAgentUpdate(e.agent);
      break;
    case 'session.removed':
      ctx.onRemoved(e.sessionId);
      break;
    // Not sidebar-relevant — listed explicitly (rather than a catch-all) so a
    // new SessionEvent member fails the `default` exhaustiveness check below
    // instead of silently landing here.
    case 'message.user':
    case 'assistant.delta':
    case 'assistant.done':
    case 'tool.start':
    case 'tool.done':
    case 'command.started':
    case 'command.output':
    case 'question.asked':
    case 'question.resolved':
    case 'permission.asked':
    case 'permission.resolved':
    case 'session.commands':
    case 'agent.step':
    case 'mcp.update':
    case 'workflow.update':
    case 'session.resumeFailed':
    case 'session.cleared':
      break;
    default: {
      const exhaustive: never = e;
      return exhaustive;
    }
  }
}
