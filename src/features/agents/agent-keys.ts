// agent-keys — pure key→action lookup for pane [3]'s keyboard nav
// (FR-12/13/19). Split out of AgentsPanel.tsx so the ArrowDown/ArrowUp/Enter/
// x-X decision table is unit-testable without the DOM; `useAgentsKeyboard`
// applies the resulting action's side effects.

import type { AgentInfo } from '../../../contract/common';

export type AgentKeyAction =
  | { kind: 'select'; id: string }
  | { kind: 'toggle'; id: string }
  | { kind: 'kill'; id: string }
  | { kind: 'none' };

export interface AgentKeyContext {
  list: AgentInfo[];
  selectedId: string | null;
  agents: Map<string, AgentInfo>;
  pendingKill: Set<string>;
}

type KeyHandler = (ctx: AgentKeyContext) => AgentKeyAction;

/** ArrowDown/ArrowUp: nothing selected (`cur < 0`) starts at the near edge, then clamps. */
function stepIndex(cur: number, delta: number, length: number): number {
  const base = cur < 0 ? 0 : cur + delta;
  return delta > 0 ? Math.min(base, length - 1) : Math.max(base, 0);
}

function moveAction(ctx: AgentKeyContext, delta: number): AgentKeyAction {
  const cur = ctx.list.findIndex((agent) => agent.id === ctx.selectedId);
  const agent = ctx.list[stepIndex(cur, delta, ctx.list.length)];
  return agent ? { kind: 'select', id: agent.id } : { kind: 'none' };
}

function toggleAction(ctx: AgentKeyContext): AgentKeyAction {
  return ctx.selectedId ? { kind: 'toggle', id: ctx.selectedId } : { kind: 'none' };
}

function killAction(ctx: AgentKeyContext): AgentKeyAction {
  const agent = ctx.agents.get(ctx.selectedId ?? '');
  return agent && agent.status === 'running' && !ctx.pendingKill.has(agent.id)
    ? { kind: 'kill', id: agent.id }
    : { kind: 'none' };
}

const KEY_ACTIONS: Record<string, KeyHandler> = {
  ArrowDown: (ctx) => moveAction(ctx, 1),
  ArrowUp: (ctx) => moveAction(ctx, -1),
  Enter: toggleAction,
  x: killAction,
  X: killAction,
};

/** FR-12/13/19: what pressing `key` should do, given the panel's current state. */
export function resolveAgentKeyAction(key: string, ctx: AgentKeyContext): AgentKeyAction {
  const handler = KEY_ACTIONS[key];
  return handler ? handler(ctx) : { kind: 'none' };
}
