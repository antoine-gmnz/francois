// useAgentsKeyboard — pane [3]'s keyboard nav (FR-12/13/19), split out of
// AgentsPanel.tsx. The key→action decision is the pure, tested
// `resolveAgentKeyAction` (agent-keys.ts); this hook only wires it to the DOM
// and applies the resulting action's side effects.

import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { AgentInfo } from '../../../contract/common';
import { resolveAgentKeyAction, type AgentKeyAction } from './agent-keys';
import { collapseTrail, type TrailState } from './agent-trail';

export interface UseAgentsKeyboardOptions {
  focused: boolean;
  newAgentOpen: boolean;
  list: AgentInfo[];
  selectedId: string | null;
  agents: Map<string, AgentInfo>;
  pendingKill: Set<string>;
  /**
   * Read only to trigger a resubscribe when it changes. `onToggleExpand`
   * closes over the latest `trail` and is recreated every render, so it can't
   * itself be a dependency without resubscribing on every unrelated render
   * (e.g. the elapsed-clock tick) — mirrors the original single effect's dep
   * list, which included `trail` for the same reason.
   */
  trail: TrailState;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setTrail: Dispatch<SetStateAction<TrailState>>;
  onToggleExpand: (agentId: string) => void;
  onKill: (agentId: string) => void;
}

function applyAgentKeyAction(
  action: AgentKeyAction,
  options: Pick<UseAgentsKeyboardOptions, 'setSelectedId' | 'setTrail' | 'onToggleExpand' | 'onKill'>,
): void {
  const { setSelectedId, setTrail, onToggleExpand, onKill } = options;
  switch (action.kind) {
    case 'select':
      setSelectedId(action.id);
      setTrail(collapseTrail);
      break;
    case 'toggle':
      onToggleExpand(action.id);
      break;
    case 'kill':
      onKill(action.id);
      break;
    case 'none':
      break;
  }
}

/** Keyboard for pane [3] (FR-12/13/19). */
export function useAgentsKeyboard(options: UseAgentsKeyboardOptions): void {
  const { focused, newAgentOpen, list, selectedId, agents, pendingKill, trail, setSelectedId, setTrail, onToggleExpand, onKill } =
    options;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (newAgentOpen || !focused) return;
      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.preventDefault();
      const action = resolveAgentKeyAction(e.key, { list, selectedId, agents, pendingKill });
      if (action.kind === 'toggle') e.preventDefault();
      applyAgentKeyAction(action, { setSelectedId, setTrail, onToggleExpand, onKill });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, newAgentOpen, list, selectedId, agents, pendingKill, trail]);
}
